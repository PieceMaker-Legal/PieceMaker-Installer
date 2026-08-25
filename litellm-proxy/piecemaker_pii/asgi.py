"""
Middleware ASGI pour anonymisation/deanonymisation PII.

Se place autour du proxy LiteLLM (ou toute app ASGI). Intercepte :
 - les requetes POST /v1/messages : anonymise le corps JSON
 - les reponses : deanonymise le JSON (non-streaming) ou les events SSE (streaming)

Le mapping central PieceMaker est recharge a chaud depuis le disque.
"""

import json
import logging
import os
from typing import Any, Callable, List, Optional, Tuple

from .mapping import MappingCache
from .substitution import anonymize_text, deanonymize_text

logger = logging.getLogger('piecemaker_pii.asgi')

ANONYMIZE_KEYS = {'content', 'text', 'system', 'messages'}
DEANONYMIZE_KEYS = {'content', 'text', 'delta'}
CODE_CHARS = set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_')

PATHS_TO_PROCESS = {'/v1/messages', '/anthropic/v1/messages'}


def _walk_anonymize(obj: Any, mapping: dict) -> Any:
    if isinstance(obj, str):
        return anonymize_text(obj, mapping)
    if isinstance(obj, list):
        return [_walk_anonymize(item, mapping) for item in obj]
    if isinstance(obj, dict):
        return {
            k: _walk_anonymize(v, mapping) if k in ANONYMIZE_KEYS else v
            for k, v in obj.items()
        }
    return obj


def _walk_deanonymize(obj: Any, reverse: dict) -> Any:
    if isinstance(obj, str):
        return deanonymize_text(obj, reverse)
    if isinstance(obj, list):
        return [_walk_deanonymize(item, reverse) for item in obj]
    if isinstance(obj, dict):
        return {
            k: _walk_deanonymize(v, reverse) if k in DEANONYMIZE_KEYS else v
            for k, v in obj.items()
        }
    return obj


