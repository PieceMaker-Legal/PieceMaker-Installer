"""Middleware ASGI d'anonymisation PieceMaker autour du proxy LiteLLM.

Les routes d'administration restent celles de LiteLLM. Seuls les appels de
génération LLM sont interceptés : champs textuels codés dans la requête, puis
ré-identification du JSON, du SSE ou du NDJSON renvoyé au client.
"""

import codecs
import json
import logging
import os
import time
from typing import Any, Callable, List, Optional

from .mapping import MappingCache
from .substitution import anonymize_text, anonymize_text_with_matches, deanonymize_text

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
    '/anthropic/v1/messages/count_tokens',
    '/chat/completions',
    '/chatgpt/responses',
    '/chatgpt/responses/compact',
    '/completions',
    '/openai/v1/chat/completions',
    '/openai/v1/responses',
    '/responses',
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/messages',
    '/v1/messages/count_tokens',
    '/v1/responses',
}


def _walk_all_strings(
    obj: Any,
    mapping: dict,
    observed_reverse: Optional[dict] = None,
) -> Any:
    if isinstance(obj, str):
        if observed_reverse is not None:
            transformed, observed = anonymize_text_with_matches(obj, mapping)
            for code, entity in observed.items():
                observed_reverse.setdefault(code, [entity])
            return transformed
        return anonymize_text(obj, mapping)
    if isinstance(obj, list):
        return [_walk_all_strings(item, mapping, observed_reverse) for item in obj]
    if isinstance(obj, dict):
        return {
            key: _walk_all_strings(value, mapping, observed_reverse)
            for key, value in obj.items()
        }
    return obj


