#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Corpus exhaustif et validation probatoire pour la recherche jurisprudentielle.

Ce module ne choisit jamais quelques résultats à la place du modèle. Il fige
les résultats de plusieurs requêtes, déduplique les identifiants Légifrance,
télécharge le texte intégral de chaque décision, puis prépare des lots bornés
en volume. Le modèle restitue ensuite une fiche JSON par décision ; la seconde
moitié de ce module contrôle mécaniquement leur couverture et leurs citations.

Il n'y a ni embeddings, ni base vectorielle, ni recherche top-k : toutes les
décisions du manifeste sont parcourues. Le classement lexical n'est qu'un
index de contrôle et ne retire aucune décision des lots.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import json
import math
import os
import re
import shutil
import time
import unicodedata
from typing import Any, Dict, Iterable, List, Optional, Tuple

from tools.bulk_download import JURIDICTION_CONFIG, MARKER_NAME, slugify
from tools.legifrance_client import legifrance_client
from tools.query_parser import parse_query


PAGE_SIZE = 100
DEFAULT_MAX_PER_QUERY = 500
HARD_MAX_PER_QUERY = 500
DEFAULT_MAX_DECISIONS = 1000
HARD_MAX_DECISIONS = 2000
DEFAULT_BATCH_TARGET_TOKENS = 60_000
HARD_BATCH_TARGET_TOKENS = 150_000
DEFAULT_BATCH_MAX_DECISIONS = 30
HARD_BATCH_MAX_DECISIONS = 100
DEFAULT_FETCH_WORKERS = 4
HARD_FETCH_WORKERS = 8
CONTEXT_RADIUS = 1_200
CANDIDATE_PROXIMITY = 300

TOKEN_ESTIMATION_METHOD = "ceil(nombre_de_caracteres_utf8_decodes/4)"

STOPWORDS = {
    "alors", "avec", "cette", "dans", "depuis", "des", "dont", "elle",
    "elles", "entre", "est", "leur", "leurs", "mais", "pour", "que",
    "quel", "quelle", "quelles", "quels", "sans", "sur", "une", "aux",
    "conditions", "condition", "societe", "societes", "dirigeant",
    "dirigeants", "decision", "decisions", "jurisprudence",
}

# Filtre booléen volontairement large et auditable. Il ne classe pas les
# décisions : il sépare seulement les incompatibilités lexicales certaines des
# textes qui doivent être lus par un modèle bon marché.
REVOCATION_RE = re.compile(r"\br[eé]vo(?:c|qu)\w*", re.IGNORECASE)
OFFICER_RE = re.compile(
    r"\b(?:administrateur|dirigeant|mandataire\s+social|directeur\s+g[eé]n[eé]ral|"
    r"pr[eé]sident(?:-directeur\s+g[eé]n[eé]ral|\s+du\s+conseil)?|"
    r"membre\s+du\s+directoire|directoire|conseil\s+de\s+surveillance)\w*",
    re.IGNORECASE,
)
SA_CONTEXT_RE = re.compile(
    r"soci[eé]t[eé]\s+anonyme|L\.?\s*225[-\s]|"
    r"loi\s+du\s+24\s+juillet\s+1966",
    re.IGNORECASE,
)
SA_ACRONYM_RE = re.compile(r"\bS\.?\s*A\.?\b")
def estimate_tokens(value: str) -> int:
    """Estimation stable et explicite ; jamais présentée comme usage API exact."""
    return int(math.ceil(len(value or "") / 4))


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", text).strip().lower()


def _query_terms(question: str, queries: Iterable[str]) -> List[str]:
    words = re.findall(r"[a-zA-ZÀ-ÿ0-9.-]{3,}", " ".join([question, *queries]))
    terms = []
    for word in words:
        normalized = _normalize(word).strip(".-")
        if len(normalized) < 4 or normalized in STOPWORDS or normalized in terms:
            continue
        terms.append(normalized)
    return terms


def _clean_queries(question: str, raw_queries: Any) -> List[str]:
    if isinstance(raw_queries, str):
        raw_queries = [raw_queries]
    values = raw_queries if isinstance(raw_queries, list) else []
    if not values and question:
        values = [question]
    queries = []
    for value in values:
        clean = re.sub(r"\s+", " ", str(value or "")).strip()
        if clean and clean not in queries:
            queries.append(clean)
    if not queries:
        raise ValueError("question ou queries requis")
    return queries


def _clean_jurisdictions(raw: Any) -> List[str]:
    if isinstance(raw, str):
        raw = [raw]
    values = raw if isinstance(raw, list) and raw else ["cassation"]
    jurisdictions = []
    for value in values:
        key = str(value or "").strip().lower()
        if key not in JURIDICTION_CONFIG:
            raise ValueError(
                f"juridiction inconnue : {key}. "
                f"Valeurs : {', '.join(sorted(JURIDICTION_CONFIG))}"
            )
        if key not in jurisdictions:
            jurisdictions.append(key)
    return jurisdictions


def _search_identity(result: Dict[str, Any]) -> Tuple[str, str]:
    titles = result.get("titles") or []
    first = titles[0] if titles else {}
    return str(first.get("id") or "").strip(), str(first.get("title") or "Sans titre").strip()


def _date_filter(date_debut: Optional[str], date_fin: Optional[str]) -> List[Dict[str, Any]]:
    if not date_debut and not date_fin:
        return []
    dates = {}
    if date_debut:
        dates["start"] = date_debut
    if date_fin:
        dates["end"] = date_fin
    return [{"facette": "DATE_DECISION", "dates": dates}]