class StreamDeanonymizer:
    """Buffer de deanonymisation pour SSE — gere les codes coupes entre chunks."""

    def __init__(self, reverse_mapping: dict):
        self.reverse = reverse_mapping
        self.max_code_len = max((len(k) for k in reverse_mapping), default=0)
        self.buffer = ''

    def feed(self, text: str) -> str:
        self.buffer += text
        if len(self.buffer) <= self.max_code_len:
            return ''
        emit_end = len(self.buffer) - self.max_code_len
        while emit_end > 0 and self.buffer[emit_end - 1] in CODE_CHARS:
            emit_end -= 1
        if emit_end <= 0:
            return ''
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
    """Middleware ASGI pur — compatible streaming SSE, sans BaseHTTPMiddleware."""

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
        if path not in PATHS_TO_PROCESS:
            await self.app(scope, receive, send)
            return

        method = scope.get('method', 'GET')
        if method != 'POST':
            await self.app(scope, receive, send)
            return

        self.cache.refresh_if_needed()
        if self.cache.entity_count == 0:
            await self.app(scope, receive, send)
            return

        # ── Anonymiser le corps de la requete ──────────────────────────────
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
        except (json.JSONDecodeError, ValueError):
            modified_body = raw_body

        # Mettre a jour content-length dans les headers du scope
        new_headers = []
        for k, v in scope.get('headers', []):
            key = k if isinstance(k, str) else k.decode('latin-1')
            if key.lower() == 'content-length':
                new_headers.append((k, str(len(modified_body)).encode('latin-1')
                                    if isinstance(v, bytes) else str(len(modified_body))))
            else:
                new_headers.append((k, v))
        scope = dict(scope, headers=new_headers)

        body_sent = False
        async def anonymized_receive():
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {'type': 'http.request', 'body': modified_body, 'more_body': False}
            return {'type': 'http.disconnect'}

        # ── Deanonymiser la reponse ────────────────────────────────────────
        is_streaming = False
        deanonymizer: Optional[StreamDeanonymizer] = None
        response_parts: List[bytes] = []
        sse_line_buffer = ''

        async def deanonymized_send(message: dict):
            nonlocal is_streaming, deanonymizer, response_parts, sse_line_buffer

            if message['type'] == 'http.response.start':
                headers = message.get('headers', [])
                content_type = ''
                filtered_headers = []
                for k, v in headers:
                    key = k.decode('latin-1') if isinstance(k, bytes) else k
                    val = v.decode('latin-1') if isinstance(v, bytes) else v
                    if key.lower() == 'content-type':
                        content_type = val
                    # Retirer content-length (la taille change apres deanonymisation)
                    if key.lower() != 'content-length':
                        filtered_headers.append((k, v))

                is_streaming = 'text/event-stream' in content_type
                if is_streaming:
                    deanonymizer = StreamDeanonymizer(self.cache.reverse_mapping)

                await send(dict(message, headers=filtered_headers))

            elif message['type'] == 'http.response.body':
                body = message.get('body', b'')
                more_body = message.get('more_body', False)

                if is_streaming and deanonymizer:
                    modified = self._process_sse_chunk(
                        body.decode('utf-8', errors='replace'),
                        deanonymizer,
                        flush=not more_body,
                    )
                    await send({
                        'type': 'http.response.body',
                        'body': modified.encode('utf-8'),
                        'more_body': more_body,
                    })
                elif not is_streaming:
                    response_parts.append(body)
                    if not more_body:
                        full = b''.join(response_parts)
                        modified = self._deanonymize_json(full)
                        await send({
                            'type': 'http.response.body',
                            'body': modified,
                            'more_body': False,
                        })
                else:
                    await send(message)
            else:
                await send(message)

        await self.app(scope, anonymized_receive, deanonymized_send)

    def _deanonymize_json(self, raw: bytes) -> bytes:
        try:
            obj = json.loads(raw)
            modified = _walk_deanonymize(obj, self.cache.reverse_mapping)
            return json.dumps(modified, ensure_ascii=False).encode('utf-8')
        except (json.JSONDecodeError, ValueError):
            return raw

    def _process_sse_chunk(self, chunk: str, deano: StreamDeanonymizer,
                            flush: bool = False) -> str:
        """Traite un chunk SSE brut, deanonymise les text_delta."""
        result_lines: List[str] = []
        lines = chunk.split('\n')

        for line in lines:
            if not line.startswith('data: '):
                result_lines.append(line)
                continue

            data_str = line[6:]
            try:
                event = json.loads(data_str)
            except (json.JSONDecodeError, ValueError):
                result_lines.append(line)
                continue

            event_type = event.get('type', '')

            if event_type == 'content_block_delta':
                delta = event.get('delta', {})
                if delta.get('type') == 'text_delta' and 'text' in delta:
                    processed = deano.feed(delta['text'])
                    delta['text'] = processed
                    event['delta'] = delta
                    result_lines.append('data: ' + json.dumps(event, ensure_ascii=False))
                else:
                    result_lines.append(line)

            elif event_type in ('content_block_stop', 'message_stop'):
                remaining = deano.flush()
                if remaining:
                    flush_event = {
                        'type': 'content_block_delta',
                        'index': event.get('index', 0),
                        'delta': {'type': 'text_delta', 'text': remaining},
                    }
                    result_lines.append('event: content_block_delta')
                    result_lines.append('data: ' + json.dumps(flush_event, ensure_ascii=False))
                    result_lines.append('')
                result_lines.append(line)
            else:
                result_lines.append(line)

        if flush:
            remaining = deano.flush()
            if remaining:
                flush_event = {
                    'type': 'content_block_delta',
                    'index': 0,
                    'delta': {'type': 'text_delta', 'text': remaining},
                }
                result_lines.append('event: content_block_delta')
                result_lines.append('data: ' + json.dumps(flush_event, ensure_ascii=False))
                result_lines.append('')

        return '\n'.join(result_lines)
