# Entity Deduplication Implementation Summary

## Changes Made to `convert_and_scan_pipeline.py`

### 1. Added Imports (Lines 34-42)
```python
import unicodedata
import re
from typing import List, Optional, Tuple, Dict, Set
```

### 2. Added Helper Functions (Before `convert_to_anonymization_format()`)

#### `normalize_name(text: str) -> str`
- Removes diacritics (é → e, à → a, etc.)
- Converts to lowercase
- Removes honorifics/titles (Mr., Mrs., Ms., Dr., M., Mme., Maître, etc.)
- Normalizes whitespace (multiple spaces → single space)
- Returns normalized form for comparison only

#### `are_names_similar(name1, norm1, name2, norm2) -> bool`
- Checks if two names refer to the same person using multiple strategies:
  - Exact match after normalization
  - Substring match (one contains the other, min 3 chars)
  - Token-based match (all tokens of shorter name appear in longer)

#### `consolidate_duplicate_entities(entities: List[Dict]) -> List[Dict]`
- Groups entities by similarity
- Handles both exact duplicates and variations (e.g., "Mr. Gilly" vs "Bernard Gilly")
- For each group:
  - Chooses longest variant as canonical text
  - Keeps highest score among all variants
  - Stores all unique variants (removes duplicates while preserving order)
- Returns deduplicated entity list

### 3. Updated `convert_to_anonymization_format()`

**Added pre-processing:**
```python
# Consolidate PERSON entities to remove duplicates
for entity_type in consolidated_entities.get("entities", {}).keys():
    if entity_type == "PERSON":
        consolidated_entities["entities"][entity_type] = consolidate_duplicate_entities(
            consolidated_entities["entities"][entity_type]
        )
```

**Modified main loop:**
- Removed: `mapping[text_lower] = code` (no lowercase in mapping)
- Changed: `"variants": [text, text_lower]` → `"variants": variants`
- Added: Loop through pre-consolidated variants and add each to mapping
- Get variants from: `entity.get("variants", [text])`

### 4. Updated `merge_with_existing_mapping()`

**Applied same changes:**
- Removed: `merged_mapping[text_lower] = new_code`
- Changed: `"variants": [text, text_lower]` → `"variants": variants`
- Get variants from: `old_entry.get("variants", [text])`
- Add all variants to merged mapping

## Expected Behavior

### Before (Current Output)
```json
{
  "mapping": {
    "Mr. Gilly": "PERSONNE_PHYSIQUE_03",
    "mr. gilly": "PERSONNE_PHYSIQUE_03",
    "Mr. Gilly": "PERSONNE_PHYSIQUE_04",  // duplicate gets different code
    "mr. gilly": "PERSONNE_PHYSIQUE_04",
    "Mr.  Gilly": "PERSONNE_PHYSIQUE_05",
    "mr.  gilly": "PERSONNE_PHYSIQUE_05",
    "Bernard Gilly": "PERSONNE_PHYSIQUE_08"
  }
}
```

### After (Fixed Output)
```json
{
  "mapping": {
    "Bernard Gilly": "PERSONNE_PHYSIQUE_03",
    "Mr. Gilly": "PERSONNE_PHYSIQUE_03",
    "Mr.  Gilly": "PERSONNE_PHYSIQUE_03",
    "Mr.Gilly": "PERSONNE_PHYSIQUE_03"
  },
  "extracted_data": {
    "personnes_physiques": {
      "PERSONNE_PHYSIQUE_03": {
        "original": "Bernard Gilly",
        "code": "PERSONNE_PHYSIQUE_03",
        "variants": ["Bernard Gilly", "Mr. Gilly", "Mr.  Gilly", "Mr.Gilly"],
        "score": 0.95,
        "recognizer": "GLiNER2Recognizer"
      }
    }
  }
}
```

## Key Improvements

1. **No lowercase duplicates**: Removed redundant lowercase variants from mapping and variants array
2. **Exact duplicates consolidated**: Same person appearing multiple times gets single code
3. **Spacing variations handled**: "Mr. Gilly" vs "Mr.  Gilly" vs "Mr.Gilly" → same code
4. **Name variations consolidated**: "Mr. Gilly" vs "Bernard Gilly" → same code
5. **Longest variant as canonical**: "Bernard Gilly" (longest) chosen over "Mr. Gilly"
6. **No duplicate variants**: Variants array contains only unique strings
7. **Non-PERSON entities unaffected**: Organizations and locations not consolidated

## Test Results

All unit tests pass:
- ✅ normalize_name() - 7/7 tests
- ✅ are_names_similar() - 8/8 tests
- ✅ consolidate_duplicate_entities() - 5/5 tests

Test demonstrates:
- 7 input entities → 3 unique persons
- "Mr. Gilly" (appears twice) + "Mr.  Gilly" + "Bernard Gilly" + "Mr.Gilly" → single entity
- Canonical form: "Bernard Gilly" (longest)
- Score: 0.95 (highest)
- Variants: 4 unique strings (no duplicates)

## Next Steps for Verification

1. **Test with real document**: Process a document containing duplicate person names
2. **Compare entity counts**:
   - Before: ~185 PERSONNE_PHYSIQUE entries
   - After: ~90-100 entries (expected ~50% reduction)
3. **Verify consolidation**: Check that variations of same person get same code
4. **Verify non-PERSON entities**: Organizations and locations unaffected
5. **Regression test**: Different people still get different codes
