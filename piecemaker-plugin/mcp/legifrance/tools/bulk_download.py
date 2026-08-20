#/tools/bulk_download.py
#! MCP SERVEUR LOCAL
"""
Téléchargement en masse des résultats d'une requête Legifrance.

L'outil MCP `Download_Query_Results` pagine une requête jusqu'à récupérer tous
ses résultats (dans la limite d'un plafond), les écrit dans un dossier — un
fichier Markdown par décision, plus un index et le JSON brut — et rend le
CHEMIN du dossier au client appelant. Un agent bon marché peut ensuite lire ce
dossier au lieu de paginer lui-même. Le marqueur `.legifrance-results.json`
permet à tout client de reconnaître les résultats sans couplage à ce serveur.
"""

import json
import os
import re
import unicodedata
from datetime import datetime, timedelta

from tools.legifrance_client import legifrance_client
from tools.query_parser import parse_query

# Contrat de fichier public et stable pour les clients externes.
MARKER_NAME = ".legifrance-results.json"

PAGE_SIZE = 100         # maximum accepté par l'API PISTE
DEFAULT_MAX = 200       # plafond par défaut de décisions téléchargées
HARD_MAX = 500          # plafond absolu (cohérent avec la garde des Search_*)
SOLUTION_MAX = 50       # plafond d'enrichissements « solution » (1 appel API chacun)

# Corpus supportés : (fond, filtres de juridiction, base de lien Legifrance).
JURIDICTION_CONFIG = {
    "cassation": {
        "fond": "JURI",
        "filtres": [{"facette": "JURIDICTION_JUDICIAIRE", "valeurs": ["Cour de cassation"]}],
        "link_base": "https://www.legifrance.gouv.fr/juri/id/",
    },
    "appel": {
        "fond": "JURI",
        "filtres": [{"facette": "JURIDICTION_JUDICIAIRE", "valeurs": ["Juridictions d'appel"]}],
        "link_base": "https://www.legifrance.gouv.fr/juri/id/",
    },
    "premiere_instance": {
        "fond": "JURI",
        "filtres": [{"facette": "JURIDICTION_JUDICIAIRE", "valeurs": ["Juridictions du premier degré"]}],
        "link_base": "https://www.legifrance.gouv.fr/juri/id/",
    },
    "administratif": {  # Conseil d'État + cours administratives d'appel
        "fond": "CETAT",
        "filtres": [],
        "link_base": "https://www.legifrance.gouv.fr/ceta/id/",
    },
}


def slugify(value, max_length=50):
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return (text[:max_length].strip("-")) or "resultat"


def _extract_entry(r, link_base):
    """Réduit un résultat brut de l'API à ses champs utiles au tri."""
    titles = r.get("titles") or []
    titre = titles[0].get("title", "").strip() if titles else "Sans titre"
    juri_id = titles[0].get("id", "") if titles else ""
    lien = f"{link_base}{juri_id}" if juri_id else ""

    analyse = ""
    articles = []
    for section in r.get("sections") or []:
        for extract in section.get("extracts") or []:
            field = extract.get("searchFieldName", "")
            values = extract.get("values") or []
            if field in ("Abstrat", "Résumé principal") and values and not analyse:
                analyse = values[0].replace("<mark>", "").replace("</mark>", "").strip().strip("[...]").strip()
            elif field == "Texte appliqué" and values:
                for val in values:
                    clean = val.replace("<mark>", "").replace("</mark>", "").replace("[...]", "").strip()
                    if clean and clean not in articles:
                        articles.append(clean)
    if not analyse:
        text = r.get("text", "")
        if text:
            analyse = text.replace("<mark>", "").replace("</mark>", "").strip()

    return {
        "id": juri_id,
        "titre": titre,
        "lien": lien,
        "date": r.get("datePublication") or r.get("date") or "",
        "analyse": analyse,
        "articles": articles,
    }


