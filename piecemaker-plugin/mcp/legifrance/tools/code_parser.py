# tools/code_parser.py
"""Parser pour normaliser les références d'articles de code"""

import re
from typing import List, Dict, Tuple, Any

def normalize_article_reference(ref: str) -> str:
    """
    Normalise une référence d'article vers le format attendu par l'API (sans point, sans espace).

    Exemples:
    - "L. 1234-1" → "L1234-1"
    - "L.1234-1" → "L1234-1"
    - "L 1234-1" → "L1234-1"
    - "L1234-1" → "L1234-1" (déjà normalisé)
    - "R. 1234-1" → "R1234-1"
    - "D. 1234-1" → "D1234-1"

    Args:
        ref: Référence brute

    Returns:
        Référence normalisée
    """
    # Enlever les espaces et les points après la lettre
    # Pattern: lettre(s) + point optionnel + espace optionnel + chiffres-chiffres
    normalized = re.sub(r'([A-Z]+)\.?\s*(\d+[-\d]*)', r'\1\2', ref.strip(), flags=re.IGNORECASE)
    return normalized.upper()


def parse_code_query(query: str, proximite: int = 10) -> Tuple[str, str, List[Dict[str, Any]], str]:
    """
    Parse une query de recherche dans les codes avec détection automatique des références d'articles.

    Exemples supportés:
    - "L.1234-1" → recherche exacte de l'article L1234-1 dans NUM_ARTICLE
    - "licenciement économique" → recherche des mots dans ALL
    - "L1234-1 ET indemnité" → recherche article + mot-clé
    - "clause de non-concurrence" → expression exacte dans ALL

    Args:
        query: Query brute
        proximite: Distance max entre mots

    Returns:
        (operateur_global, type_recherche, criteres_formatés, type_champ_optimal)
    """

    # Détecter si la query contient une référence d'article
    # Pattern: L/R/D suivi de chiffres-chiffres (avec ou sans point/espace)
    article_pattern = r'\b([LRDC])\.?\s*(\d+[-\d]+)\b'
    article_matches = list(re.finditer(article_pattern, query, re.IGNORECASE))

    if article_matches and len(article_matches) == 1 and len(query.split()) <= 2:
        # Query contient UNIQUEMENT une référence d'article
        article_ref = article_matches[0].group(0)
        normalized_ref = normalize_article_reference(article_ref)

        return "ET", "EXACTE", [{
            "valeur": normalized_ref,
            "operateur": "ET",
            "typeRecherche": "EXACTE",
            "proximite": None
        }], "NUM_ARTICLE"

    # Sinon, parse comme une query normale
    import sys
    import os
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from tools.query_parser import parse_query

    # Normaliser les références d'articles dans la query avant parsing
    normalized_query = query
    for match in article_matches:
        original = match.group(0)
        normalized = normalize_article_reference(original)
        normalized_query = normalized_query.replace(original, normalized)

    operateur, type_recherche, criteres = parse_query(normalized_query, proximite)

    # Type de champ par défaut : ALL (cherche partout)
    type_champ = "ALL"

    return operateur, type_recherche, criteres, type_champ


# Tests unitaires
if __name__ == "__main__":
    print("="*80)
    print("TESTS NORMALISATION RÉFÉRENCES ARTICLES")
    print("="*80)

    tests_normalisation = [
        ("L. 1234-1", "L1234-1"),
        ("L.1234-1", "L1234-1"),
        ("L 1234-1", "L1234-1"),
        ("L1234-1", "L1234-1"),
        ("R. 2242-1", "R2242-1"),
        ("D. 1234-56", "D1234-56"),
        ("l.1234-1", "L1234-1"),  # Minuscule
    ]

    for input_ref, expected in tests_normalisation:
        result = normalize_article_reference(input_ref)
        status = "✅" if result == expected else "❌"
        print(f"{status} '{input_ref}' → '{result}' (attendu: '{expected}')")

    print("\n" + "="*80)
    print("TESTS PARSING QUERIES")
    print("="*80)

    tests_queries = [
        "L. 1234-1",
        "licenciement économique",
        "L1234-1 ET indemnité",
        '"clause de non-concurrence"',
        "faute OU employeur",
    ]

    for test_query in tests_queries:
        print(f"\n🔍 Query: {test_query}")
        op, type_rech, criteres, type_champ = parse_code_query(test_query)
        print(f"   Opérateur: {op}")
        print(f"   Type recherche: {type_rech}")
        print(f"   Type champ: {type_champ}")
        print(f"   Critères ({len(criteres)}):")
        for c in criteres:
            print(f"      - '{c['valeur']}' ({c['typeRecherche']})")
