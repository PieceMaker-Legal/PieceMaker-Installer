"""Tests du cache du mapping central PieceMaker."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from piecemaker_pii.mapping import MappingCache  # noqa: E402


def _write_mapping(path, mapping=None, reverse=None):
    document = {}
    if mapping is not None:
        document['mapping'] = mapping
    if reverse is not None:
        document['reverse_mapping'] = reverse
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(document, handle, ensure_ascii=False)


class TestMappingCache(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temporary.name, 'central-mapping.json')

    def tearDown(self):
        self.temporary.cleanup()

    def test_charge_et_reconstruit_le_reverse(self):
        _write_mapping(self.path, {'Jean Dupont': 'PERSONNE_PHYSIQUE_01'})
        cache = MappingCache(self.path)
        self.assertEqual(cache.entity_count, 1)
        self.assertEqual(
            cache.reverse_mapping,
            {'PERSONNE_PHYSIQUE_01': ['Jean Dupont']},
        )

    def test_accepte_un_bom_utf8(self):
        with open(self.path, 'wb') as handle:
            handle.write(b'\xef\xbb\xbf')
            handle.write(json.dumps({
                'mapping': {'Jean Dupont': 'PERSONNE_PHYSIQUE_01'},
            }).encode('utf-8'))
        self.assertEqual(MappingCache(self.path).entity_count, 1)

    def test_fichier_invalide_vide_le_cache(self):
        _write_mapping(self.path, {'Jean Dupont': 'PERSONNE_PHYSIQUE_01'})
        cache = MappingCache(self.path)
        with open(self.path, 'w', encoding='utf-8') as handle:
            handle.write('{invalide')
        cache._last_check = 0
        cache.refresh_if_needed()
        self.assertEqual(cache.entity_count, 0)

    def test_suppression_vide_le_cache(self):
        _write_mapping(self.path, {'Jean Dupont': 'PERSONNE_PHYSIQUE_01'})
        cache = MappingCache(self.path)
        os.unlink(self.path)
        cache._last_check = 0
        cache.refresh_if_needed()
        self.assertEqual(cache.entity_count, 0)
        self.assertEqual(cache.code_count, 0)

    def test_mapping_absent_est_vide(self):
        cache = MappingCache(self.path)
        self.assertEqual(cache.entity_count, 0)
        self.assertEqual(cache.code_count, 0)


if __name__ == '__main__':
    unittest.main()