# Ancres d'ouverture du DISPOSITIF (la solution), pour n'extraire que celle-ci et
# jamais les motifs. Deux seules ancres fiables, confirmées par recherche sur les
# trois ordres (civil/commercial, pénal, administratif) et les deux styles
# rédactionnels (ancien « Attendu/Considérant que » vs style direct post-2019) :
#   - judiciaire + pénal : « PAR CES MOTIFS »
#   - administratif       : « DÉCIDE : » (dont la variante espacée « D E C I D E : »)
# NB : « Attendu que » et « Considérant que » appartiennent aux MOTIFS et n'ancrent
# donc jamais le dispositif. Insensible à la casse et aux accents. On prend la
# PREMIÈRE occurrence — le bloc jusqu'à la fin capte toutes les branches du
# dispositif (pourvois/parties multiples).
DISPOSITIF_ANCHORS = re.compile(
    r"PAR\s+CES\s+MOTIFS"
    r"|D\s*[EÉ]\s*C\s*I\s*D\s*E\s*:",
    re.IGNORECASE,
)


def _extract_dispositif(texte, max_len=1200):
    """
    Renvoie l'extrait du texte à partir de la première ancre de dispositif
    rencontrée (motifs écartés), tronqué. Renvoie '' si aucune ancre.
    """
    if not texte:
        return ""
    match = DISPOSITIF_ANCHORS.search(texte)
    if not match:
        return ""
    return texte[match.start():].strip()[:max_len].strip()


def _fetch_solution(text_id):
    """
    Récupère UNIQUEMENT le dispositif/solution d'une décision (jamais les motifs) :
    nature (Rejet/Cassation/…), décision attaquée, et l'extrait de dispositif.
    Best-effort : renvoie None en cas d'échec.
    """
    if not text_id:
        return None
    try:
        result = legifrance_client.get_decision_text(text_id)
    except Exception:
        return None
    text = (result or {}).get("text", {}) or {}
    nature = text.get("nature", "") or ""
    da = text.get("decisionAttaquee", {}) or {}
    da_formation = da.get("formation", "") or ""
    da_date = ""
    raw_date = da.get("date")
    if isinstance(raw_date, (int, float)):
        from datetime import datetime as _dt
        try:
            da_date = _dt.fromtimestamp(raw_date / 1000).strftime("%d/%m/%Y")
        except Exception:
            da_date = ""
    dispositif = _extract_dispositif(text.get("texte", ""))
    if not (nature or dispositif or da_formation):
        return None
    return {
        "nature": nature,
        "decision_attaquee": {"formation": da_formation, "date": da_date},
        "dispositif": dispositif,
    }


def _entry_markdown(index, entry):
    lines = [f"# {index}. {entry['titre']}", ""]
    if entry["date"]:
        lines.append(f"- **Date** : {entry['date']}")
    if entry["id"]:
        lines.append(f"- **Identifiant** : {entry['id']}")
    if entry["lien"]:
        lines.append(f"- **Legifrance** : {entry['lien']}")
    if entry["articles"]:
        lines.append(f"- **Articles visés** : {', '.join(entry['articles'][:6])}")
    lines.append("")

    solution = entry.get("solution")
    if solution:
        lines.append("## Solution (dispositif — sans les motifs)")
        lines.append("")
        if solution.get("nature"):
            lines.append(f"- **Sens** : {solution['nature']}")
        da = solution.get("decision_attaquee") or {}
        if da.get("formation") or da.get("date"):
            lines.append(f"- **Décision attaquée** : {da.get('formation', '')} {da.get('date', '')}".rstrip())
        lines.append("")
        if solution.get("dispositif"):
            lines.append("```")
            lines.append(solution["dispositif"])
            lines.append("```")
            lines.append("")

    lines.append("## Analyse / sommaire")
    lines.append("")
    lines.append(entry["analyse"] or "_Pas de sommaire renvoyé par l'API — décision probablement inédite._")
    lines.append("")
    return "\n".join(lines)


