# tools/query_parser.py
"""Parser intelligent pour les queries de recherche jurisprudence"""

import re
from typing import List, Dict, Tuple, Any

def normalize_article_reference(ref: str) -> str:
    """
    Normalise une référence d'article vers le format sans point ni espace.

    Exemples:
    - "L. 1234-1" → "L1234-1"
    - "L.1234-1" → "L1234-1"
    - "L 1234-1" → "L1234-1"

    Args:
        ref: Référence brute

    Returns:
        Référence normalisée
    """
    normalized = re.sub(r'([A-Z]+)\.?\s*(\d+[-\d]*)', r'\1\2', ref.strip(), flags=re.IGNORECASE)
    return normalized.upper()


def parse_query(query: str, proximite: int = 10) -> Tuple[str, str, List[Dict[str, Any]]]:
    """
    Parse une query avec opérateurs logiques et expressions exactes.
    Normalise automatiquement les références d'articles (L. 1234-1 → L1234-1).

    Exemples supportés:
    - "faute grave" → tous les mots (ET par défaut)
    - "faute" ET "employeur" → opérateur ET explicite
    - "faute" OU "employeur" → opérateur OU explicite
    - "faute de l'employeur" → expression exacte (entre guillemets)
    - "FAUTE" ET "Employeur" ET "LICENCIEMENT" → multiple ET
    - "L. 1235-3" → article normalisé en L1235-3
    - Mixte: "clause non-concurrence" ET validité

    Args:
        query: Query brute
        proximite: Distance max entre mots (pour recherches non-exactes)

    Returns:
        (operateur_global, type_recherche, criteres_formatés)
    """

    # Nettoyer la query
    query = query.strip()

    # Normaliser les références d'articles dans la query
    # Pattern: L/R/D/C suivi de chiffres-chiffres (avec ou sans point/espace)
    article_pattern = r'\b([LRDC])\.?\s*(\d+[-\d]+)\b'

    def replace_article(match):
        return normalize_article_reference(match.group(0))

    query = re.sub(article_pattern, replace_article, query, flags=re.IGNORECASE)

    # Détecter les expressions exactes (entre guillemets)
    # Pattern: "texte entre guillemets" ou « texte »
    exact_pattern = r'["""«]([^"""»]+)["""»]'
    exact_matches = re.findall(exact_pattern, query)

    # Si toute la query est une expression exacte
    if len(exact_matches) == 1 and re.match(rf'^{exact_pattern}$', query.strip()):
        return "ET", "EXACTE", [{
            "valeur": exact_matches[0].strip(),
            "operateur": "ET",
            "typeRecherche": "EXACTE"
        }]

    # Remplacer temporairement les expressions exactes par des placeholders
    placeholders = {}
    for i, match in enumerate(exact_matches):
        placeholder = f"__EXACT_{i}__"
        placeholders[placeholder] = match.strip()
        query = query.replace(f'"{match}"', placeholder)
        query = query.replace(f'«{match}»', placeholder)

    # Détecter l'opérateur dominant
    has_et = ' ET ' in query.upper()
    has_ou = ' OU ' in query.upper()

    # Déterminer l'opérateur global
    if has_et and not has_ou:
        operateur_global = "ET"
    elif has_ou and not has_et:
        operateur_global = "OU"
    elif has_et and has_ou:
        # Mixte : privilégier ET (plus restrictif)
        operateur_global = "ET"
    else:
        # Pas d'opérateur explicite : ET par défaut
        operateur_global = "ET"

    # Split selon les opérateurs
    # Remplacer les opérateurs par un séparateur unique
    normalized = query
    normalized = re.sub(r'\s+ET\s+', ' __SEP__ ', normalized, flags=re.IGNORECASE)
    normalized = re.sub(r'\s+OU\s+', ' __SEP__ ', normalized, flags=re.IGNORECASE)

    # Split
    termes = [t.strip() for t in normalized.split('__SEP__') if t.strip()]

    # Si pas de séparateur trouvé, split sur les espaces
    if len(termes) == 1 and ' ' in termes[0]:
        termes = [t.strip() for t in termes[0].split() if t.strip()]

    # Construire les critères
    criteres = []

    for terme in termes:
        # Restaurer les placeholders d'expressions exactes
        if terme in placeholders:
            criteres.append({
                "valeur": placeholders[terme],
                "operateur": operateur_global,
                "typeRecherche": "EXACTE",
                "proximite": None  # Pas de proximité pour expressions exactes
            })
        else:
            # Terme normal
            criteres.append({
                "valeur": terme,
                "operateur": operateur_global,
                "typeRecherche": "TOUS_LES_MOTS_DANS_UN_CHAMP",
                "proximite": proximite
            })

    # Déterminer le type de recherche global
    if all(c["typeRecherche"] == "EXACTE" for c in criteres):
        type_recherche = "EXACTE"
    elif any(c["typeRecherche"] == "EXACTE" for c in criteres):
        type_recherche = "TOUS_LES_MOTS_DANS_UN_CHAMP"  # Mixte
    else:
        type_recherche = "TOUS_LES_MOTS_DANS_UN_CHAMP"

    return operateur_global, type_recherche, criteres


def build_search_payload_champs(query: str, proximite: int = 10) -> Tuple[str, str, List[Dict[str, Any]]]:
    """
    Construit la structure 'champs' pour l'API Légifrance à partir d'une query parsée.

    Args:
        query: Query brute avec opérateurs (ex: "faute" ET "employeur")
        proximite: Distance max entre mots (défaut: 10)

    Returns:
        (operateur_global, type_champ, champs_structure)
    """

    operateur_global, type_recherche, criteres = parse_query(query)

    # Construire la structure pour l'API
    champs = [{
        "typeChamp": "ALL",
        "operateur": operateur_global,
        "criteres": []
    }]

    for critere in criteres:
        champs[0]["criteres"].append({
            "operateur": critere["operateur"],
            "typeRecherche": critere["typeRecherche"],
            "valeur": critere["valeur"],
            "proximite": proximite if critere["typeRecherche"] != "EXACTE" else None
        })

    return operateur_global, "ALL", champs


# Tests unitaires
if __name__ == "__main__":
    print("="*80)
    print("TESTS DU PARSER DE QUERY")
    print("="*80)

    tests = [
        "faute grave licenciement",
        "faute ET employeur",
        "faute OU employeur",
        '"faute de l\'employeur"',
        "FAUTE ET Employeur ET LICENCIEMENT",
        '"clause de non-concurrence" ET validité',
        "licenciement",
        "faute OU employeur OU licenciement",
        '"expression exacte"',
        "mot1 ET mot2 OU mot3",  # Mixte
    ]

    for test in tests:
        print(f"\n🔍 Query: {test}")
        operateur, type_rech, criteres = parse_query(test)
        print(f"   Opérateur global: {operateur}")
        print(f"   Type recherche: {type_rech}")
        print(f"   Critères ({len(criteres)}):")
        for c in criteres:
            print(f"      - '{c['valeur']}' ({c['typeRecherche']})")

    print("\n" + "="*80)
    print("TEST CONSTRUCTION PAYLOAD API")
    print("="*80)

    query_test = "faute ET employeur"
    op, tc, champs = build_search_payload_champs(query_test)

    import json
    print(f"\nQuery: {query_test}")
    print(f"\nStructure générée:")
    print(json.dumps(champs, indent=2, ensure_ascii=False))