def _search_query(
    client: Any,
    query: str,
    jurisdiction: str,
    date_debut: Optional[str],
    date_fin: Optional[str],
    max_results: int,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    config = JURIDICTION_CONFIG[jurisdiction]
    operator, _search_type, criteria = parse_query(query)
    filters = list(config["filtres"]) + _date_filter(date_debut, date_fin)
    collected: List[Dict[str, Any]] = []
    total = 0
    page = 1
    calls = 0

    while len(collected) < max_results:
        response = client.search_with_criteres(
            fond=config["fond"],
            criteres=criteria,
            operateur=operator,
            filtres=filters,
            type_champ="ALL",
            page_number=page,
            page_size=PAGE_SIZE,
            sort="PERTINENCE",
        )
        calls += 1
        total = int(response.get("totalResultNumber") or 0)
        batch = response.get("results") or []
        if not batch:
            break
        collected.extend(batch)
        if len(collected) >= total or len(batch) < PAGE_SIZE:
            break
        page += 1

    returned = collected[:max_results]
    return returned, {
        "query": query,
        "juridiction": jurisdiction,
        "total_api": total,
        "collectes": len(returned),
        "tronquee": len(returned) < total,
        "appels_recherche": calls,
    }


def _format_date(value: Any) -> str:
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value / 1000).strftime("%Y-%m-%d")
        except (OverflowError, OSError, ValueError):
            return ""
    text = str(value or "").strip()
    return text[:10] if text else ""


def _first_text(*values: Any) -> str:
    for value in values:
        if isinstance(value, list):
            for item in value:
                if str(item or "").strip():
                    return str(item).strip()
        elif str(value or "").strip():
            return str(value).strip()
    return ""


def _decision_record(seed: Dict[str, Any], response: Dict[str, Any]) -> Dict[str, Any]:
    text = (response or {}).get("text") or {}
    body = str(text.get("texte") or "").strip()
    number = _first_text(text.get("numeroAffaire"), text.get("num"), text.get("numeroPublicationBulletin"))
    publication = _first_text(text.get("typePublicationBulletin"), text.get("publicationRecueil"))
    summary = _first_text(text.get("sommaire"), text.get("resume"), seed.get("analyse"))
    title = _first_text(text.get("titre"), text.get("titreLong"), seed.get("titre"), seed.get("id"))
    source_base = JURIDICTION_CONFIG[seed["juridiction_source"]]["link_base"]

    return {
        "id": seed["id"],
        "titre": title,
        "juridiction": _first_text(text.get("juridiction"), text.get("natureJuridiction")),
        "formation": _first_text(text.get("formation"), text.get("juridictionJudiciaire")),
        "date": _format_date(text.get("dateTexte")),
        "numero": number,
        "ecli": _first_text(text.get("ecli")),
        "solution": _first_text(text.get("solution"), text.get("nature")),
        "publication": publication,
        "sommaire": summary,
        "texte": body,
        "lien": f"{source_base}{seed['id']}",
        "requêtes": seed["requêtes"],
        "juridictions_recherche": seed["juridictions_recherche"],
        "rang_min": seed["rang_min"],
        "caracteres": len(body),
        "tokens_texte_estimes": estimate_tokens(body),
    }


def _fetch_one(client: Any, seed: Dict[str, Any], retries: int = 3) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    error = None
    for attempt in range(retries):
        try:
            response = client.get_decision_text(seed["id"])
            record = _decision_record(seed, response)
            if not record["texte"]:
                raise ValueError("texte intégral vide")
            return record, None
        except Exception as exc:  # best-effort : l'erreur est conservée dans le manifeste
            error = str(exc)
            if attempt + 1 < retries:
                time.sleep(0.25 * (2 ** attempt))
    return None, error or "erreur inconnue"


def _score_decision(record: Dict[str, Any], terms: List[str]) -> Dict[str, Any]:
    normalized = _normalize(" ".join([record.get("sommaire", ""), record.get("texte", "")]))
    occurrences = {}
    for term in terms:
        count = normalized.count(term)
        if count:
            occurrences[term] = count
    score = round(sum(1 + math.log2(count) for count in occurrences.values()), 3)
    record["score_lexical"] = score
    record["termes_trouves"] = occurrences
    return record


def _paragraphs(body: str) -> List[str]:
    return [re.sub(r"\s+", " ", part).strip() for part in re.split(r"\n\s*\n|\r?\n", body or "") if part.strip()]


def _relevant_extracts(record: Dict[str, Any], max_extracts: int = 3) -> List[Dict[str, Any]]:
    terms = list((record.get("termes_trouves") or {}).keys())
    candidates = []
    for index, paragraph in enumerate(_paragraphs(record.get("texte", "")), 1):
        normalized = _normalize(paragraph)
        matches = [term for term in terms if term in normalized]
        if matches:
            candidates.append((len(matches), index, paragraph, matches))
    candidates.sort(key=lambda item: (-item[0], item[1]))
    return [
        {"paragraphe": index, "termes": matches, "texte": paragraph[:800]}
        for _count, index, paragraph, matches in candidates[:max_extracts]
    ]


def _candidate_spans(body: str) -> List[Tuple[int, int]]:
    revocations = list(REVOCATION_RE.finditer(body or ""))
    officers = list(OFFICER_RE.finditer(body or ""))
    spans = {
        (min(revocation.start(), officer.start()), max(revocation.end(), officer.end()))
        for revocation in revocations
        for officer in officers
        if abs(revocation.start() - officer.start()) <= CANDIDATE_PROXIMITY
    }
    return sorted(spans)


