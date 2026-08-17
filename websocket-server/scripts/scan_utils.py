"""
Shared utilities for PII scanning scripts (presidio_scan.py, gliner2_presidio_scan.py).

Extracted from presidio_scan.py to avoid code duplication.
"""

import json
import os
import re
import sys
import unicodedata
import warnings
from datetime import datetime, timezone
from typing import Dict, List

# ---------------------------------------------------------------------------
# Ensure vendored presidio_analyzer is importable
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from presidio_analyzer import RecognizerResult  # noqa: E402
from presidio_analyzer.predefined_recognizers.generic.credit_card_recognizer import CreditCardRecognizer  # noqa: E402
from presidio_analyzer.predefined_recognizers.generic.crypto_recognizer import CryptoRecognizer  # noqa: E402
from presidio_analyzer.predefined_recognizers.generic.email_recognizer import EmailRecognizer  # noqa: E402
from presidio_analyzer.predefined_recognizers.generic.iban_recognizer import IbanRecognizer  # noqa: E402
from presidio_analyzer.predefined_recognizers.generic.ip_recognizer import IpRecognizer  # noqa: E402
from presidio_analyzer.predefined_recognizers.generic.mac_recognizer import MacAddressRecognizer  # noqa: E402
from presidio_analyzer.predefined_recognizers.generic.url_recognizer import UrlRecognizer  # noqa: E402

# ---------------------------------------------------------------------------
# Language detection (zero new dependencies)
# ---------------------------------------------------------------------------
_FR_STOPWORDS = frozenset([
    "le", "la", "les", "des", "du", "un", "une", "est", "sont", "dans",
    "pour", "avec", "sur", "par", "qui", "que", "aux", "cette", "ces",
    "nous", "vous", "ils", "elle", "mais", "ou", "donc", "soit",
])
_EN_STOPWORDS = frozenset([
    "the", "is", "are", "was", "were", "been", "being", "have", "has",
    "had", "does", "did", "will", "would", "could", "should", "may",
    "might", "shall", "can", "this", "that", "these", "those", "which",
])

_CORPORATE_SUFFIXES_RE = re.compile(
    r'\b(?:SELARL|SELAS|SELCA|SELCS|SASU|SARL|EURL|EARL|SCOP|SCIC|GAEC'
    r'|SAS|SCI|SCA|SCS|SCP|SCM|SNC|SCR|GIE|SLP|SEL|SEM|SA|SE'
    r'|EEIG|CIC|CIO|CLG|RTM|Ltd|Limited|PLC'
    r'|LLLP|PLLC|LLC|LLP|Inc|Corp|LP|GP|PC'
    r'|gGmbH|GmbH|KGaA|PartG|OHG|GbR|KG|AG|UG'
    r'|NV|BV|SpA|Srl|Lda|ApS)\b',
    re.IGNORECASE,
)


def detect_language(text: str, sample_size: int = 10000) -> str:
    """Detect document language (fr/en) using stop-word frequency."""
    sample = text[:sample_size].lower()
    words = set(re.findall(r'\b[a-zàâéèêëïîôùûüç]+\b', sample))
    fr_hits = len(words & _FR_STOPWORDS)
    en_hits = len(words & _EN_STOPWORDS)
    return 'fr' if fr_hits > en_hits else 'en'


# ---------------------------------------------------------------------------
# Entity text normalisation
# ---------------------------------------------------------------------------

_ZERO_WIDTH_RE = re.compile(r"[​‌‍﻿]")