def download_query_results(args):
    """
    Point d'entrée métier. Renvoie un dict :
      { folder, total, downloaded, truncated, juridiction, query }
    ou lève ValueError avec un message clair.
    """
    query = (args.get("query") or "").strip()
    if not query:
        raise ValueError("query requis")

    juridiction = (args.get("juridiction") or "cassation").strip().lower()
    config = JURIDICTION_CONFIG.get(juridiction)
    if not config:
        raise ValueError(
            f"juridiction inconnue : {juridiction}. "
            f"Valeurs : {', '.join(sorted(JURIDICTION_CONFIG))}"
        )

    max_results = min(int(args.get("max_results", DEFAULT_MAX) or DEFAULT_MAX), HARD_MAX)

    date_fin = args.get("date_fin") or datetime.now().strftime("%Y-%m-%d")
    date_debut = args.get("date_debut") or (datetime.now() - timedelta(days=5 * 365)).strftime("%Y-%m-%d")

    operateur_query, _type_recherche, criteres_parsed = parse_query(query)
    filtres = list(config["filtres"]) + [
        {"facette": "DATE_DECISION", "dates": {"start": date_debut, "end": date_fin}}
    ]

    # Pagination jusqu'au plafond.
    collected = []
    total = 0
    page = 1
    while len(collected) < max_results:
        result = legifrance_client.search_with_criteres(
            fond=config["fond"],
            criteres=criteres_parsed,
            operateur=operateur_query,
            filtres=filtres,
            type_champ="ALL",
            page_number=page,
            page_size=PAGE_SIZE,
            sort="PERTINENCE",
        )
        total = result.get("totalResultNumber", 0)
        batch = result.get("results", []) or []
        if not batch:
            break
        collected.extend(batch)
        if len(collected) >= total or len(batch) < PAGE_SIZE:
            break
        page += 1

    collected = collected[:max_results]
    entries = [_extract_entry(r, config["link_base"]) for r in collected]

    # Enrichissement optionnel : la solution/dispositif (rejet, cassation…), lue
    # côté serveur et réduite au seul dispositif — jamais les motifs. Un appel API
    # par décision, donc plafonné et à réserver à une liste déjà restreinte.
    include_solution = bool(args.get("include_solution", False))
    solution_enriched = 0
    if include_solution:
        for entry in entries[:SOLUTION_MAX]:
            if not entry.get("id"):
                continue
            solution = _fetch_solution(entry["id"])
            if solution:
                entry["solution"] = solution
                solution_enriched += 1

    # Écriture du dossier.
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    default_root = os.path.join(os.path.expanduser("~"), ".legifrance-mcp", "results")
    root = args.get("output_dir") or default_root
    folder = os.path.join(root, f"{timestamp}-{slugify(query)}")
    os.makedirs(folder, exist_ok=True)

    file_names = []
    index_lines = [
        f"# Résultats Legifrance — {juridiction}",
        "",
        f"- **Requête** : {query}",
        f"- **Période** : {date_debut} → {date_fin}",
        f"- **Total API** : {total}",
        f"- **Téléchargés** : {len(entries)}",
        "",
        "| # | Décision | Date | Fichier |",
        "| --- | --- | --- | --- |",
    ]
    for i, entry in enumerate(entries, 1):
        name = f"{i:03d}-{slugify(entry['titre'])}.md"
        with open(os.path.join(folder, name), "w", encoding="utf-8") as fh:
            fh.write(_entry_markdown(i, entry))
        file_names.append(name)
        titre_cell = entry["titre"].replace("|", "\\|")
        index_lines.append(f"| {i} | {titre_cell} | {entry['date']} | [{name}]({name}) |")

    with open(os.path.join(folder, "index.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(index_lines) + "\n")

    with open(os.path.join(folder, "results.json"), "w", encoding="utf-8") as fh:
        json.dump(entries, fh, ensure_ascii=False, indent=2)

    truncated = len(entries) < total
    marker = {
        "kind": "legifrance-results",
        "query": query,
        "juridiction": juridiction,
        "total": total,
        "downloaded": len(entries),
        "truncated": truncated,
        "solution_enriched": solution_enriched,
        "created": datetime.now().isoformat(timespec="seconds"),
        "files": ["index.md", "results.json"] + file_names,
    }
    with open(os.path.join(folder, MARKER_NAME), "w", encoding="utf-8") as fh:
        json.dump(marker, fh, ensure_ascii=False, indent=2)

    return {
        "folder": folder,
        "total": total,
        "downloaded": len(entries),
        "truncated": truncated,
        "solution_enriched": solution_enriched,
        "juridiction": juridiction,
        "query": query,
    }