def _mapping_candidate(record: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Décide sans score si un texte nécessite une lecture sémantique."""
    body = record.get("texte", "")
    spans = _candidate_spans(body)
    checks = {
        "revocation": bool(REVOCATION_RE.search(body)),
        "fonction_dirigeante": bool(OFFICER_RE.search(body)),
        f"proximite_max_{CANDIDATE_PROXIMITY}_caracteres": bool(spans),
        "contexte_sa": bool(SA_CONTEXT_RE.search(body) or SA_ACRONYM_RE.search(body)),
    }
    return all(checks.values()), [name for name, matched in checks.items() if matched]


def _context_windows(body: str) -> List[Dict[str, Any]]:
    """Rend toutes les fenêtres de cooccurrence, fusionnées sans top-k."""
    intervals = [
        (max(0, start - CONTEXT_RADIUS), min(len(body), end + CONTEXT_RADIUS))
        for start, end in _candidate_spans(body)
    ]
    if not intervals:
        return []
    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return [
        {"debut": start, "fin": end, "texte": body[start:end]}
        for start, end in merged
    ]


def _candidate_markdown(position: int, record: Dict[str, Any]) -> str:
    """Paquet compact contenant chaque voisinage lexical pertinent."""
    lines = [
        f"# {position}. {record['titre']}",
        "",
        f"- **Identifiant** : {record['id']}",
        f"- **Date** : {record.get('date', '')}",
        f"- **Numéro** : {record.get('numero', '')}",
        f"- **Solution** : {record.get('solution', '')}",
        f"- **Légifrance** : {record.get('lien', '')}",
        f"- **Texte intégral local** : {record.get('fichier', '')}",
        "",
        "## Sommaire officiel",
        "",
        record.get("sommaire") or "_Absent._",
        "",
        "## Contextes déterministes exhaustifs",
        "",
    ]
    for index, window in enumerate(record.get("contextes_cartographie") or [], 1):
        lines.extend([
            f"### Contexte {index} — caractères {window['debut']}:{window['fin']}",
            "",
            window["texte"],
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def _static_non_candidate_card(record: Dict[str, Any]) -> Dict[str, Any]:
    """Fiche déterministe d'un texte incompatible avec le filtre large."""
    return {
        "id": record["id"],
        "pertinent": False,
        "question_juridique": "",
        "faits_determinants": [],
        "solution": record.get("solution", ""),
        "portee": "",
        "sens": "neutre",
        "citation_exacte": "",
        "incertitudes": [],
    }


def _decision_markdown(position: int, record: Dict[str, Any]) -> str:
    lines = [f"# {position}. {record['titre']}", ""]
    fields = [
        ("Identifiant", record.get("id")),
        ("Juridiction", record.get("juridiction")),
        ("Formation", record.get("formation")),
        ("Date", record.get("date")),
        ("Numéro", record.get("numero")),
        ("ECLI", record.get("ecli")),
        ("Solution", record.get("solution")),
        ("Publication", record.get("publication")),
        ("Légifrance", record.get("lien")),
        ("Tokens du texte estimés", record.get("tokens_texte_estimes")),
        ("Score lexical de contrôle", record.get("score_lexical")),
    ]
    for label, value in fields:
        if value not in (None, "", []):
            lines.append(f"- **{label}** : {value}")
    lines.extend(["", "## Sommaire officiel", "", record.get("sommaire") or "_Absent._", ""])
    lines.extend(["## Texte intégral", ""])
    for index, paragraph in enumerate(_paragraphs(record.get("texte", "")), 1):
        lines.append(f"[¶{index:04d}] {paragraph}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _batch_header(question: str) -> str:
    return f"""# Lot de cartographie jurisprudentielle exhaustive

## Question

{question}

## Consigne

Lire **chaque candidate** ci-dessous et produire exactement une ligne JSON par
décision. Les contextes contiennent toutes les fenêtres autour des ancres du
filtre booléen ; ce n'est ni un classement ni un top-k. En cas d'ambiguïté,
lire le fichier intégral indiqué. Ne jamais créer d'identifiant ni de citation.
`citation_exacte` doit reproduire une phrase décisive complète de la Cour, et
non l'en-tête, les seules prétentions d'une partie ou un fragment coupé. Une
décision non pertinente doit tout de même produire une fiche avec
`pertinent: false` et `citation_exacte: ""`.

Le simple fait qu'une partie soit une société anonyme ne suffit pas. La
question doit réellement concerner la révocation d'un administrateur, d'un
président/PCA/PDG, d'un directeur général/DGD ou d'un membre du directoire de
SA. Une SAS, SARL ou rupture de contrat de travail est hors champ, sauf
comparaison juridique explicite et utile.

Schéma minimal :

```json
{{"id":"JURITEXT…","pertinent":true,"question_juridique":"…","faits_determinants":["…"],"solution":"…","portee":"…","sens":"favorable|defavorable|neutre|procedural","citation_exacte":"citation littérale…","incertitudes":[]}}
```

## Décisions

"""


def _write_json(path: str, value: Any) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def _write_jsonl(path: str, values: Iterable[Dict[str, Any]]) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        for value in values:
            handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def build_research_corpus(args: Dict[str, Any], client: Any = None) -> Dict[str, Any]:
    """Construit le corpus complet, ses lots et sa télémétrie."""
    client = client or legifrance_client
    question = re.sub(r"\s+", " ", str(args.get("question") or "")).strip()
    queries = _clean_queries(question, args.get("queries"))
    if not question:
        question = queries[0]
    jurisdictions = _clean_jurisdictions(args.get("juridictions"))
    max_per_query = min(max(1, int(args.get("max_results_per_query") or DEFAULT_MAX_PER_QUERY)), HARD_MAX_PER_QUERY)
    max_decisions = min(max(1, int(args.get("max_decisions") or DEFAULT_MAX_DECISIONS)), HARD_MAX_DECISIONS)
    target_tokens = min(
        max(5_000, int(args.get("batch_target_tokens") or DEFAULT_BATCH_TARGET_TOKENS)),
        HARD_BATCH_TARGET_TOKENS,
    )
    max_batch_decisions = min(
        max(1, int(args.get("batch_max_decisions") or DEFAULT_BATCH_MAX_DECISIONS)),
        HARD_BATCH_MAX_DECISIONS,
    )
    workers = min(max(1, int(args.get("fetch_workers") or DEFAULT_FETCH_WORKERS)), HARD_FETCH_WORKERS)
    date_debut = args.get("date_debut") or None
    date_fin = args.get("date_fin") or None

    search_reports = []
    seeds: Dict[str, Dict[str, Any]] = {}
    global_truncated = False
    for query in queries:
        for jurisdiction in jurisdictions:
            results, report = _search_query(
                client, query, jurisdiction, date_debut, date_fin, max_per_query
            )
            search_reports.append(report)
            if report["tronquee"]:
                global_truncated = True
            for rank, result in enumerate(results, 1):
                text_id, title = _search_identity(result)
                if not text_id:
                    continue
                if text_id not in seeds and len(seeds) >= max_decisions:
                    global_truncated = True
                    continue
                seed = seeds.setdefault(text_id, {
                    "id": text_id,
                    "titre": title,
                    "analyse": "",
                    "requêtes": [],
                    "juridictions_recherche": [],
                    "juridiction_source": jurisdiction,
                    "rang_min": rank,
                })
                if query not in seed["requêtes"]:
                    seed["requêtes"].append(query)
                if jurisdiction not in seed["juridictions_recherche"]:
                    seed["juridictions_recherche"].append(jurisdiction)
                seed["rang_min"] = min(seed["rang_min"], rank)

    # Initialise le jeton avant le parallélisme lorsque le client réel expose
    # cette méthode. Les clients de test n'en ont pas besoin.
    if hasattr(client, "_get_token"):
        client._get_token()

    records = []
    failures = []
    seed_values = list(seeds.values())
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(_fetch_one, client, seed): seed for seed in seed_values}
        for future in as_completed(futures):
            seed = futures[future]
            record, error = future.result()
            if record:
                records.append(record)
            else:
                failures.append({"id": seed["id"], "erreur": error})

    order = {seed["id"]: index for index, seed in enumerate(seed_values)}
    terms = _query_terms(question, queries)
    records.sort(key=lambda record: order.get(record["id"], 10 ** 9))
    records = [_score_decision(record, terms) for record in records]
    for record in records:
        record["extraits_lexicaux"] = _relevant_extracts(record)
        candidate, reasons = _mapping_candidate(record)
        record["candidat_cartographie_modele"] = candidate
        record["criteres_filtre_trouves"] = reasons
        record["contextes_cartographie"] = _context_windows(record["texte"]) if candidate else []

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    default_root = os.path.join(os.path.expanduser("~"), ".legifrance-mcp", "research")
    root = os.path.abspath(args.get("output_dir") or default_root)
    folder = os.path.join(root, f"{timestamp}-{slugify(question)}")
    decisions_dir = os.path.join(folder, "decisions")
    batches_dir = os.path.join(folder, "batches")
    cards_dir = os.path.join(folder, "cards")
    os.makedirs(decisions_dir, exist_ok=False)
    os.makedirs(batches_dir, exist_ok=False)
    os.makedirs(cards_dir, exist_ok=False)

    files = []
    decision_paths = {}
    for position, record in enumerate(records, 1):
        name = f"{position:04d}-{slugify(record['titre'], max_length=70)}-{record['id']}.md"
        relative = os.path.join("decisions", name)
        with open(os.path.join(folder, relative), "w", encoding="utf-8") as handle:
            handle.write(_decision_markdown(position, record))
        files.append(relative)
        decision_paths[record["id"]] = relative
        record["fichier"] = relative

    static_cards = [
        _static_non_candidate_card(record)
        for record in records
        if not record["candidat_cartographie_modele"]
    ]
    if static_cards:
        static_cards_path = os.path.join(cards_dir, "static-non-candidates.jsonl")
        _write_jsonl(static_cards_path, static_cards)
        files.append(os.path.join("cards", "static-non-candidates.jsonl"))

    # Lots de toutes les candidates booléennes. Le texte n'est jamais retiré
    # en fonction d'un score ; celui-ci sert seulement à l'index de contrôle.
    batches = []
    current_records = []
    current_parts = []
    header = _batch_header(question)
    current_tokens = estimate_tokens(header)

    def flush_batch() -> None:
        nonlocal current_records, current_parts, current_tokens
        if not current_records:
            return
        number = len(batches) + 1
        name = f"lot-{number:03d}.md"
        content = header + "\n\n".join(current_parts).rstrip() + "\n"
        relative = os.path.join("batches", name)
        with open(os.path.join(folder, relative), "w", encoding="utf-8") as handle:
            handle.write(content)
        files.append(relative)
        batches.append({
            "lot": number,
            "fichier": relative,
            "sortie_attendue": os.path.join("cards", f"lot-{number:03d}.jsonl"),
            "decisions": [record["id"] for record in current_records],
            "nombre_decisions": len(current_records),
            "caracteres": len(content),
            "tokens_entree_estimes": estimate_tokens(content),
        })
        current_records = []
        current_parts = []
        current_tokens = estimate_tokens(header)

    candidates = [record for record in records if record["candidat_cartographie_modele"]]
    for position, record in enumerate(candidates, 1):
        part = _candidate_markdown(position, record)
        part_tokens = estimate_tokens(part)
        if current_records and (
            current_tokens + part_tokens > target_tokens
            or len(current_records) >= max_batch_decisions
        ):
            flush_batch()
        current_records.append(record)
        current_parts.append(part)
        current_tokens += part_tokens
    flush_batch()

    ranked = sorted(records, key=lambda record: (-record["score_lexical"], record["rang_min"], record["id"]))
    index_lines = [
        "# Index exhaustif — recherche jurisprudentielle",
        "",
        f"- **Question** : {question}",
        f"- **Décisions identifiées (dédupliquées)** : {len(seeds)}",
        f"- **Décisions dont le texte intégral a été téléchargé et scanné** : {len(records)}",
        f"- **Candidates revues par modèle** : {len(candidates)}",
        f"- **Hors champ fermées statiquement** : {len(static_cards)}",
        f"- **Échecs de téléchargement** : {len(failures)}",
        f"- **Lots de cartographie** : {len(batches)}",
        "- **Classement** : lexical, pour contrôle humain uniquement ; il ne modifie jamais le filtre booléen.",
        "",
        "| Rang contrôle | Score | Décision | Date | Solution | Fichier |",
        "| ---: | ---: | --- | --- | --- | --- |",
    ]
    for rank, record in enumerate(ranked, 1):
        title = str(record["titre"]).replace("|", "\\|")
        solution = str(record.get("solution") or "").replace("|", "\\|")
        index_lines.append(
            f"| {rank} | {record['score_lexical']} | {title} | {record.get('date', '')} | "
            f"{solution} | [{record['id']}]({record['fichier']}) |"
        )
    with open(os.path.join(folder, "index.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(index_lines) + "\n")
    files.append("index.md")

    _write_jsonl(os.path.join(folder, "decisions.jsonl"), records)
    files.append("decisions.jsonl")
    _write_json(os.path.join(folder, "batch-plan.json"), batches)
    files.append("batch-plan.json")

    telemetry = {
        "methode": "corpus exhaustif fixe, sans embeddings ni top-k",
        "estimation_tokens": TOKEN_ESTIMATION_METHOD,
        "requêtes": search_reports,
        "appels_api_recherche": sum(report["appels_recherche"] for report in search_reports),
        "decisions_identifiees_dedoublonnees": len(seeds),
        "decisions_texte_integral_telecharge": len(records),
        "decisions_scannees": len(records),
        "decisions_candidates_modele": len(candidates),
        "decisions_fermees_statiquement": len(static_cards),
        "filtre_candidature": {
            "operateur": "ET",
            "criteres": [
                "revocation", "fonction_dirigeante",
                f"distance_max_{CANDIDATE_PROXIMITY}_caracteres", "contexte_sa",
            ],
            "proximite_revocation_fonction": CANDIDATE_PROXIMITY,
            "fenetres": f"toutes les cooccurrences candidates ±{CONTEXT_RADIUS} caractères, intervalles fusionnés",
            "classement": False,
        },
        "echecs_texte_integral": len(failures),
        "caracteres_texte_integral": sum(record["caracteres"] for record in records),
        "tokens_texte_integral_estimes": sum(record["tokens_texte_estimes"] for record in records),
        "lots": len(batches),
        "decisions_max_par_lot": max_batch_decisions,
        "tokens_entree_cartographie_estimes": sum(batch["tokens_entree_estimes"] for batch in batches),
        "tokens_modele_exacts": None,
        "tronquee": global_truncated,
        "echecs": failures,
    }
    _write_json(os.path.join(folder, "telemetry.json"), telemetry)
    files.append("telemetry.json")

    marker = {
        "kind": "legifrance-research",
        "question": question,
        "queries": queries,
        "juridictions": jurisdictions,
        "date_debut": date_debut,
        "date_fin": date_fin,
        "created": datetime.now().isoformat(timespec="seconds"),
        "identified": len(seeds),
        "downloaded": len(records),
        "scanned": len(records),
        "failed": len(failures),
        "truncated": global_truncated,
        "files": ["index.md", "decisions.jsonl", "batch-plan.json", "telemetry.json", *files],
    }
    _write_json(os.path.join(folder, MARKER_NAME), marker)

    return {
        "folder": folder,
        "question": question,
        "queries": queries,
        "identified": len(seeds),
        "downloaded": len(records),
        "scanned": len(records),
        "failed": len(failures),
        "model_candidates": len(candidates),
        "static_closed": len(static_cards),
        "batches": len(batches),
        "batch_plan": os.path.join(folder, "batch-plan.json"),
        "index": os.path.join(folder, "index.md"),
        "telemetry": os.path.join(folder, "telemetry.json"),
        "tokens_input_estimated": telemetry["tokens_entree_cartographie_estimes"],
        "token_estimation_method": TOKEN_ESTIMATION_METHOD,
        "truncated": global_truncated,
    }


def _load_jsonl(path: str) -> List[Dict[str, Any]]:
    values = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"JSON invalide {path}:{line_number} : {exc}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"Fiche non objet {path}:{line_number}")
            values.append(value)
    return values


def _card_files(folder: str, explicit: Optional[str]) -> List[str]:
    if explicit:
        path = explicit if os.path.isabs(explicit) else os.path.join(folder, explicit)
        return [path]
    cards_dir = os.path.join(folder, "cards")
    return [
        os.path.join(cards_dir, name)
        for name in sorted(os.listdir(cards_dir))
        if name.endswith(".jsonl")
    ]


def rebuild_research_mapping(args: Dict[str, Any]) -> Dict[str, Any]:
    """Recrée les lots d'un corpus existant sans rappeler l'API officielle.

    Les anciens lots et fiches sont déplacés dans ``mapping-archives`` : cette
    opération est donc réversible et ne supprime aucune analyse antérieure.
    """
    folder = os.path.abspath(str(args.get("folder") or ""))
    marker_path = os.path.join(folder, MARKER_NAME)
    if not folder or not os.path.isdir(folder):
        raise ValueError("folder de recherche introuvable")
    try:
        with open(marker_path, "r", encoding="utf-8") as handle:
            marker = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("marqueur de recherche introuvable ou invalide") from exc
    if marker.get("kind") != "legifrance-research":
        raise ValueError("le dossier n'est pas un corpus de recherche exhaustive")

    records = _load_jsonl(os.path.join(folder, "decisions.jsonl"))
    question = str(marker.get("question") or "").strip()
    target_tokens = min(
        max(5_000, int(args.get("batch_target_tokens") or DEFAULT_BATCH_TARGET_TOKENS)),
        HARD_BATCH_TARGET_TOKENS,
    )
    max_batch_decisions = min(
        max(1, int(args.get("batch_max_decisions") or DEFAULT_BATCH_MAX_DECISIONS)),
        HARD_BATCH_MAX_DECISIONS,
    )
    for record in records:
        candidate, reasons = _mapping_candidate(record)
        record["candidat_cartographie_modele"] = candidate
        record["criteres_filtre_trouves"] = reasons
        record["contextes_cartographie"] = _context_windows(record["texte"]) if candidate else []

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    archive = os.path.join(folder, "mapping-archives", stamp)
    os.makedirs(archive, exist_ok=False)
    for name in ("batches", "cards"):
        path = os.path.join(folder, name)
        if os.path.exists(path):
            shutil.move(path, os.path.join(archive, name))
    for name in (
        "batch-plan.json", "cards-validated.jsonl", "metrics.json",
        "validation-errors.json", "analysis-matrix.md",
    ):
        path = os.path.join(folder, name)
        if os.path.exists(path):
            shutil.move(path, os.path.join(archive, name))

    batches_dir = os.path.join(folder, "batches")
    cards_dir = os.path.join(folder, "cards")
    os.makedirs(batches_dir, exist_ok=False)
    os.makedirs(cards_dir, exist_ok=False)
    static_cards = [
        _static_non_candidate_card(record)
        for record in records
        if not record["candidat_cartographie_modele"]
    ]
    if static_cards:
        _write_jsonl(os.path.join(cards_dir, "static-non-candidates.jsonl"), static_cards)

    header = _batch_header(question)
    batches = []
    current_records = []
    current_parts = []
    current_tokens = estimate_tokens(header)

    def flush_batch() -> None:
        nonlocal current_records, current_parts, current_tokens
        if not current_records:
            return
        number = len(batches) + 1
        name = f"lot-{number:03d}.md"
        content = header + "\n\n".join(current_parts).rstrip() + "\n"
        with open(os.path.join(batches_dir, name), "w", encoding="utf-8") as handle:
            handle.write(content)
        batches.append({
            "lot": number,
            "fichier": os.path.join("batches", name),
            "sortie_attendue": os.path.join("cards", f"lot-{number:03d}.jsonl"),
            "decisions": [record["id"] for record in current_records],
            "nombre_decisions": len(current_records),
            "caracteres": len(content),
            "tokens_entree_estimes": estimate_tokens(content),
        })
        current_records = []
        current_parts = []
        current_tokens = estimate_tokens(header)

    candidates = [record for record in records if record["candidat_cartographie_modele"]]
    for position, record in enumerate(candidates, 1):
        part = _candidate_markdown(position, record)
        part_tokens = estimate_tokens(part)
        if current_records and (
            current_tokens + part_tokens > target_tokens
            or len(current_records) >= max_batch_decisions
        ):
            flush_batch()
        current_records.append(record)
        current_parts.append(part)
        current_tokens += part_tokens
    flush_batch()

    _write_jsonl(os.path.join(folder, "decisions.jsonl"), records)
    _write_json(os.path.join(folder, "batch-plan.json"), batches)
    with open(os.path.join(folder, "telemetry.json"), "r", encoding="utf-8") as handle:
        telemetry = json.load(handle)
    telemetry.update({
        "methode": "scan statique exhaustif + revue de toutes les candidates, sans RAG ni top-k",
        "decisions_candidates_modele": len(candidates),
        "decisions_fermees_statiquement": len(static_cards),
        "filtre_candidature": {
            "operateur": "ET",
            "criteres": [
                "revocation", "fonction_dirigeante",
                f"distance_max_{CANDIDATE_PROXIMITY}_caracteres", "contexte_sa",
            ],
            "proximite_revocation_fonction": CANDIDATE_PROXIMITY,
            "fenetres": f"toutes les cooccurrences candidates ±{CONTEXT_RADIUS} caractères, intervalles fusionnés",
            "classement": False,
        },
        "lots": len(batches),
        "decisions_max_par_lot": max_batch_decisions,
        "tokens_entree_cartographie_estimes": sum(
            batch["tokens_entree_estimes"] for batch in batches
        ),
        "tokens_modele_exacts": None,
        "mapping_archive": archive,
        "mapping_reconstruit": datetime.now().isoformat(timespec="seconds"),
    })
    _write_json(os.path.join(folder, "telemetry.json"), telemetry)
    marker["mapping_archive"] = archive
    marker["mapping_reconstruit"] = telemetry["mapping_reconstruit"]
    _write_json(marker_path, marker)

    return {
        "folder": folder,
        "archive": archive,
        "scanned": len(records),
        "model_candidates": len(candidates),
        "static_closed": len(static_cards),
        "batches": len(batches),
        "tokens_input_estimated": telemetry["tokens_entree_cartographie_estimes"],
        "token_estimation_method": TOKEN_ESTIMATION_METHOD,
    }


def _find_quote(body: str, quote: str) -> Optional[int]:
    """Retourne la position d'une citation littérale, sans normalisation tolérante."""
    if not quote:
        return None
    return body.find(quote)


def _quote_quality_errors(body: str, quote: str, position: int) -> List[str]:
    """Détecte mécaniquement les fragments impropres à une preuve juridique."""
    errors = []
    end = position + len(quote)
    if len(quote) < 60:
        errors.append("citation trop courte pour établir une règle ou un motif")
    if position > 0 and body[position - 1].isalnum() and quote[0].isalnum():
        errors.append("citation commençant au milieu d'un mot")
    if end < len(body) and body[end].isalnum() and quote[-1].isalnum():
        errors.append("citation finissant au milieu d'un mot")
    if quote[-1:] not in {".", ";", ":", "!", "?", "»", "”", '"'}:
        errors.append("citation coupée avant sa ponctuation finale")
    normalized = _normalize(quote)
    first_letter = re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ]", quote)
    if first_letter and first_letter.group(0).islower():
        errors.append("citation commençant au milieu d'une phrase")
    if "a rendu l'arret suivant" in normalized:
        errors.append("en-tête de décision utilisé comme citation")
    if re.match(r"^(?:\d+°/\s*)?(?:alors|aux motifs)\b", normalized):
        errors.append("prétention ou moyen de partie utilisé seul comme citation")
    if re.match(
        r"^(?:attendu,?\s+selon|soutenant|le moyen fait grief|"
        r"il est fait grief|reproche a l'arret)\b",
        normalized,
    ):
        errors.append("faits introductifs ou prétention utilisés comme citation")
    if normalized.startswith("attendu que") and "fait grief" in normalized[:320]:
        errors.append("exposé du moyen utilisé comme citation")
    if re.match(r"^(?:ainsi fait et juge|par ces motifs)\b", normalized):
        errors.append("formule de dispositif ou de clôture utilisée comme citation")
    return errors


def _card_schema_errors(card: Dict[str, Any], text_id: str) -> List[Dict[str, Any]]:
    """Contrôle le contrat minimal produit par le cartographe bon marché."""
    errors = []
    expected_types = {
        "pertinent": bool,
        "question_juridique": str,
        "faits_determinants": list,
        "solution": str,
        "portee": str,
        "sens": str,
        "citation_exacte": str,
        "incertitudes": list,
    }
    for field, expected_type in expected_types.items():
        if not isinstance(card.get(field), expected_type):
            errors.append({
                "id": text_id,
                "champ": field,
                "raison": f"type attendu : {expected_type.__name__}",
            })
    if isinstance(card.get("sens"), str) and card["sens"] not in {
        "favorable", "defavorable", "neutre", "procedural",
    }:
        errors.append({
            "id": text_id,
            "champ": "sens",
            "raison": "valeur hors enum",
        })
    return errors


def validate_research_cards(args: Dict[str, Any]) -> Dict[str, Any]:
    """Valide la couverture des fiches et l'existence de chaque citation."""
    folder = os.path.abspath(str(args.get("folder") or ""))
    if not folder or not os.path.isdir(folder):
        raise ValueError("folder de recherche introuvable")
    marker_path = os.path.join(folder, MARKER_NAME)
    try:
        with open(marker_path, "r", encoding="utf-8") as handle:
            marker = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("marqueur de recherche introuvable ou invalide") from exc
    if marker.get("kind") != "legifrance-research":
        raise ValueError("le dossier n'est pas un corpus de recherche exhaustive")

    decisions = _load_jsonl(os.path.join(folder, "decisions.jsonl"))
    decision_by_id = {record["id"]: record for record in decisions}
    paths = _card_files(folder, args.get("cards_file"))
    if not paths:
        raise ValueError("aucun fichier cards/*.jsonl trouvé")

    cards = []
    model_cards = []
    parse_errors = []
    for path in paths:
        try:
            loaded_cards = _load_jsonl(path)
            cards.extend(loaded_cards)
            if os.path.basename(path) != "static-non-candidates.jsonl":
                model_cards.extend(loaded_cards)
        except (OSError, ValueError) as exc:
            parse_errors.append(str(exc))

    seen = set()
    duplicates = []
    unknown = []
    schema_errors = []
    unsupported_relevant = []
    invalid_quotes = []
    quote_quality_errors = []
    valid_cards = []
    for card in cards:
        text_id = str(card.get("id") or "").strip()
        if not text_id or text_id not in decision_by_id:
            unknown.append(text_id or "<sans identifiant>")
            continue
        if text_id in seen:
            duplicates.append(text_id)
            continue
        seen.add(text_id)
        record = decision_by_id[text_id]
        card_schema_errors = _card_schema_errors(card, text_id)
        schema_errors.extend(card_schema_errors)
        quote = str(card.get("citation_exacte") or "").strip()
        position = _find_quote(record["texte"], quote)
        quote_valid = bool(quote) and position is not None and position >= 0
        quote_invalid = bool(quote) and not quote_valid
        if quote_invalid:
            invalid_quotes.append({"id": text_id, "texte": quote[:160]})
        quality_reasons = (
            _quote_quality_errors(record["texte"], quote, position)
            if quote_valid else []
        )
        if quality_reasons:
            quote_quality_errors.append({"id": text_id, "raisons": quality_reasons})
        relevant_without_quote = card.get("pertinent") is True and not quote_valid
        if relevant_without_quote:
            unsupported_relevant.append(text_id)
        validated = dict(card)
        validated["citation_exacte"] = quote if quote_valid else ""
        validated["position_citation"] = position if quote_valid else None
        validated["citation_valide"] = quote_valid
        validated["lien"] = record["lien"]
        validated["date"] = record["date"]
        validated["juridiction"] = record["juridiction"]
        validated["numero"] = record["numero"]
        validated["score_lexical"] = record["score_lexical"]
        if (
            not card_schema_errors
            and not quote_invalid
            and not quality_reasons
            and not relevant_without_quote
        ):
            valid_cards.append(validated)

    missing = sorted(set(decision_by_id) - seen)
    def card_tokens(card: Dict[str, Any]) -> int:
        return estimate_tokens(json.dumps(
            card, ensure_ascii=False, separators=(",", ":")
        ))

    output_tokens_estimated = sum(card_tokens(card) for card in cards)
    model_output_tokens_estimated = sum(card_tokens(card) for card in model_cards)
    with open(os.path.join(folder, "telemetry.json"), "r", encoding="utf-8") as handle:
        telemetry = json.load(handle)

    usage = args.get("usage") if isinstance(args.get("usage"), dict) else {}
    exact_usage = {
        key: int(usage.get(key) or 0)
        for key in (
            "input_tokens", "output_tokens", "reasoning_tokens",
            "cache_read_input_tokens", "cache_creation_input_tokens",
        )
    } if usage else None

    metrics = {
        **telemetry,
        "fiches_recues": len(cards),
        "fiches_valides_uniques": len(valid_cards),
        "fiches_manquantes": len(missing),
        "identifiants_inconnus": len(unknown),
        "doublons": len(duplicates),
        "erreurs_schema": len(schema_errors),
        "fiches_pertinentes_sans_citation": len(unsupported_relevant),
        "citations_invalides": len(invalid_quotes),
        "citations_faible_qualite": len(quote_quality_errors),
        "tokens_sortie_fiches_estimes": output_tokens_estimated,
        "tokens_sortie_modele_estimes": model_output_tokens_estimated,
        "tokens_modele_exacts": exact_usage,
        "usage_exact_fourni": bool(exact_usage),
        "couverture_complete": (
            not missing and not unknown and not duplicates
            and not schema_errors and not unsupported_relevant
            and not invalid_quotes and not quote_quality_errors and not parse_errors
        ),
    }

    _write_jsonl(os.path.join(folder, "cards-validated.jsonl"), valid_cards)
    _write_json(os.path.join(folder, "metrics.json"), metrics)
    _write_json(os.path.join(folder, "validation-errors.json"), {
        "fiches_manquantes": missing,
        "identifiants_inconnus": unknown,
        "doublons": duplicates,
        "erreurs_schema": schema_errors,
        "fiches_pertinentes_sans_citation": unsupported_relevant,
        "citations_invalides": invalid_quotes,
        "citations_faible_qualite": quote_quality_errors,
        "erreurs_lecture": parse_errors,
    })

    sorted_cards = sorted(
        valid_cards,
        key=lambda card: (not bool(card.get("pertinent")), -float(card.get("score_lexical") or 0), card["id"]),
    )
    lines = [
        "# Matrice d'analyse jurisprudentielle validée",
        "",
        f"- **Décisions scannées** : {telemetry['decisions_scannees']}",
        f"- **Fiches reçues** : {len(cards)}",
        f"- **Couverture** : {len(seen & set(decision_by_id))}/{len(decision_by_id)}",
        f"- **Citations rejetées** : {len(invalid_quotes)}",
        f"- **Tokens d'entrée estimés** : {telemetry['tokens_entree_cartographie_estimes']}",
        f"- **Tokens de sortie modèle estimés** : {model_output_tokens_estimated}",
        f"- **Tokens de toutes les fiches estimés** : {output_tokens_estimated}",
        f"- **Usage modèle exact fourni** : {'oui' if exact_usage else 'non'}",
        "",
    ]
    for card in sorted_cards:
        lines.extend([
            f"## {card['id']} — {'pertinente' if card.get('pertinent') else 'non pertinente'}",
            "",
            f"- **Juridiction / date / numéro** : {card.get('juridiction', '')} — {card.get('date', '')} — {card.get('numero', '')}",
            f"- **Question** : {card.get('question_juridique', '')}",
            f"- **Solution** : {card.get('solution', '')}",
            f"- **Portée** : {card.get('portee', '')}",
            f"- **Sens** : {card.get('sens', '')}",
            f"- **Lien** : {card.get('lien', '')}",
            "",
        ])
        if card.get("citation_exacte"):
            lines.append(f"> {card['citation_exacte']}")
            lines.append("")
    with open(os.path.join(folder, "analysis-matrix.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines).rstrip() + "\n")

    return {
        "folder": folder,
        "matrix": os.path.join(folder, "analysis-matrix.md"),
        "metrics": os.path.join(folder, "metrics.json"),
        "cards": len(cards),
        "valid_cards": len(valid_cards),
        "missing": len(missing),
        "invalid_quotes": len(invalid_quotes),
        "weak_quotes": len(quote_quality_errors),
        "coverage_complete": metrics["couverture_complete"],
        "tokens_input_estimated": telemetry["tokens_entree_cartographie_estimes"],
        "tokens_output_estimated": model_output_tokens_estimated,
        "tokens_all_cards_estimated": output_tokens_estimated,
        "exact_usage": exact_usage,
    }