def normalize_entity_text(text: str) -> str:
    """Canonical form of an entity string, used as the deduplication key.

    Conversion artefacts mean the same entity is written several ways — "Heights
    Capital", "Heights  Capital", "Heights\\nCapital". Keying on the raw substring
    makes those count as different entities and, downstream, gives the same company
    several anonymisation codes. Measured on GENSIGHT_URD before normalisation:
    1273 "distinct" entities collapsing to 971 once normalised.

    Offsets are never touched — only the string used for identity and mapping.
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    text = _ZERO_WIDTH_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


# ---------------------------------------------------------------------------
# Span arbitration
# ---------------------------------------------------------------------------

# Preference when two spans of different types cover the same characters. A name is
# more specific than the organisation it belongs to, which is more specific than the
# place it sits in.
_TYPE_PRIORITY = {
    "PERSON": 0,
    "ORGANIZATION": 1,
    "LOCATION": 2,
}


def _type_rank(entity_type: str) -> int:
    if entity_type in _TYPE_PRIORITY:
        return _TYPE_PRIORITY[entity_type]
    if entity_type.startswith("ORGANIZATION_"):
        return _TYPE_PRIORITY["ORGANIZATION"]
    return len(_TYPE_PRIORITY)


def resolve_overlapping_spans(results: List[RecognizerResult]) -> List[RecognizerResult]:
    """Keep one entity per stretch of text, whatever the types involved.

    ``EntityRecognizer.remove_duplicates`` only drops a contained span when the two
    results share an ``entity_type``. Cross-type overlaps therefore survive: measured
    on GENSIGHT_URD, 81 spans carried two types at once and 179 pairs overlapped —
    including LOCATION "French" nested inside ORGANIZATION "French Monetary and
    Financial Code". Since anonymisation substitutes entity strings one after the
    other, the inner span rewrites part of the outer one and corrupts the output.

    Resolution order: longest span wins, then highest score, then type priority.
    """
    ranked = sorted(
        (r for r in results if r.score > 0),
        key=lambda r: (-(r.end - r.start), -r.score, _type_rank(r.entity_type), r.start),
    )

    kept: List[RecognizerResult] = []
    for candidate in ranked:
        if any(candidate.start < k.end and k.start < candidate.end for k in kept):
            continue
        kept.append(candidate)

    return sorted(kept, key=lambda r: r.start)


# ---------------------------------------------------------------------------
# Legal form extraction
# ---------------------------------------------------------------------------
# Replaces the previous zero-shot classify_text call, which asked a 221-label
# classifier to guess an organisation's legal form from a +-180 character window.
# Measured on 25 real contexts from GENSIGHT_URD, that call cost 2 890 ms each
# (81 min for the document's 1 689 ORGANIZATION occurrences) and answered with forms
# like "Osakeyhtiö", "EIRELI", "No Liability" and "ANS" for French and American
# biotech companies — confident and wrong.
#
# A legal form is not a thing to infer: it is either written next to the name or it
# does not exist in the text. Measured on the same document, 11% of distinct
# organisation names carry one literally (63 of 576) and 89% carry none anywhere —
# for those the correct output is a plain ORGANIZATION, which is what the pipeline
# already falls back to. The proportion is document-type dependent and will be far
# higher on French filings ("URGOT SA", "CAITLYN SA") than on an English URD.

# (canonical token, regex alternatives, nationality) — longest/most specific first,
# so SASU wins over SAS, SARL over SA, SELARL over SARL, SCIC over SCI, LLLP over
# LLP over LP. `_LEGAL_FORM_RE` is a single ordered alternation of named groups and
# Python's `re` is leftmost/first-alternative (not longest-match): the token that
# codes an organisation (`ORGANIZATION_<token>` → code `<token>_1`) is the first
# entry in this list whose pattern matches at the earliest position, so a more
# specific sigle must appear before the shorter one it contains.
#
# Coverage requested: French forms (commercial, civil, libéral, coopératif,
# agricole), plus the foreign forms a French firm meets in its files — British,
# American and German especially. The regex is case-sensitive (no re.IGNORECASE),
# which is deliberate: it keeps two-letter sigles (SA, SE, AG, KG, PA, CO…) from
# matching lowercase words, since a legal form is written in its canonical case.
_LEGAL_FORMS = [
    # ── France — exercice libéral (before SARL / SAS / SEL) ──
    ("SELARL", r"S\.?E\.?L\.?A\.?R\.?L\.?",                   "French"),
    ("SELAS",  r"S\.?E\.?L\.?A\.?S\.?",                       "French"),
    ("SELCA",  r"S\.?E\.?L\.?C\.?A\.?",                       "French"),
    ("SELCS",  r"S\.?E\.?L\.?C\.?S\.?",                       "French"),
    # ── France — commercial / civil / coopératif / agricole ──
    ("SASU",  r"S\.?A\.?S\.?U\.?",                            "French"),
    ("SARL",  r"S\.?A\.?R\.?L\.?",                            "French"),
    ("EURL",  r"E\.?U\.?R\.?L\.?",                            "French"),
    ("EARL",  r"E\.?A\.?R\.?L\.?",                            "French"),
    ("SCOP",  r"S\.?C\.?O\.?P\.?",                            "French"),
    ("SCIC",  r"S\.?C\.?I\.?C\.?",                            "French"),
    ("GAEC",  r"G\.?A\.?E\.?C\.?",                            "French"),
    ("SAS",   r"S\.?A\.?S\.?",                                "French"),
    ("SCI",   r"S\.?C\.?I\.?",                                "French"),  # société civile immobilière
    ("SCA",   r"S\.?C\.?A\.?",                                "French"),
    ("SCS",   r"S\.?C\.?S\.?",                                "French"),
    ("SCP",   r"S\.?C\.?P\.?",                                "French"),
    ("SCM",   r"S\.?C\.?M\.?",                                "French"),
    ("SNC",   r"S\.?N\.?C\.?",                                "French"),
    ("GIE",   r"G\.?I\.?E\.?",                                "French"),
    ("SLP",   r"S\.?L\.?P\.?",                                "French"),
    ("SEL",   r"S\.?E\.?L\.?",                                "French"),
    ("SEM",   r"S\.?E\.?M\.?",                                "French"),
    # ── Royaume-Uni ──
    ("EEIG",  r"E\.?E\.?I\.?G\.?",                            "British"),
    ("CIC",   r"C\.?I\.?C\.?",                                "British"),
    ("CIO",   r"C\.?I\.?O\.?",                                "British"),
    ("CLG",   r"C\.?L\.?G\.?",                                "British"),
    ("RTM",   r"R\.?T\.?M\.?",                                "British"),
    ("PLC",   r"P\.?L\.?C\.?|Public\s+Limited\s+Company",     "British"),
    ("LTD",   r"Ltd\.?|Limited",                              "British"),
    # ── États-Unis (LLLP > LLP > LP ; PLLC > PLC/LLC) ──
    ("LLLP",  r"L\.?L\.?L\.?P\.?",                            "American"),
    ("PLLC",  r"P\.?L\.?L\.?C\.?",                            "American"),
    ("LLC",   r"L\.?L\.?C\.?|Limited\s+Liability\s+Company",  "American"),
    ("LLP",   r"L\.?L\.?P\.?",                                "American"),
    ("INC",   r"Inc\.?|Incorporated",                         "American"),
    ("CORP",  r"Corp\.?|Corporation",                         "American"),
    ("LP",    r"L\.?P\.?",                                    "American"),
    ("GP",    r"G\.?P\.?",                                    "American"),
    ("PC",    r"P\.?C\.?",                                    "American"),
    ("PA",    r"P\.?A\.?",                                    "American"),
    ("CO",    r"Co\.?|Company",                               "American"),
    # ── Allemagne (gGmbH before GmbH ; KGaA before KG) ──
    ("PARTG", r"PartG\s?mbB|PartGmbB|PartG",                  "German"),
    ("GMBH",  r"gGmbH|GmbH|Gesellschaft\s+mit\s+beschränkter\s+Haftung", "German"),
    ("KGAA",  r"KGaA",                                        "German"),
    ("OHG",   r"OHG",                                         "German"),
    ("GBR",   r"GbR",                                         "German"),
    ("KG",    r"KG",                                          "German"),
    ("AG",    r"AG|Aktiengesellschaft",                       "German"),
    ("UG",    r"UG\s*\(haftungsbeschränkt\)|UG",              "German"),
    ("EG",    r"eG",                                          "German"),
    ("EK",    r"e\.?K\.?",                                    "German"),
    # ── Autres formes européennes / internationales ──
    ("SE",    r"SE|Societas\s+Europaea",                      "Other"),
    ("SA",    r"S\.?A\.?|Société\s+Anonyme",                 "French"),
    ("BV",    r"B\.?V\.?",                                    "Dutch"),
    ("NV",    r"N\.?V\.?",                                    "Dutch"),
    ("SPA",   r"S\.?p\.?A\.?",                                "Italian"),
    ("SRL",   r"S\.?r\.?l\.?",                                "Italian"),
    ("SL",    r"S\.?L\.?",                                    "Spanish"),
    ("LDA",   r"Lda\.?",                                      "Portuguese"),
    ("AB",    r"AB",                                          "Swedish"),
    ("OY",    r"Oyj|Oy",                                      "Finnish"),
    ("APS",   r"ApS",                                         "Danish"),
    ("AS",    r"A/S|ASA|AS",                                  "Norwegian"),
    ("PTYLTD", r"Pty\.?\s+Ltd\.?",                            "Other"),
    ("PVTLTD", r"Pvt\.?\s+Ltd\.?",                            "Other"),
]

_LEGAL_FORM_RE = re.compile(
    r"(?<![\w'’-])(?:"
    + "|".join(f"(?P<{token}>{pattern})" for token, pattern, _ in _LEGAL_FORMS)
    + r")(?![\w'’-])"
)

_FORM_NATIONALITY = {token: nationality for token, _, nationality in _LEGAL_FORMS}

# Trailing characters inspected after the entity when the name itself carries no form
# ("la société Donchéry, SARL au capital de ...").
_LEGAL_FORM_LOOKAHEAD = 30


def extract_legal_form(entity_text: str, trailing_context: str = ""):
    """Return ``(form_token, nationality)`` read literally from the text.

    ``(None, None)`` when no legal form is written — which is the common case and
    means the entity stays a plain ORGANIZATION.
    """
    for candidate in (normalize_entity_text(entity_text),
                      normalize_entity_text(trailing_context)[:_LEGAL_FORM_LOOKAHEAD]):
        if not candidate:
            continue
        match = _LEGAL_FORM_RE.search(candidate)
        if match and match.lastgroup:
            return match.lastgroup, _FORM_NATIONALITY.get(match.lastgroup)
    return None, None


# ---------------------------------------------------------------------------
# NER score adjustment heuristics
# ---------------------------------------------------------------------------

def adjust_ner_scores(results: List[RecognizerResult], text: str) -> List[RecognizerResult]:
    """Adjust NER scores: penalize likely-false PERSON, rescue high-quality ORGANIZATION."""
    for r in results:
        entity_text = text[r.start:r.end]

        if r.entity_type == "PERSON":
            if len(entity_text) <= 2:
                r.score = 0.0
                continue
            if entity_text.isupper() and len(entity_text) > 3:
                r.score *= 0.3
            if ' ' not in entity_text.strip():
                r.score *= 0.6

        elif r.entity_type == "ORGANIZATION":
            if len(entity_text) <= 3:
                r.score = 0.0
                continue
            if entity_text.isupper():
                r.score = 0.0
                continue

            is_multi_word = ' ' in entity_text.strip()
            context_window = text[r.end:r.end + 30]
            has_suffix = bool(_CORPORATE_SUFFIXES_RE.search(context_window))

            if is_multi_word or has_suffix:
                r.score = 0.85

    return results


# ---------------------------------------------------------------------------
# Pattern recognizer factory
# ---------------------------------------------------------------------------

def build_pattern_recognizers() -> list:
    """Instantiate pattern-based recognizers (no NLP dependency)."""
    return [
        CreditCardRecognizer(),
        CryptoRecognizer(),
        EmailRecognizer(),
        IbanRecognizer(),
        IpRecognizer(),
        MacAddressRecognizer(),
        UrlRecognizer(),
    ]


# Words that make a dotted quad plausibly an actual address rather than a heading number.
_NETWORK_CONTEXT_RE = re.compile(
    r"\b(?:ip|adresse ip|address|serveur|server|host|hôte|réseau|network|dns|gateway"
    r"|passerelle|subnet|masque|port|ping|tcp|udp|localhost)\b",
    re.IGNORECASE,
)
_DOTTED_QUAD_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")

# A bare domain is only credible with a recognisable TLD; conversion glues sentences
# together ("…in 2023. The…" → "2023.Th") and those look like domains otherwise.
_PLAUSIBLE_TLD_RE = re.compile(
    r"\.(?:com|org|net|edu|gov|int|eu|fr|be|ch|lu|uk|de|es|it|nl|pt|ca|us|io|co|info"
    r"|biz|dev|app|ai|legal|law|gouv|europa)(?:$|[/:?#])",
    re.IGNORECASE,
)


def _is_plausible_ip(entity_text: str, text: str, start: int, end: int) -> bool:
    """Reject document section numbers matched as IPv4 addresses.

    Measured on GENSIGHT_URD: 31 of 31 distinct IP_ADDRESS hits were heading numbers
    ("3.7.2.2", "13.1.1.2", "19.1.5.2"). Anonymising those rewrites every cross
    reference in the document.

    Heuristic: a dotted quad whose every octet is <= 31 reads like a section number
    unless networking vocabulary sits nearby. This deliberately trades a rare true
    positive (private ranges such as 10.0.0.1 stated without context) for the far more
    common false positive in legal and financial documents.
    """
    if not _DOTTED_QUAD_RE.match(entity_text):
        return True

    octets = [int(o) for o in entity_text.split(".")]
    if any(o > 31 for o in octets):
        return True

    window = text[max(0, start - 60): min(len(text), end + 60)]
    return bool(_NETWORK_CONTEXT_RE.search(window))


def _is_plausible_url(entity_text: str) -> bool:
    """Reject sentence fragments glued into pseudo-domains ("2023.Th", "occur.Th")."""
    lowered = entity_text.lower()
    if lowered.startswith(("http://", "https://", "www.")):
        return True
    if "/" in entity_text:
        return True
    return bool(_PLAUSIBLE_TLD_RE.search(lowered))


def _pattern_result_is_plausible(result: RecognizerResult, text: str) -> bool:
    entity_text = text[result.start:result.end]
    if result.entity_type == "IP_ADDRESS":
        return _is_plausible_ip(entity_text, text, result.start, result.end)
    if result.entity_type == "URL":
        return _is_plausible_url(entity_text)
    return True


def run_pattern_recognizers(text: str, recognizers: list) -> List[RecognizerResult]:
    """Run all pattern recognizers on *text* and return combined results.

    Results are filtered for the false-positive classes these recognizers are known to
    produce on converted documents (see _is_plausible_ip / _is_plausible_url).
    """
    all_results: List[RecognizerResult] = []
    for rec in recognizers:
        try:
            results = rec.analyze(text, entities=rec.supported_entities, nlp_artifacts=None)
            all_results.extend(
                r for r in results if _pattern_result_is_plausible(r, text)
            )
        except Exception as exc:  # noqa: BLE001
            warnings.warn(f"[presidio] {rec.name} raised: {exc}", stacklevel=2)
    return all_results


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def build_output_payload(
    results: List[RecognizerResult],
    text: str,
    source_file: str,
    extra_summary: Dict = None,
) -> dict:
    """Build the JSON entity-map payload from a list of RecognizerResult."""
    entities_map: Dict[str, list] = {}
    for r in results:
        # The mapping is keyed by entity string downstream, so store the normalised
        # form — a raw substring carrying a hard line break would never match the
        # document again. Offsets stay as detected.
        entities_map.setdefault(r.entity_type, []).append({
            "text": normalize_entity_text(text[r.start:r.end]),
            "start": r.start,
            "end": r.end,
            "score": r.score,
            "recognizer": r.recognition_metadata.get("recognizer_name", "unknown")
            if r.recognition_metadata else "unknown",
        })

    summary = {
        "total_entities_found": len(results),
        "entity_types": list(entities_map.keys()),
    }
    if extra_summary:
        summary.update(extra_summary)

    return {
        "source_file": os.path.abspath(source_file),
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "entities": entities_map,
        "summary": summary,
    }


def print_summary(entities_map: dict, source_file: str, output_path: str) -> None:
    """Print a summary table to stdout."""
    total = sum(len(hits) for hits in entities_map.values())
    print(f"Scanned : {source_file}")
    print(f"Output  : {output_path}")
    print(f"{'Entity type':<25} {'Count':>5}")
    print("-" * 32)
    for etype, hits in sorted(entities_map.items()):
        print(f"{etype:<25} {len(hits):>5}")
    print("-" * 32)
    print(f"{'TOTAL':<25} {total:>5}")


# ---------------------------------------------------------------------------
# CLI validation
# ---------------------------------------------------------------------------

def validate_md_input(md_file: str) -> bool:
    """Validate that *md_file* is a readable .md file. Prints errors to stderr.

    Returns True if valid, False otherwise.
    """
    if not md_file.lower().endswith(".md"):
        print("ERROR: Le fichier doit être un fichier Markdown (.md)", file=sys.stderr)
        return False

    if not os.path.isfile(md_file):
        print(f"ERROR: Fichier non trouvé: {md_file}", file=sys.stderr)
        return False

    return True
