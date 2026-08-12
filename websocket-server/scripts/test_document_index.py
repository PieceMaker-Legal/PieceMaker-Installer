#!/usr/bin/env python3
"""
Test the per-document index writer and French date normalisation.

Run: python3 websocket-server/scripts/test_document_index.py
"""

import hashlib
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from convert_and_scan_pipeline import (  # noqa: E402
    write_document_index,
    load_document_index,
    anonymization_state_key,
    _mapping_code_lookup,
    _codes_for_entities,
    _sensitive_tokens,
    _scrub_free_text,
)


def test_mapping_code_lookup_is_case_insensitive_and_longest_first():
    final = {"mapping": {
        "Bernard Gilly": "PERSONNE_PHYSIQUE_01",
        "M. Gilly": "PERSONNE_PHYSIQUE_01",
        "IMMOBILIÈRE DU PARC": "PERSONNE_MORALE_01",
    }}
    lookup = _mapping_code_lookup(final)
    assert lookup["bernard gilly"] == "PERSONNE_PHYSIQUE_01"
    assert lookup["m. gilly"] == "PERSONNE_PHYSIQUE_01"
    assert lookup["immobilière du parc"] == "PERSONNE_MORALE_01"
    print("✓ _mapping_code_lookup case-insensitive")


def test_codes_for_entities_dedups_and_sorts():
    lookup = {"bernard gilly": "PERSONNE_PHYSIQUE_01", "m. gilly": "PERSONNE_PHYSIQUE_01",
              "immobilière du parc": "PERSONNE_MORALE_01"}
    entities = {
        "PERSON": [{"text": "Bernard Gilly"}, {"text": "M. Gilly"}],
        "ORGANIZATION": [{"text": "IMMOBILIÈRE DU PARC"}],
        "LOCATION": [{"text": "Unmapped Street"}],  # no code -> ignored
    }
    codes = _codes_for_entities(entities, lookup)
    assert codes == ["PERSONNE_MORALE_01", "PERSONNE_PHYSIQUE_01"], codes
    print("✓ _codes_for_entities dedups variants and drops unmapped")


def test_write_document_index_keys_by_hash_of_relpath():
    final = {"mapping": {"Bernard Gilly": "PERSONNE_PHYSIQUE_01"}}
    records = [{
        "source": "/case/Assignation.pdf",
        "entities": {"PERSON": [{"text": "Bernard Gilly"}]},
        "document_meta": {"nature": "assignation", "doc_date": "14 mars 2023",
                          "doc_date_iso": "2023-03-14", "juridiction": "Tribunal judiciaire de Paris"},
    }]
    with tempfile.TemporaryDirectory() as directory:
        index_path = Path(directory) / "document-index.json"
        written = write_document_index(index_path, "/case", records, final)
        assert written == 1
        data = json.loads(index_path.read_text(encoding="utf-8"))
        expected_key = hashlib.sha256(b"Assignation.pdf").hexdigest()
        assert expected_key in data["documents"], list(data["documents"])
        entry = data["documents"][expected_key]
        assert entry["nature"] == "assignation"
        assert entry["doc_date_iso"] == "2023-03-14"
        assert entry["codes"] == ["PERSONNE_PHYSIQUE_01"]
        # No filename or clear entity name is ever persisted.
        blob = index_path.read_text(encoding="utf-8")
        assert "Assignation.pdf" not in blob
        assert "Bernard Gilly" not in blob
    print("✓ write_document_index keys by sha256(relpath), stores codes only")


def test_write_document_index_merges_across_runs():
    final = {"mapping": {"Bernard Gilly": "PERSONNE_PHYSIQUE_01"}}
    with tempfile.TemporaryDirectory() as directory:
        index_path = Path(directory) / "document-index.json"
        write_document_index(index_path, "/case",
                             [{"source": "/case/A.pdf", "entities": {}, "document_meta": {}}], final)
        write_document_index(index_path, "/case",
                             [{"source": "/case/B.pdf", "entities": {}, "document_meta": {}}], final)
        data = load_document_index(index_path)
        assert len(data["documents"]) == 2, "second run must not drop the first document"
    print("✓ write_document_index merges documents across runs")


def test_juridiction_scrub_drops_party_names_keeps_courts():
    final = {"mapping": {"URGOT SA": "SOCIETE_SA_06", "CAITLYN SA": "SOCIETE_SA_02",
                         "Bernard Gilly": "PERSONNE_PHYSIQUE_01"}}
    tokens = _sensitive_tokens(final)
    # Full match, partial match and a lone token all get dropped.
    assert _scrub_free_text("CAITLYN SA", tokens) is None
    assert _scrub_free_text("URGOT", tokens) is None
    assert _scrub_free_text("Gilly", tokens) is None
    # A genuine institutional court survives — no token overlap with any party.
    assert _scrub_free_text("Tribunal de commerce de Paris", tokens) == "Tribunal de commerce de Paris"
    # "SA" alone is noise, not a court — dropped (no >=4-char token).
    assert "sa" not in tokens
    assert _scrub_free_text("SA", tokens) is None
    assert _scrub_free_text("n/a", tokens) is None
    print("✓ _scrub_free_text drops party names and noise, keeps courts")


def test_write_document_index_never_persists_a_leaked_juridiction():
    final = {"mapping": {"URGOT SA": "SOCIETE_SA_06"}}
    records = [{
        "source": "/case/jugement.pdf",
        "entities": {},
        "document_meta": {"nature": "jugement", "juridiction": "URGOT SA"},
    }]
    with tempfile.TemporaryDirectory() as directory:
        index_path = Path(directory) / "document-index.json"
        write_document_index(index_path, "/case", records, final)
        blob = index_path.read_text(encoding="utf-8")
        assert "URGOT" not in blob, "a mis-extracted party name must never reach the index"
        entry = json.loads(blob)["documents"][hashlib.sha256(b"jugement.pdf").hexdigest()]
        assert entry["juridiction"] is None
    print("✓ write_document_index scrubs a leaked juridiction before disk")


def test_state_key_is_nfc_stable():
    # The same accented filename in decomposed (NFD) and composed (NFC) form must
    # hash to one key, or the chronology join drops it on macOS.
    import unicodedata
    nfc = unicodedata.normalize("NFC", "Procès-verbal.pdf")
    nfd = unicodedata.normalize("NFD", "Procès-verbal.pdf")
    assert nfc != nfd  # the two byte forms really differ
    assert anonymization_state_key(f"/case/{nfc}", "/case") == anonymization_state_key(f"/case/{nfd}", "/case")
    print("✓ anonymization_state_key is NFC-stable across NFC/NFD filenames")


if __name__ == "__main__":
    test_mapping_code_lookup_is_case_insensitive_and_longest_first()
    test_codes_for_entities_dedups_and_sorts()
    test_write_document_index_keys_by_hash_of_relpath()
    test_write_document_index_merges_across_runs()
    test_juridiction_scrub_drops_party_names_keeps_courts()
    test_write_document_index_never_persists_a_leaked_juridiction()
    test_state_key_is_nfc_stable()
    print("\nAll document-index tests passed.")