def _walk_anonymize(
    obj: Any,
    mapping: dict,
    observed_reverse: Optional[dict] = None,
) -> Any:
    """Code uniquement les sous-arbres textuels connus d'une requête LLM."""
    if isinstance(obj, str):
        if observed_reverse is not None:
            transformed, observed = anonymize_text_with_matches(obj, mapping)
            for code, entity in observed.items():
                observed_reverse.setdefault(code, [entity])
            return transformed
        return anonymize_text(obj, mapping)
    if isinstance(obj, list):
        return [_walk_anonymize(item, mapping, observed_reverse) for item in obj]
    if isinstance(obj, dict):
        return {
            key: _walk_all_strings(value, mapping, observed_reverse)
            if key in ANONYMIZE_KEYS else value
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
        path = scope.get('path', '')
        if scope['type'] == 'websocket':
            if _is_generation_path(path):
                await self._handle_websocket(path, receive, send, scope)
            else:
                await self.app(scope, receive, send)
            return

        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return

        if scope.get('method', 'GET') != 'POST' or not _is_generation_path(path):
            await self.app(scope, receive, send)
            return

        request_started_at = time.perf_counter()
        refresh_started_at = time.perf_counter()
        self.cache.refresh_if_needed()
        refresh_ms = (time.perf_counter() - refresh_started_at) * 1000
        if self.cache.entity_count == 0:
            await self._reject_missing_mapping(send)
            return

        read_started_at = time.perf_counter()
        body_parts: List[bytes] = []
        while True:
            message = await receive()
            body_parts.append(message.get('body', b''))
            if not message.get('more_body', False):
                break

        raw_body = b''.join(body_parts)
        read_ms = (time.perf_counter() - read_started_at) * 1000
        json_load_ms = 0.0
        anonymize_ms = 0.0
        json_dump_ms = 0.0
        request_json = False
        try:
            operation_started_at = time.perf_counter()
            body_dict = json.loads(raw_body)
            json_load_ms = (time.perf_counter() - operation_started_at) * 1000

            operation_started_at = time.perf_counter()
            anonymized = _walk_anonymize(body_dict, self.cache.mapping)
            anonymize_ms = (time.perf_counter() - operation_started_at) * 1000

            operation_started_at = time.perf_counter()
            modified_body = json.dumps(anonymized, ensure_ascii=False).encode('utf-8')
            json_dump_ms = (time.perf_counter() - operation_started_at) * 1000
            request_json = True
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            modified_body = raw_body

        request_ready_at = time.perf_counter()
        request_prepare_ms = (request_ready_at - request_started_at) * 1000
        logger.info(
            'pii_request_metrics path=%s request_bytes=%d modified_bytes=%d '
            'entities=%d json=%s refresh_ms=%.3f read_ms=%.3f json_load_ms=%.3f '
            'anonymize_ms=%.3f json_dump_ms=%.3f prepare_ms=%.3f',
            path,
            len(raw_body),
            len(modified_body),
            self.cache.entity_count,
            str(request_json).lower(),
            refresh_ms,
            read_ms,
            json_load_ms,
            anonymize_ms,
            json_dump_ms,
            request_prepare_ms,
        )

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
            # Après avoir rejoué le corps modifié, conserver le vrai canal de
            # réception. Les réponses streaming (Starlette/LiteLLM) l'écoutent
            # en parallèle pour détecter la déconnexion du client. Renvoyer un
            # disconnect synthétique ici annule chaque flux juste après son
            # démarrage et laisse Uvicorn avec une réponse ASGI incomplète.
            return await receive()

        is_streaming = False
        deanonymizer: Optional[StreamDeanonymizer] = None
        stream_decoder = None
        response_parts: List[bytes] = []
        response_started_at: Optional[float] = None
        first_body_at: Optional[float] = None
        response_transform_ms = 0.0
        response_chunks = 0
        response_bytes = 0
        modified_response_bytes = 0
        response_status = 0
        metrics_logged = False

        def log_response_metrics(outcome: str) -> None:
            nonlocal metrics_logged
            if metrics_logged:
                return
            metrics_logged = True
            now = time.perf_counter()
            headers_ms = (
                (response_started_at - request_ready_at) * 1000
                if response_started_at is not None else -1.0
            )
            first_body_ms = (
                (first_body_at - request_ready_at) * 1000
                if first_body_at is not None else -1.0
            )
            logger.info(
                'pii_response_metrics path=%s status=%d streaming=%s outcome=%s '
                'headers_ms=%.3f first_body_ms=%.3f transform_ms=%.3f total_ms=%.3f '
                'chunks=%d response_bytes=%d modified_bytes=%d',
                path,
                response_status,
                str(is_streaming).lower(),
                outcome,
                headers_ms,
                first_body_ms,
                response_transform_ms,
                (now - request_started_at) * 1000,
                response_chunks,
                response_bytes,
                modified_response_bytes,
            )

        async def deanonymized_send(message: dict):
            nonlocal is_streaming, deanonymizer, stream_decoder
            nonlocal response_started_at, first_body_at, response_transform_ms
            nonlocal response_chunks, response_bytes, modified_response_bytes
            nonlocal response_status

            if message['type'] == 'http.response.start':
                response_started_at = time.perf_counter()
                response_status = int(message.get('status', 0))
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
            response_chunks += 1
            response_bytes += len(body)
            if body and first_body_at is None:
                first_body_at = time.perf_counter()
            if is_streaming and deanonymizer and stream_decoder:
                operation_started_at = time.perf_counter()
                decoded = stream_decoder.decode(body, final=not more_body)
                modified = deanonymizer.feed(decoded)
                if not more_body:
                    modified += deanonymizer.flush()
                encoded_modified = modified.encode('utf-8')
                response_transform_ms += (time.perf_counter() - operation_started_at) * 1000
                modified_response_bytes += len(encoded_modified)
                await send({
                    'type': 'http.response.body',
                    'body': encoded_modified,
                    'more_body': more_body,
                })
                if not more_body:
                    log_response_metrics('complete')
                return

            response_parts.append(body)
            if not more_body:
                operation_started_at = time.perf_counter()
                modified = self._deanonymize_json(b''.join(response_parts))
                response_transform_ms += (time.perf_counter() - operation_started_at) * 1000
                modified_response_bytes += len(modified)
                await send({
                    'type': 'http.response.body',
                    'body': modified,
                    'more_body': False,
                })
                log_response_metrics('complete')

        try:
            await self.app(downstream_scope, anonymized_receive, deanonymized_send)
        finally:
            if not metrics_logged:
                log_response_metrics('incomplete')

    async def _handle_websocket(
        self,
        path: str,
        receive: Callable,
        send: Callable,
        scope: dict,
    ) -> None:
        """Code les trames client et ré-identifie les trames serveur."""
        self.cache.refresh_if_needed()
        if self.cache.entity_count == 0:
            await send({
                'type': 'websocket.close',
                'code': 1011,
                'reason': 'Mapping central PieceMaker absent ou vide.',
            })
            return

        client_frames = 0
        server_frames = 0
        client_json_frames = 0
        server_json_frames = 0
        client_bytes = 0
        server_bytes = 0
        transform_ms = 0.0
        contextual_reverse = dict(self.cache.reverse_mapping)
        started_at = time.perf_counter()
        logger.info(
            'pii_websocket_open path=%s entities=%d',
            path,
            self.cache.entity_count,
        )

        def transform_frame(message: dict, transform: Callable) -> tuple[dict, int, bool]:
            text_payload = message.get('text')
            bytes_payload = message.get('bytes')
            if text_payload is None and bytes_payload is None:
                return message, 0, False

            is_bytes = bytes_payload is not None
            raw = bytes_payload if is_bytes else str(text_payload).encode('utf-8')
            try:
                parsed = json.loads(raw)
                transformed = transform(parsed)
                encoded = json.dumps(transformed, ensure_ascii=False).encode('utf-8')
            except (json.JSONDecodeError, UnicodeDecodeError, ValueError, TypeError):
                return message, len(raw), False

            modified = dict(message)
            if is_bytes:
                modified['bytes'] = encoded
            else:
                modified['text'] = encoded.decode('utf-8')
            return modified, len(raw), True

        async def anonymized_receive():
            nonlocal client_frames, client_json_frames, client_bytes, transform_ms
            nonlocal contextual_reverse
            message = await receive()
            if message.get('type') != 'websocket.receive':
                return message

            self.cache.refresh_if_needed()
            operation_started_at = time.perf_counter()
            observed_reverse = {}
            modified, size, request_json = transform_frame(
                message,
                lambda value: _walk_anonymize(
                    value,
                    self.cache.mapping,
                    observed_reverse,
                ),
            )
            contextual_reverse = dict(self.cache.reverse_mapping)
            contextual_reverse.update(observed_reverse)
            transform_ms += (time.perf_counter() - operation_started_at) * 1000
            client_frames += 1
            client_json_frames += int(request_json)
            client_bytes += size
            return modified

        async def deanonymized_send(message: dict):
            nonlocal server_frames, server_json_frames, server_bytes, transform_ms
            if message.get('type') != 'websocket.send':
                await send(message)
                return

            operation_started_at = time.perf_counter()
            modified, size, response_json = transform_frame(
                message,
                lambda value: _walk_deanonymize(value, contextual_reverse),
            )
            transform_ms += (time.perf_counter() - operation_started_at) * 1000
            server_frames += 1
            server_json_frames += int(response_json)
            server_bytes += size
            await send(modified)

        try:
            await self.app(scope, anonymized_receive, deanonymized_send)
        finally:
            logger.info(
                'pii_websocket_metrics path=%s entities=%d client_frames=%d '
                'client_json_frames=%d server_frames=%d server_json_frames=%d '
                'client_bytes=%d server_bytes=%d transform_ms=%.3f total_ms=%.3f',
                path,
                self.cache.entity_count,
                client_frames,
                client_json_frames,
                server_frames,
                server_json_frames,
                client_bytes,
                server_bytes,
                transform_ms,
                (time.perf_counter() - started_at) * 1000,
            )

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
