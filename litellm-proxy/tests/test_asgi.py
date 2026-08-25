"""Tests du middleware ASGI PieceMaker autour de LiteLLM."""

import asyncio
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from piecemaker_pii.asgi import (  # noqa: E402
    PIIMiddleware,
    StreamDeanonymizer,
    _is_generation_path,
    _walk_anonymize,
    _walk_deanonymize,
)

MAPPING = {
    'Jean Dupont': 'PERSONNE_PHYSIQUE_01',
    'SCI Riviera': 'PERSONNE_MORALE_01',
}
REVERSE = {
    'PERSONNE_PHYSIQUE_01': ['Jean Dupont'],
    'PERSONNE_MORALE_01': ['SCI Riviera'],
}


def _make_mapping_file(mapping=MAPPING, reverse=REVERSE):
    temporary = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump({'mapping': mapping, 'reverse_mapping': reverse}, temporary, ensure_ascii=False)
    temporary.close()
    return temporary.name


def _run(coroutine):
    return asyncio.run(coroutine)


async def _call_middleware(middleware, path, body, response_chunks, content_type):
    encoded_body = json.dumps(body, ensure_ascii=False).encode('utf-8')
    captured_request = {}

    async def app(scope, receive, send):
        captured_request['body'] = (await receive())['body']
        await send({
            'type': 'http.response.start',
            'status': 200,
            'headers': [
                (b'content-type', content_type.encode('ascii')),
                (b'content-length', b'999'),
            ],
        })
        for index, chunk in enumerate(response_chunks):
            await send({
                'type': 'http.response.body',
                'body': chunk,
                'more_body': index < len(response_chunks) - 1,
            })

    middleware.app = app
    scope = {
        'type': 'http',
        'path': path,
        'method': 'POST',
        'headers': [
            (b'content-type', b'application/json'),
            (b'content-length', str(len(encoded_body)).encode('ascii')),
        ],
    }

    async def receive():
        return {'type': 'http.request', 'body': encoded_body, 'more_body': False}

    sent = []

    async def send(message):
        sent.append(message)

    await middleware(scope, receive, send)
    return captured_request, sent


class TestWalkers(unittest.TestCase):
    def test_anonymise_messages_et_input_sans_toucher_au_modele(self):
        request = {
            'model': 'Jean Dupont',
            'messages': [{'role': 'user', 'content': 'Bonjour Jean Dupont'}],
            'input': {'dossier': 'SCI Riviera'},
        }
        coded = _walk_anonymize(request, MAPPING)
        self.assertEqual(coded['model'], 'Jean Dupont')
        self.assertEqual(coded['messages'][0]['content'], 'Bonjour PERSONNE_PHYSIQUE_01')
        self.assertEqual(coded['input']['dossier'], 'PERSONNE_MORALE_01')

    def test_deanonymise_toute_forme_de_reponse(self):
        response = {
            'choices': [{'delta': {'content': 'Bonjour PERSONNE_PHYSIQUE_01'}}],
            'output': [{'arbitrary': 'PERSONNE_MORALE_01'}],
        }
        clear = _walk_deanonymize(response, REVERSE)
        self.assertEqual(clear['choices'][0]['delta']['content'], 'Bonjour Jean Dupont')
        self.assertEqual(clear['output'][0]['arbitrary'], 'SCI Riviera')

    def test_routes_generation_sans_routes_admin(self):
        self.assertTrue(_is_generation_path('/v1/chat/completions'))
        self.assertTrue(_is_generation_path('/anthropic/v1/messages'))
        self.assertTrue(_is_generation_path('/anthropic/v1/messages/count_tokens'))
        self.assertTrue(_is_generation_path('/openai/v1/responses'))
        self.assertTrue(_is_generation_path('/chatgpt/responses'))
        self.assertTrue(_is_generation_path('/chatgpt/responses/compact'))
        self.assertTrue(_is_generation_path('/gemini/v1beta/models/x:streamGenerateContent'))
        self.assertFalse(_is_generation_path('/ui'))
        self.assertFalse(_is_generation_path('/model/new'))


class TestStreamDeanonymizer(unittest.TestCase):
    def test_code_coupe_entre_plusieurs_chunks(self):
        transformer = StreamDeanonymizer(REVERSE)
        output = transformer.feed('debut ' + ('x' * 50) + ' PERSONNE_')
        output += transformer.feed('PHYSIQUE_01 fin')
        output += transformer.flush()
        self.assertIn('Jean Dupont', output)
        self.assertNotIn('PERSONNE_PHYSIQUE_01', output)

    def test_sans_mapping_relaie_immediatement(self):
        transformer = StreamDeanonymizer({})
        self.assertEqual(transformer.feed('texte'), 'texte')
        self.assertEqual(transformer.flush(), '')


