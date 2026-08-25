"""Middleware ASGI d'anonymisation PieceMaker autour du proxy LiteLLM.

Les routes d'administration restent celles de LiteLLM. Seuls les appels de
génération LLM sont interceptés : champs textuels codés dans la requête, puis
ré-identification du JSON, du SSE ou du NDJSON renvoyé au client.
"""

import codecs
import json
import logging
import os
from typing import Any, Callable, List, Optional

from .mapping import MappingCache
from .substitution import anonymize_text, deanonymize_text

logger = logging.getLogger('piecemaker_pii.asgi')

# Clés dont la valeur est du contenu adressé au modèle. Entrer dans une de ces
# valeurs transforme toutes les chaînes qu'elle contient, y compris les objets
# d'arguments d'outil et les tableaux multimodaux.
ANONYMIZE_KEYS = {
    'arguments',
    'content',
    'contents',
    'input',
    'instructions',
    'messages',
    'parts',
    'prompt',
    'system',
    'text',
}

PATHS_TO_PROCESS = {
    '/anthropic/v1/messages',
    '/chat/completions',
    '/completions',
    '/openai/v1/chat/completions',
    '/openai/v1/responses',
    '/responses',
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/messages',
    '/v1/responses',
}


def _walk_all_strings(obj: Any, mapping: dict) -> Any:
    if isinstance(obj, str):
        return anonymize_text(obj, mapping)
    if isinstance(obj, list):
        return [_walk_all_strings(item, mapping) for item in obj]
    if isinstance(obj, dict):
        return {key: _walk_all_strings(value, mapping) for key, value in obj.items()}
    return obj


def _walk_anonymize(obj: Any, mapping: dict) -> Any:
    """Code uniquement les sous-arbres textuels connus d'une requête LLM."""
    if isinstance(obj, str):
        return anonymize_text(obj, mapping)
    if isinstance(obj, list):
        return [_walk_anonymize(item, mapping) for item in obj]
    if isinstance(obj, dict):
        return {
            key: _walk_all_strings(value, mapping) if key in ANONYMIZE_KEYS else value
            for key, value in obj.items()
        }
    return obj


def _walk_deanonymize(obj: Any, reverse: dict) -> Any:
    """Ré-identifie toute chaîne de la réponse contenant un code PieceMaker."""
    if isinstance(obj, str):
        return deanonymize_text(obj, reverse)
    if isinstance(obj, list):
        return [_walk_deanonymize(item, reverse) for item in obj]
    if isinstance(obj, dict):
        return {key: _walk_deanonymize(value, reverse) for key, value in obj.items()}
    return obj


def _is_generation_path(path: str) -> bool:
    if path in PATHS_TO_PROCESS:
        return True
    return (
        path.startswith('/gemini/')
        and ('generateContent' in path or 'streamGenerateContent' in path)
    )


class StreamDeanonymizer:
    """Buffer de flux : ne coupe jamais un code PieceMaker entre deux chunks."""

    def __init__(self, reverse_mapping: dict):
        self.reverse = reverse_mapping
        self.codes = sorted(reverse_mapping, key=len, reverse=True)
        self.max_code_len = max((len(code) for code in self.codes), default=0)
        self.buffer = ''

    def feed(self, text: str) -> str:
        self.buffer += text
        if self.max_code_len == 0:
            output, self.buffer = self.buffer, ''
            return output
        if len(self.buffer) <= self.max_code_len * 2:
            return ''

        # Conserver au minimum la longueur du plus grand code. Si la frontière
        # calculée tombe dans un code déjà complet, la reculer à son début.
        emit_end = len(self.buffer) - self.max_code_len
        window_start = max(0, emit_end - self.max_code_len + 1)
        for code in self.codes:
            start = self.buffer.rfind(code, window_start, emit_end + len(code))
            if start >= 0 and start < emit_end < start + len(code):
                emit_end = start

        to_emit = self.buffer[:emit_end]
        self.buffer = self.buffer[emit_end:]
        return deanonymize_text(to_emit, self.reverse)

    def flush(self) -> str:
        if not self.buffer:
            return ''
        result = deanonymize_text(self.buffer, self.reverse)
        self.buffer = ''
        return result


