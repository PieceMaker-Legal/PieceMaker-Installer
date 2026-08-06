#!/usr/bin/env python3
"""
Test Address Parsing Functionality

Tests the parse_address() function with various address formats
to verify partial anonymization logic works correctly.
"""

import sys
from pathlib import Path

# Add parent directory to path to import convert_and_scan_pipeline
sys.path.insert(0, str(Path(__file__).parent))

from convert_and_scan_pipeline import parse_address


def test_address_parsing():
    """Run comprehensive address parsing tests."""

    test_cases = [
        # French addresses
        {
            "input": "123 Rue de Rivoli, 75001 Paris, France",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "123 Rue de Rivoli",
                "postal_code": "75001",
                "city": "Paris",
                "country": "France",
                "anonymization_strategy": "partial"
            },
            "description": "Full French address with postal, city, country"
        },
        {
            "input": "20 Bis rue de la Princesse, Lyon",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "20 Bis rue de la Princesse",
                "city": "Lyon",
                "anonymization_strategy": "partial"
            },
            "description": "French address with Bis suffix, city only"
        },
        {
            "input": "11 rue Heinrich, 69002 Lyon",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "11 rue Heinrich",
                "postal_code": "69002",
                "city": "Lyon",
                "anonymization_strategy": "partial"
            },
            "description": "French address with postal and city"
        },
        {
            "input": "5 avenue des Champs-Élysées",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "5 avenue des Champs-Élysées",
                "anonymization_strategy": "partial"
            },
            "description": "French address without city (avenue)"
        },
        {
            "input": "42 boulevard Saint-Germain, 75005 Paris",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "42 boulevard Saint-Germain",
                "postal_code": "75005",
                "city": "Paris",
                "anonymization_strategy": "partial"
            },
            "description": "French boulevard address"
        },

        # Belgian addresses
        {
            "input": "Rue de la Loi 123, 1000 Bruxelles, Belgique",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "Rue de la Loi 123",
                "postal_code": "1000",
                "city": "Bruxelles",
                "country": "Belgique",
                "anonymization_strategy": "partial"
            },
            "description": "Belgian address (street name before number)"
        },
        {
            "input": "Avenue Louise 54, 1050 Bruxelles",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "Avenue Louise 54",
                "postal_code": "1050",
                "city": "Bruxelles",
                "anonymization_strategy": "partial"
            },
            "description": "Belgian avenue address"
        },

        # Swiss addresses
        {
            "input": "Rue du Rhône 50, 1204 Genève, Suisse",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "Rue du Rhône 50",
                "postal_code": "1204",
                "city": "Genève",
                "country": "Suisse",
                "anonymization_strategy": "partial"
            },
            "description": "Swiss address"
        },
        {
            "input": "Chemin des Fleurs 8, 1006 Lausanne",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "Chemin des Fleurs 8",
                "postal_code": "1006",
                "city": "Lausanne",
                "anonymization_strategy": "partial"
            },
            "description": "Swiss chemin address"
        },

        # Luxembourg addresses
        {
            "input": "Avenue de la Liberté 10, L-1931 Luxembourg",
            "expected": {
                "success": True,
                "is_city_only": False,
                "street_part": "Avenue de la Liberté 10",
                "postal_code": "L-1931",
                "city": "Luxembourg",
                "anonymization_strategy": "partial"
            },
            "description": "Luxembourg address with L- postal prefix"
        },

        # City-only (no anonymization)
        {
            "input": "Paris",
            "expected": {
                "success": True,
                "is_city_only": True,
                "street_part": None,
                "city": "Paris",
                "anonymization_strategy": "none"
            },
            "description": "City only - should not be anonymized"
        },
        {
            "input": "Lyon",
            "expected": {
                "success": True,
                "is_city_only": True,
                "city": "Lyon",
                "anonymization_strategy": "none"
            },
            "description": "Another city only"
        },
        {
            "input": "Bruxelles",
            "expected": {
                "success": True,
                "is_city_only": True,
                "city": "Bruxelles",
                "anonymization_strategy": "none"
            },
            "description": "Belgian city only"
        },
        {
            "input": "France",
            "expected": {
                "success": True,
                "is_city_only": True,
                "city": "France",
                "anonymization_strategy": "none"
            },
            "description": "Country only"
        },

        # Unparseable (full anonymization)
        {
            "input": "Some Complex Address Format",
            "expected": {
                "success": False,
                "is_city_only": False,
                "street_part": "Some Complex Address Format",
                "anonymization_strategy": "full"
            },
            "description": "Unparseable address - full anonymization"
        },
        {
            "input": "Building A, Floor 3, Office 42",
            "expected": {
                "success": False,
                "is_city_only": False,
                "street_part": "Building A, Floor 3, Office 42",
                "anonymization_strategy": "full"
            },
            "description": "Office-style address - full anonymization"
        },
    ]

    passed = 0
    failed = 0

    print("=" * 80)
    print("ADDRESS PARSING TEST SUITE")
    print("=" * 80)
    print()

    for i, test in enumerate(test_cases, 1):
        print(f"Test {i}: {test['description']}")
        print(f"  Input: {test['input']}")

        result = parse_address(test['input'])

        # Check key fields
        success = True
        mismatches = []

        for key, expected_value in test['expected'].items():
            actual_value = result.get(key)
            if actual_value != expected_value:
                success = False
                mismatches.append(f"    {key}: expected={expected_value}, got={actual_value}")

        if success:
            print("  ✅ PASSED")
            passed += 1
        else:
            print("  ❌ FAILED")
            print("  Mismatches:")
            for mismatch in mismatches:
                print(mismatch)
            print(f"  Full result: {result}")
            failed += 1

        print()

    # Summary
    print("=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)
    print(f"Total tests: {len(test_cases)}")
    print(f"Passed: {passed} ({passed * 100 // len(test_cases)}%)")
    print(f"Failed: {failed}")
    print()

    if failed == 0:
        print("🎉 All tests passed!")
        return 0
    else:
        print(f"⚠️  {failed} test(s) failed")
        return 1


if __name__ == "__main__":
    sys.exit(test_address_parsing())