class TestPIIMiddleware(unittest.TestCase):
    def setUp(self):
        self.mapping_path = _make_mapping_file()

        async def placeholder(scope, receive, send):
            raise AssertionError('application factice non remplacee')

        self.middleware = PIIMiddleware(placeholder, mapping_path=self.mapping_path)

    def tearDown(self):
        os.unlink(self.mapping_path)

    def test_json_openai_anonymise_requete_et_deanonymise_reponse(self):
        response = json.dumps({
            'choices': [{'message': {'content': 'Cher PERSONNE_PHYSIQUE_01'}}],
        }).encode('utf-8')
        captured, sent = _run(_call_middleware(
            self.middleware,
            '/v1/chat/completions',
            {'model': 'gpt', 'messages': [{'role': 'user', 'content': 'Jean Dupont'}]},
            [response],
            'application/json',
        ))
        request = json.loads(captured['body'])
        result = json.loads(sent[-1]['body'])
        self.assertEqual(request['messages'][0]['content'], 'PERSONNE_PHYSIQUE_01')
        self.assertEqual(result['choices'][0]['message']['content'], 'Cher Jean Dupont')
        self.assertNotIn(b'content-length', dict(sent[0]['headers']))

    def test_sse_openai_preserve_utf8_et_code_coupe(self):
        event = (
            'data: '
            + json.dumps({
                'choices': [{'delta': {'content': 'début PERSONNE_PHYSIQUE_01 fin'}}],
            }, ensure_ascii=False)
            + '\n\n'
        ).encode('utf-8')
        split_utf8 = event.index('dé'.encode('utf-8')) + 2
        split_code = event.index(b'PERSONNE_PHYSIQUE_01') + len(b'PERSONNE_')
        chunks = [event[:split_utf8], event[split_utf8:split_code], event[split_code:]]
        _, sent = _run(_call_middleware(
            self.middleware,
            '/v1/chat/completions',
            {'messages': [{'role': 'user', 'content': 'Bonjour'}]},
            chunks,
            'text/event-stream',
        ))
        output = b''.join(message.get('body', b'') for message in sent[1:]).decode('utf-8')
        payload = json.loads(output.removeprefix('data: ').strip())
        self.assertEqual(payload['choices'][0]['delta']['content'], 'début Jean Dupont fin')

    def test_logs_separent_preparation_attente_et_transformation_sans_pii(self):
        event = (
            'data: '
            + json.dumps({'delta': {'content': 'PERSONNE_PHYSIQUE_01'}})
            + '\n\n'
        ).encode('utf-8')

        with self.assertLogs('piecemaker_pii.asgi', level='INFO') as captured_logs:
            _run(_call_middleware(
                self.middleware,
                '/v1/responses',
                {'input': 'Bonjour Jean Dupont'},
                [event[:20], event[20:]],
                'text/event-stream',
            ))

        logs = '\n'.join(captured_logs.output)
        self.assertRegex(
            logs,
            r'pii_request_metrics path=/v1/responses request_bytes=\d+ modified_bytes=\d+ '
            r'entities=2 json=true refresh_ms=\d+\.\d{3} read_ms=\d+\.\d{3} '
            r'json_load_ms=\d+\.\d{3} anonymize_ms=\d+\.\d{3} '
            r'json_dump_ms=\d+\.\d{3} prepare_ms=\d+\.\d{3}',
        )
        self.assertRegex(
            logs,
            r'pii_response_metrics path=/v1/responses status=200 streaming=true outcome=complete '
            r'headers_ms=\d+\.\d{3} first_body_ms=\d+\.\d{3} '
            r'transform_ms=\d+\.\d{3} total_ms=\d+\.\d{3} chunks=2 '
            r'response_bytes=\d+ modified_bytes=\d+',
        )
        self.assertNotIn('Jean Dupont', logs)
        self.assertNotIn('PERSONNE_PHYSIQUE_01', logs)

    def test_log_signale_une_reponse_incomplete(self):
        async def app(scope, receive, send):
            await receive()
            await send({
                'type': 'http.response.start',
                'status': 200,
                'headers': [(b'content-type', b'text/event-stream')],
            })

        self.middleware.app = app

        async def call():
            async def receive():
                return {'type': 'http.request', 'body': b'{"input":"Bonjour"}', 'more_body': False}

            async def send(_message):
                return None

            await self.middleware({
                'type': 'http',
                'path': '/v1/responses',
                'method': 'POST',
                'headers': [(b'content-type', b'application/json')],
            }, receive, send)

        with self.assertLogs('piecemaker_pii.asgi', level='INFO') as captured_logs:
            _run(call())

        self.assertIn('streaming=true outcome=incomplete', '\n'.join(captured_logs.output))

    def test_streaming_echappe_un_nom_canonique_json(self):
        mapping_path = _make_mapping_file(
            {'Jean "JD" Dupont': 'PERSONNE_PHYSIQUE_01'},
            {'PERSONNE_PHYSIQUE_01': ['Jean "JD"\nDupont']},
        )
        try:
            middleware = PIIMiddleware(self.middleware.app, mapping_path=mapping_path)
            event = (
                'data: '
                + json.dumps({'delta': {'content': 'PERSONNE_PHYSIQUE_01'}})
                + '\n\n'
            ).encode('utf-8')
            _, sent = _run(_call_middleware(
                middleware,
                '/v1/responses',
                {'input': 'Bonjour'},
                [event],
                'text/event-stream',
            ))
            output = b''.join(message.get('body', b'') for message in sent[1:]).decode('utf-8')
            payload = json.loads(output.removeprefix('data: ').strip())
            self.assertEqual(payload['delta']['content'], 'Jean "JD"\nDupont')
        finally:
            os.unlink(mapping_path)

    def test_streaming_ne_simule_pas_une_deconnexion_client(self):
        async def call():
            response_sent = asyncio.Event()
            disconnect_released = asyncio.Event()
            receive_calls = 0
            sent = []

            async def app(scope, receive, send):
                await receive()
                disconnect_listener = asyncio.create_task(receive())
                await send({
                    'type': 'http.response.start',
                    'status': 200,
                    'headers': [(b'content-type', b'text/event-stream')],
                })
                await asyncio.sleep(0)
                if disconnect_listener.done():
                    return
                await send({
                    'type': 'http.response.body',
                    'body': b'data: {"text":"PERSONNE_PHYSIQUE_01"}\n\n',
                    'more_body': False,
                })
                response_sent.set()
                disconnect_listener.cancel()
                try:
                    await disconnect_listener
                except asyncio.CancelledError:
                    pass

            async def receive():
                nonlocal receive_calls
                receive_calls += 1
                if receive_calls == 1:
                    return {'type': 'http.request', 'body': b'{"input":"Bonjour"}', 'more_body': False}
                await disconnect_released.wait()
                return {'type': 'http.disconnect'}

            async def send(message):
                sent.append(message)

            self.middleware.app = app
            await asyncio.wait_for(self.middleware({
                'type': 'http',
                'path': '/v1/responses',
                'method': 'POST',
                'headers': [(b'content-type', b'application/json')],
            }, receive, send), timeout=1)
            self.assertTrue(response_sent.is_set())
            self.assertFalse(disconnect_released.is_set())
            return sent

        sent = _run(call())
        self.assertEqual(sent[-1]['type'], 'http.response.body')
        self.assertFalse(sent[-1]['more_body'])
        self.assertIn('Jean Dupont', sent[-1]['body'].decode('utf-8'))

    def test_mapping_absent_bloque_generation_mais_pas_admin(self):
        missing = os.path.join(tempfile.gettempdir(), 'piecemaker-mapping-absent-test.json')
        try:
            os.unlink(missing)
        except FileNotFoundError:
            pass

        app_calls = []

        async def app(scope, receive, send):
            app_calls.append(scope['path'])

        middleware = PIIMiddleware(app, mapping_path=missing)

        async def generation_call():
            sent = []

            async def receive():
                return {'type': 'http.request', 'body': b'{}', 'more_body': False}

            async def send(message):
                sent.append(message)

            await middleware({
                'type': 'http', 'path': '/v1/messages', 'method': 'POST', 'headers': [],
            }, receive, send)
            return sent

        sent = _run(generation_call())
        self.assertEqual(sent[0]['status'], 503)
        self.assertEqual(app_calls, [])

        _run(middleware(
            {'type': 'http', 'path': '/ui', 'method': 'GET', 'headers': []},
            None,
            None,
        ))
        self.assertEqual(app_calls, ['/ui'])


if __name__ == '__main__':
    unittest.main()
