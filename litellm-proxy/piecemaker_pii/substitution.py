"""
Moteur de substitution d'anonymisation — port Python de substitution.cjs.

Deux sens, idempotents :
 - anonymize_text : entite -> code (pour ce que l'IA lit)
 - deanonymize_text : code -> entite (pour ce que l'IA produit)

Substitution triee de la plus longue entite a la plus courte, sinon
"Dupont" corrompt "Jean Dupont-Martin". Les codes deja presents sont
masques avant substitution pour ne jamais corrompre un code existant.
"""

import re
from typing import Dict, List, Optional, Tuple

MIN_ENTITY_LENGTH = 3

# [^\W_] = lettres et chiffres Unicode (sans underscore) — equivalent a \p{L}\p{N}
BOUNDARY_BEFORE = r'(?<![^\W_])'
BOUNDARY_AFTER = r'(?![^\W_])'

# Ponctuations a variantes Unicode, ramenees a une classe regex
CHAR_VARIANTS = [
    # traits d'union, tirets, signe moins
    {
        'chars': '-‐‑‒–—―−',
        'cls': r'[-‐-―−]',
    },
    # apostrophes droites et typographiques
    {
        'chars': "'‘’ʼ´",
        'cls': r"['‘’ʼ´]",
    },
    # guillemets doubles
    {
        'chars': '"“”',
        'cls': r'["“”]',
    },
]

VARIANT_OF: Dict[str, str] = {}
for group in CHAR_VARIANTS:
    for ch in group['chars']:
        VARIANT_OF[ch] = group['cls']


def _escape_with_variants(token: str) -> str:
    """Echappe un token en remplacant chaque caractere a variantes par sa classe."""
    out = []
    for ch in token:
        variant = VARIANT_OF.get(ch)
        if variant:
            out.append(variant)
        else:
            out.append(re.escape(ch))
    return ''.join(out)


def build_entity_regex(entity: str) -> Optional[re.Pattern]:
    """Construit la regex qui retrouve une entite dans le texte.

    >= 3 caracteres : substitution en sous-chaine, casse ignoree.
    2 caracteres : acronyme delimite, sensible a la casse.
    """
    if not isinstance(entity, str):
        return None
    trimmed = entity.strip()
    if not trimmed:
        return None
    if not re.search(r'[\w]', trimmed, re.UNICODE):
        return None

    pattern = r'\s+'.join(_escape_with_variants(part) for part in trimmed.split())

    if len(trimmed) >= MIN_ENTITY_LENGTH:
        return re.compile(pattern, re.IGNORECASE | re.UNICODE)

    is_acronym = bool(re.match(r'^[A-Z0-9][A-Z0-9.&-]*$', trimmed, re.UNICODE))
    if len(trimmed) == 2 and is_acronym:
        return re.compile(BOUNDARY_BEFORE + pattern + BOUNDARY_AFTER, re.UNICODE)
    return None


def anonymize_text(text: str, mapping: Dict[str, str]) -> str:
    """Entite -> code. Les entrees passent de la plus longue a la plus courte."""
    if not isinstance(text, str) or not text:
        return text
    entries = [(entity, code) for entity, code in mapping.items() if entity and code]
    if not entries:
        return text

    # Masquage des codes deja presents (zone privee Unicode) pour ne jamais
    # corrompre un code existant — garantit aussi l'idempotence.
    codes = sorted(set(code for _, code in entries), key=len, reverse=True)
    restore: List[Tuple[str, str]] = []
    masked = text
    for idx, code in enumerate(codes):
        if code not in masked:
            continue
        token = chr(0xE000 + idx)
        restore.append((token, code))
        masked = masked.replace(code, token)

    # Substitution longest-first
    output = masked
    for entity, code in sorted(entries, key=lambda e: len(e[0]), reverse=True):
        regex = build_entity_regex(entity)
        if regex is None:
            continue
        output = regex.sub(code, output)

    # Restauration des codes masques
    for token, code in restore:
        output = output.replace(token, code)
    return output


def deanonymize_text(text: str, reverse_mapping: Dict[str, List[str]]) -> str:
    """Code -> entite. Le premier variant du tableau fait foi (canonique)."""
    if not isinstance(text, str) or not text:
        return text
    entries = [(code, variants) for code, variants in reverse_mapping.items()
               if code and variants]
    if not entries:
        return text

    output = text
    for code, variants in sorted(entries, key=lambda e: len(e[0]), reverse=True):
        canonical = variants[0] if isinstance(variants, list) else variants
        if not canonical:
            continue
        pattern = BOUNDARY_BEFORE + re.escape(str(code)) + BOUNDARY_AFTER
        output = re.sub(pattern, str(canonical), output, flags=re.UNICODE)
    return output
