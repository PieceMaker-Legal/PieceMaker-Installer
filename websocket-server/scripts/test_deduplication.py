#!/usr/bin/env python3
"""
Test script to verify entity deduplication logic.
"""

import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from convert_and_scan_pipeline import normalize_name, are_names_similar, consolidate_duplicate_entities


def test_normalize_name():
    """Test name normalization."""
    print("=" * 70)
    print("TEST: normalize_name()")
    print("=" * 70)

    test_cases = [
        ("Mr. Gilly", "gilly"),
        ("Mr.  Gilly", "gilly"),
        ("Mr.Gilly", "gilly"),
        ("Bernard Gilly", "bernard gilly"),
        ("Maître Dupont", "dupont"),
        ("Dr. Jean-Pierre Martin", "jean-pierre martin"),
        ("Mme. Marie-Thérèse", "marie-therese"),
    ]

    for original, expected_contains in test_cases:
        normalized = normalize_name(original)
        status = "✅" if expected_contains in normalized else "❌"
        print(f"{status} '{original}' → '{normalized}' (expect '{expected_contains}')")

    print()


def test_are_names_similar():
    """Test name similarity detection."""
    print("=" * 70)
    print("TEST: are_names_similar()")
    print("=" * 70)

    test_cases = [
        # (name1, name2, expected_result)
        ("Mr. Gilly", "Mr. Gilly", True),  # Exact duplicate
        ("Mr. Gilly", "Mr.  Gilly", True),  # Extra space
        ("Mr. Gilly", "Bernard Gilly", True),  # Name variation
        ("Mr.Gilly", "Bernard Gilly", True),  # No space variant
        ("Jean Dupont", "Pierre Martin", False),  # Different people
        ("Jean Dupont", "Jean Martin", False),  # Different last names
        ("Mr. Smith", "Dr. Smith", True),  # Same last name, different titles
        ("Jean-Pierre Dupont", "Dupont", True),  # Substring match
    ]

    for name1, name2, expected in test_cases:
        norm1 = normalize_name(name1)
        norm2 = normalize_name(name2)
        result = are_names_similar(name1, norm1, name2, norm2)
        status = "✅" if result == expected else "❌"
        print(f"{status} '{name1}' vs '{name2}' → {result} (expect {expected})")

    print()


def test_consolidate_duplicate_entities():
    """Test entity consolidation."""
    print("=" * 70)
    print("TEST: consolidate_duplicate_entities()")
    print("=" * 70)

    # Simulate entities from GLiNER output
    entities = [
        {"text": "Mr. Gilly", "score": 0.92, "recognizer": "GLiNER2"},
        {"text": "Mr. Gilly", "score": 0.93, "recognizer": "GLiNER2"},  # Exact duplicate
        {"text": "Mr.  Gilly", "score": 0.91, "recognizer": "GLiNER2"},  # Extra space
        {"text": "Bernard Gilly", "score": 0.95, "recognizer": "GLiNER2"},  # Full name
        {"text": "Mr.Gilly", "score": 0.90, "recognizer": "GLiNER2"},  # No space
        {"text": "Jean Dupont", "score": 0.94, "recognizer": "GLiNER2"},  # Different person
        {"text": "Pierre Martin", "score": 0.96, "recognizer": "GLiNER2"},  # Another person
    ]

    consolidated = consolidate_duplicate_entities(entities)

    print(f"Original entities: {len(entities)}")
    print(f"Consolidated entities: {len(consolidated)}")
    print()

    for i, entity in enumerate(consolidated, 1):
        print(f"Entity {i}:")
        print(f"  Canonical: {entity['text']}")
        print(f"  Score: {entity['score']}")
        print(f"  Variants: {entity['variants']}")
        print()

    # Verify expectations
    print("Verification:")

    # Should have 3 unique persons (Gilly group, Dupont, Martin)
    if len(consolidated) == 3:
        print("✅ Correct number of unique entities (3)")
    else:
        print(f"❌ Expected 3 entities, got {len(consolidated)}")

    # Find Gilly group
    gilly_group = next((e for e in consolidated if "Gilly" in e['text']), None)

    if gilly_group:
        # Should use longest variant as canonical
        if gilly_group['text'] == "Bernard Gilly":
            print("✅ Correct canonical form (Bernard Gilly)")
        else:
            print(f"❌ Expected canonical 'Bernard Gilly', got '{gilly_group['text']}'")

        # Should have highest score
        if gilly_group['score'] == 0.95:
            print("✅ Correct score (0.95 - highest)")
        else:
            print(f"❌ Expected score 0.95, got {gilly_group['score']}")

        # Should have all unique variants (no duplicates)
        variants = gilly_group['variants']
        if len(variants) == len(set(variants)):
            print("✅ No duplicate variants in list")
        else:
            print(f"❌ Duplicate variants found: {variants}")

        # Should have 4 unique variants (duplicate "Mr. Gilly" should appear only once)
        expected_variants = {"Mr. Gilly", "Mr.  Gilly", "Bernard Gilly", "Mr.Gilly"}
        if len(variants) == 4 and set(variants) == expected_variants:
            print("✅ Correct number of variants (4 unique)")
        else:
            print(f"❌ Expected 4 variants {expected_variants}, got {len(variants)}: {variants}")

    else:
        print("❌ Could not find Gilly group")

    print()


if __name__ == "__main__":
    try:
        test_normalize_name()
        test_are_names_similar()
        test_consolidate_duplicate_entities()

        print("=" * 70)
        print("ALL TESTS COMPLETE")
        print("=" * 70)

    except Exception as e:
        print(f"❌ Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