class PIIMiddleware:
    """Middleware ASGI pur, compatible avec les réponses LiteLLM en streaming."""

    def __init__(self, app: Any, mapping_path: Optional[str] = None):
        self.app = app
        path = mapping_path or os.environ.get('PIECEMAKER_MAPPING_PATH')
        self.cache = MappingCache(path)
        logger.info('PIIMiddleware initialise — %d entites', self.cache.entity_count)

    async def __call__(self, scope: dict, receive: Callable, send: Callable):
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return

        path = scope.get('path', '')
        if scope.get('method', 'GET') != 'POST' or not _is_generation_path(path):
            await self.app(scope, receive, send)
            return

        self.cache.refresh_if_needed()
        if self.cache.entity_count == 0:
            await self._reject_missing_mapping(send)
            return

        body_parts: List[bytes] = []
        while True:
            message = await receive()
            body_parts.append(message.get('body', b''))
            if not message.get('more_body', False):
                break

        raw_body = b''.join(body_parts)
        try:
            body_dict = json.loads(raw_body)
            anonymized = _walk_anonymize(body_dict, self.cache.mapping)
            modified_body = json.dumps(anonymized, ensure_ascii=False).encode('utf-8')
            logger.info('pii_request_anonymized entities=%d', self.cache.entity_count)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            modified_body = raw_body

        new_headers = []
        for key, value in scope.get('headers', []):
            header_name = key if isinstance(key, str) else key.decode('latin-1')
            if header_name.lower() == 'content-length':
                new_length = str(len(modified_body))
                new_headers.append((
                    key,
                    new_length.encode('latin-1') if isinstance(value, bytes) else new_length,
                ))
            else:
                new_headers.append((key, value))
        downstream_scope = dict(scope, headers=new_headers)

        body_sent = False

        async def anonymized_receive():
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {'type': 'http.request', 'body': modified_body, 'more_body': False}
            return {'type': 'http.disconnect'}

        is_streaming = False
        deanonymizer: Optional[StreamDeanonymizer] = None
        stream_decoder = None
        response_parts: List[bytes] = []

        async def deanonymized_send(message: dict):
            nonlocal is_streaming, deanonymizer, stream_decoder

            if message['type'] == 'http.response.start':
                headers = message.get('headers', [])
                content_type = ''
                filtered_headers = []
                for key, value in headers:
                    header_name = key.decode('latin-1') if isinstance(key, bytes) else key
                    header_value = value.decode('latin-1') if isinstance(value, bytes) else value
                    if header_name.lower() == 'content-type':
                        content_type = header_value
                    if header_name.lower() != 'content-length':
                        filtered_headers.append((key, value))

                is_streaming = (
                    'text/event-stream' in content_type
                    or 'application/x-ndjson' in content_type
                )
                if is_streaming:
                    # Le remplacement porte sur du JSON sérialisé : échapper les
                    # noms comme le contenu d'une chaîne JSON préserve le protocole.
                    json_safe_reverse = {
                        code: [json.dumps(variants[0], ensure_ascii=False)[1:-1]]
                        for code, variants in self.cache.reverse_mapping.items()
                        if variants
                    }
                    deanonymizer = StreamDeanonymizer(json_safe_reverse)
                    stream_decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')

                await send(dict(message, headers=filtered_headers))
                return

            if message['type'] != 'http.response.body':
                await send(message)
                return

            body = message.get('body', b'')
            more_body = message.get('more_body', False)
            if is_streaming and deanonymizer and stream_decoder:
                decoded = stream_decoder.decode(body, final=not more_body)
                modified = deanonymizer.feed(decoded)
                if not more_body:
                    modified += deanonymizer.flush()
                await send({
                    'type': 'http.response.body',
                    'body': modified.encode('utf-8'),
                    'more_body': more_body,
                })
                return

            response_parts.append(body)
            if not more_body:
                await send({
                    'type': 'http.response.body',
                    'body': self._deanonymize_json(b''.join(response_parts)),
                    'more_body': False,
                })

        await self.app(downstream_scope, anonymized_receive, deanonymized_send)

    async def _reject_missing_mapping(self, send: Callable) -> None:
        payload = json.dumps({
            'error': {
                'message': 'Mapping central PieceMaker absent ou vide ; requete LLM bloquee.',
                'type': 'piecemaker_mapping_error',
                'code': 503,
            }
        }, ensure_ascii=False).encode('utf-8')
        await send({
            'type': 'http.response.start',
            'status': 503,
            'headers': [
                (b'content-type', b'application/json; charset=utf-8'),
                (b'content-length', str(len(payload)).encode('ascii')),
            ],
        })
        await send({'type': 'http.response.body', 'body': payload, 'more_body': False})

    def _deanonymize_json(self, raw: bytes) -> bytes:
        try:
            obj = json.loads(raw)
            modified = _walk_deanonymize(obj, self.cache.reverse_mapping)
            return json.dumps(modified, ensure_ascii=False).encode('utf-8')
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            return raw
