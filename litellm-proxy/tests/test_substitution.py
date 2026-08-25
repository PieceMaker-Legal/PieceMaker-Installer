"""Tests du port Python du moteur de substitution PieceMaker."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from piecemaker_pii.substitution import (  # noqa: E402
    anonymize_text,
    build_entity_regex,
    deanonymize_text,
)


class TestSubstitution(unittest.TestCase):
    MAPPING = {
        'Jean Dupont-Martin': 'PERSONNE_PHYSIQUE_01',
        'Dupont': 'PERSONNE_PHYSIQUE_02',
        'SCI Riviera': 'PERSONNE_MORALE_01',
    }
    REVERSE = {
        'PERSONNE_PHYSIQUE_01': ['Jean Dupont-Martin'],
        'PERSONNE_PHYSIQUE_02': ['Dupont'],
        'PERSONNE_MORALE_01': ['SCI Riviera'],
    }

    def test_longest_first_et_round_trip(self):
        original = 'Jean Dupont-Martin assigne SCI Riviera avec Dupont.'
        coded = anonymize_text(original, self.MAPPING)
        self.assertEqual(
            coded,
            'PERSONNE_PHYSIQUE_01 assigne PERSONNE_MORALE_01 avec PERSONNE_PHYSIQUE_02.',
        )
        self.assertEqual(deanonymize_text(coded, self.REVERSE), original)

    def test_idempotence_protege_les_codes_existants(self):
        coded = 'PERSONNE_PHYSIQUE_02 et Dupont'
        self.assertEqual(
            anonymize_text(coded, self.MAPPING),
            'PERSONNE_PHYSIQUE_02 et PERSONNE_PHYSIQUE_02',
        )

    def test_variantes_unicode_et_espaces(self):
        regex = build_entity_regex("Jean Dupont-Martin l'Etat")
        self.assertIsNotNone(regex)
        self.assertTrue(regex.search('Jean  Dupont–Martin l’Etat'))

    def test_acronyme_court_reste_delimite_et_sensible_a_la_casse(self):
        regex = build_entity_regex('AB')
        self.assertIsNotNone(regex)
        self.assertTrue(regex.search('AB_SA'))
        self.assertFalse(regex.search('XABY'))
        self.assertFalse(regex.search('ab'))

    def test_entite_courte_ambigue_ignoree(self):
        self.assertIsNone(build_entity_regex('ab'))
        self.assertEqual(anonymize_text('ab', {'ab': 'CODE_01'}), 'ab')


if __name__ == '__main__':
    unittest.main()
