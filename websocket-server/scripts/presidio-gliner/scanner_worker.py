#!/usr/bin/env python3
"""
Long-lived scanner worker — loads GLiNER2.5 + spaCy once, processes multiple files
via a JSON-line stdin/stdout protocol.

Protocol:
    → stdin:  {"cmd": "scan", "md_file": "...", "output_dir": "..."}
    ← stdout: {"status": "ok", "json_path": "..."}

    → stdin:  {"cmd": "quit"}
    ← stdout: {"status": "bye"}

Startup:
    ← stdout: READY

Launched by convert_and_scan_pipeline.py at the beginning of the pipeline so that
model loading overlaps with Phase 1 (document conversion).
"""

import contextlib
import json
import os
import sys
import warnings
from collections import defaultdict
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# Heavy imports — these are the expensive ones (~30-60s)
# ---------------------------------------------------------------------------
from presidio_analyzer import (
    AnalysisExplanation,
    AnalyzerEngine,
    LocalRecognizer,
    RecognizerResult,
)
from presidio_analyzer.nlp_engine import NlpArtifacts, NlpEngineProvider

try:
    from gliner2 import AutoExtractor
    GLINER2_AVAILABLE = True
except ImportError:
    GLINER2_AVAILABLE = False

from model_config import PREFERRED_GLINER_MODEL

# ---------------------------------------------------------------------------
# Import scan_utils via the same path trick as presidio-gliner.py
# ---------------------------------------------------------------------------
_PARENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PARENT_DIR)

_real_presidio_mods = {
    k: sys.modules.pop(k)
    for k in list(sys.modules)
    if k.startswith("presidio_analyzer")
}

from scan_utils import (  # noqa: E402
    build_output_payload,
    build_pattern_recognizers,
    detect_language,
    extract_legal_form,
    normalize_entity_text,
    print_summary,
    resolve_overlapping_spans,
    run_pattern_recognizers,
    validate_md_input,
)

sys.modules.update(_real_presidio_mods)

# Lives next to this file, not in the scripts/ directory added above.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import coreml_runtime  # noqa: E402

# ---------------------------------------------------------------------------
# Thread count — measured on the target hardware (Apple M1, 8 cores):
# 4 threads (torch's default) 23.0 min for a 972-chunk document, 6 threads 18.8 min,
# 8 threads 23.4 min (the efficiency cores drag the batch down). MPS was measured at
# 29.6 min, i.e. slower than CPU, and is deliberately not used.
# ---------------------------------------------------------------------------
try:
    import torch

    torch.set_num_threads(int(os.environ.get("PIECEMAKER_TORCH_THREADS", "6")))
except ImportError:  # pragma: no cover - torch ships with gliner2
    pass

# Logging every detected entity writes the document's PII in clear text to stderr,
# which the Electron parent captures (~3 200 lines for a single URD). Off by default.
DEBUG_ENTITIES = os.environ.get("PIECEMAKER_DEBUG_ENTITIES", "").lower() in ("1", "true", "yes")

# ---------------------------------------------------------------------------
# Constants (must match presidio-gliner.py)
# ---------------------------------------------------------------------------
GLINER_MODEL = PREFERRED_GLINER_MODEL

ENTITY_MAPPING = {
    "person":       "PERSON",
    "company":      "ORGANIZATION",
    "organization": "ORGANIZATION",
    "location":     "LOCATION",
}

ENTITY_DESCRIPTIONS = {
    # Wording measured against the reference corpus: spelling out what each label
    # EXCLUDES raises precision from 0.485 to 0.648 at equal (perfect) recall and
    # nearly halves the number of words a false positive would rewrite. The previous
    # one-line descriptions left the exclusions implicit and the model read job titles
    # as people, generic bodies as organisations and nationalities as places.
    "person": (
        "Full name of a specific individual human being, such as Bernard Gilly or "
        "Mrs Laurence Rodriguez. Never a job title, never a role, never an acronym, "
        "never a gene or a product name"
    ),
    "company": (
        "Name of a specific named commercial company, such as Novartis or Sofinnova "
        "Partners SAS. Never a generic word like company, group or shareholders"
    ),
    "organization": (
        "Name of a specific named institution, agency or regulator, such as FDA, "
        "EMA or Inserm. Never a generic body such as board of directors, "
        "committee or working group"
    ),
    "location": (
        "Name of a specific geographic place: a country, a city, a region or a postal "
        "address. Never a nationality adjective such as French or European, never an "
        "anatomical part"
    ),
}

# GLiNER2.5 has a different boundary head and its scores are not calibrated like
# those of the former span checkpoint. Start from Fastino's documented default;
# anonymisation favours recall, and the mapping remains reviewable for false positives.
GLINER_THRESHOLD = 0.5

# The legal form of an organisation is read literally from the text by
# scan_utils.extract_legal_form. The previous 221-label zero-shot schema and its
# per-occurrence classify_text call are gone: measured at 2 890 ms per call on real
# contexts (81 min for this document's 1 689 ORGANIZATION mentions) and answering
# "Osakeyhtio", "EIRELI" or "No Liability" for French and American companies.

CHUNK_SIZE = 250
CHUNK_OVERLAP = 50
BATCH_SIZE = 8

# ---------------------------------------------------------------------------
# Document-level metadata (nature / date / juridiction) — GLiNER2 schema tasks
# ---------------------------------------------------------------------------
# Unlike PII entity extraction (which runs over every chunk of the whole file),
# the document's own nature and date live in its opening — a header slice is
# enough and keeps this to a single sub-second forward pass. The 2019-era 30/221
# label per-occurrence classify_text schema was removed for being 81 min on a
# large file; called ONCE, on a bounded header, GLiNER2 classification is cheap.
# Everything here is best-effort: any failure leaves document_meta empty and the
# PII scan (the only thing that gates anonymisation) is never affected.
DOC_META_ENABLED = os.environ.get("PIECEMAKER_DOC_META", "1").lower() not in ("0", "false", "no")
DOC_META_HEADER_WORDS = int(os.environ.get("PIECEMAKER_DOC_META_WORDS", "400"))

NATURE_LABELS = [
    "assignation", "conclusions", "requête", "courrier", "courriel",
    "mise en demeure", "contrat", "facture", "devis", "attestation",
    "jugement", "arrêt", "ordonnance", "procès-verbal", "constat",
    "expertise", "statuts de société", "extrait Kbis", "relevé bancaire",
    "acte notarié", "bordereau de pièces", "autre",
]

_FR_MONTHS = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4,
    "mai": 5, "juin": 6, "juillet": 7, "août": 8, "aout": 8,
    "septembre": 9, "octobre": 10, "novembre": 11,
    "décembre": 12, "decembre": 12,
}


def normalize_document_date(raw: Optional[str]) -> Optional[str]:
    """Return an ISO ``YYYY-MM-DD`` string for a French date, or None.

    Handles the two forms a legal document uses — "14 mars 2023" and the numeric
    "14/03/2023" / "14-03-2023" / "14.03.2023". A date that parses to ISO is what
    lets the chronology sort documents; the raw span is kept alongside it for
    display and for the (common) case where only a year or a partial date exists.
    """
    if not raw:
        return None
    text = str(raw).strip().lower()
    # Already-ISO forms are the most common thing GLiNER returns ("2023-05-15",
    # "2023/05/15"); test the unambiguous year-first shape before the day-first
    # numeric one, which would otherwise never match it (\d{1,2} can't eat 2023).
    iso = re.search(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b", text)
    if iso:
        year, month, day = int(iso.group(1)), int(iso.group(2)), int(iso.group(3))
        if 1 <= month <= 12 and 1 <= day <= 31:
            return f"{year:04d}-{month:02d}-{day:02d}"
    worded = re.search(r"(\d{1,2})\s+([a-zàâäéèêëîïôöûüç]+)\.?\s+(\d{4})", text)
    if worded:
        day, month_name, year = worded.group(1), worded.group(2), worded.group(3)
        month = _FR_MONTHS.get(month_name)
        if month and 1 <= int(day) <= 31:
            return f"{int(year):04d}-{month:02d}-{int(day):02d}"
    numeric = re.search(r"\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b", text)
    if numeric:
        day, month, year = int(numeric.group(1)), int(numeric.group(2)), int(numeric.group(3))
        if year < 100:
            year += 2000
        if 1 <= month <= 12 and 1 <= day <= 31:
            return f"{year:04d}-{month:02d}-{day:02d}"
    return None


def _document_header(text: str, max_words: int = DOC_META_HEADER_WORDS) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words])


def extract_document_meta(text: str) -> Dict:
    """Classify the document's nature and pull its date + juridiction.

    One classify_text call (single-label nature) and one extract_json call (a
    header record: date + court) on the document header, via the already-loaded
    GLiNER2 model. Never raises: a model without these heads, a CoreML-swapped
    encoder that rejects the call, or an empty header all return the neutral
    shape so the scan payload is always well-formed.
    """
    meta = {
        "nature": None, "nature_confidence": None,
        "doc_date": None, "doc_date_iso": None, "juridiction": None,
    }
    if not DOC_META_ENABLED or _gliner_model is None:
        return meta
    header = _document_header(text)
    if not header.strip():
        return meta
    try:
        classified = _gliner_model.classify_text(
            header, {"nature_document": NATURE_LABELS},
            threshold=0.3, include_confidence=True,
        )
        nature = classified.get("nature_document")
        if isinstance(nature, dict):
            meta["nature"] = nature.get("label")
            confidence = nature.get("confidence")
            if isinstance(confidence, (int, float)):
                meta["nature_confidence"] = round(float(confidence), 3)
        elif isinstance(nature, str):
            meta["nature"] = nature
    except Exception as exc:  # noqa: BLE001
        _log(f"document nature classification skipped: {exc}")
    try:
        record = _gliner_model.extract_json(
            header,
            {"acte": {
                "date_acte": "date de l'acte ou du document",
                "juridiction": "nom du tribunal ou de la juridiction saisie",
            }},
            threshold=0.3,
        )
        items = record.get("acte") or []
        if items and isinstance(items[0], dict):
            dates = items[0].get("date_acte") or []
            courts = items[0].get("juridiction") or []
            if dates:
                raw_date = str(dates[0]).strip().replace("\n", " ")
                meta["doc_date"] = raw_date
                meta["doc_date_iso"] = normalize_document_date(raw_date)
            if courts:
                meta["juridiction"] = str(courts[0]).strip().replace("\n", " ")
    except Exception as exc:  # noqa: BLE001
        _log(f"document header record skipped: {exc}")
    return meta

# ---------------------------------------------------------------------------
# Chunking (copied from presidio-gliner.py)
# ---------------------------------------------------------------------------
import re

def chunk_text_by_words(text: str, max_words: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[Dict]:
    word_spans = [(m.start(), m.end()) for m in re.finditer(r"\S+", text)]
    if not word_spans:
        return []
    step = max(1, max_words - overlap)
    chunks = []
    for i in range(0, len(word_spans), step):
        span_group = word_spans[i : i + max_words]
        start_char = span_group[0][0]
        end_char = span_group[-1][1]
        chunks.append({"text": text[start_char:end_char], "start_char": start_char, "end_char": end_char})
        if i + max_words >= len(word_spans):
            break
    return chunks

# ---------------------------------------------------------------------------
# GLiNER2 Recognizer (copied from presidio-gliner.py)
# ---------------------------------------------------------------------------

class GLiNER2Recognizer(LocalRecognizer):
    def __init__(self, model_name=GLINER_MODEL, entity_mapping=None,
                 supported_language="en", threshold=GLINER_THRESHOLD, batch_size=BATCH_SIZE,
                 model=None):
        self.model_name = model_name
        self.model_to_presidio = entity_mapping or ENTITY_MAPPING
        self.gliner_labels = list(self.model_to_presidio.keys())
        self.threshold = threshold
        self.batch_size = batch_size
        # Assigned BEFORE super().__init__, which calls load() (presidio
        # EntityRecognizer.__init__ does so): assigning the shared model afterwards left
        # every recognizer loading, then discarding, its own copy of a 1 GB model.
        self.model = model
        supported_entities = list(set(self.model_to_presidio.values()))
        super().__init__(supported_entities=supported_entities, name="GLiNER2Recognizer",
                         supported_language=supported_language)

    def load(self):
        if not GLINER2_AVAILABLE:
            raise ImportError("gliner2 is not installed.")
        if self.model is not None:
            return
        self.model = AutoExtractor.from_pretrained(
            self.model_name,
            local_files_only=True,
        )
        # Reached only when the worker did not pre-load a shared model; accelerate here too
        # so the fast path does not depend on which entry point loaded the model first.
        coreml_runtime.maybe_accelerate(self.model, self.model_name)

    def analyze(self, text, entities, nlp_artifacts=None):
        if self.model is None:
            self.load()

        chunks = chunk_text_by_words(text, CHUNK_SIZE)
        total_chunks = len(chunks)
        _log(f"Processing {total_chunks} chunks in batches of {self.batch_size}...")

        batch_texts = [chunk["text"] for chunk in chunks]
        batch_results = []
        for batch_start in range(0, total_chunks, self.batch_size):
            batch_end = min(batch_start + self.batch_size, total_chunks)
            slice_results = self.model.batch_extract_entities(
                batch_texts[batch_start:batch_end],
                ENTITY_DESCRIPTIONS,
                batch_size=self.batch_size,
                threshold=self.threshold,
                include_confidence=True,
                include_spans=True,
            )
            batch_results.extend(slice_results)
            pct = int(batch_end * 100 / total_chunks)
            _log(f"PROGRESS:CHUNKS:{pct}:{batch_end}:{total_chunks}")

        unique_entities = defaultdict(lambda: defaultdict(dict))
        results = []

        for chunk_idx, (chunk, batch_result) in enumerate(zip(chunks, batch_results)):
            for label, matches in batch_result.get("entities", {}).items():
                presidio_type = self.model_to_presidio.get(label, label.upper())
                if entities and presidio_type not in entities:
                    continue
                for match in matches:
                    abs_start = chunk["start_char"] + match["start"]
                    abs_end = chunk["start_char"] + match["end"]
                    entity_text = match["text"]
                    entity_key = (entity_text, abs_start, abs_end)
                    if entity_key not in unique_entities[presidio_type]:
                        unique_entities[presidio_type][entity_key] = {
                            "text": entity_text, "start": abs_start,
                            "end": abs_end, "score": match["confidence"],
                        }
                    else:
                        if match["confidence"] > unique_entities[presidio_type][entity_key]["score"]:
                            unique_entities[presidio_type][entity_key]["score"] = match["confidence"]

        # Read each ORGANIZATION's legal form straight out of the text. Memoised by
        # normalised name: the entity keys are per-occurrence, so the same company is
        # otherwise resolved once per mention (1 689 mentions for 576 distinct names
        # on GENSIGHT_URD).
        form_cache = {}
        for entity_data in unique_entities.get("ORGANIZATION", {}).values():
            name = normalize_entity_text(entity_data["text"])
            if name not in form_cache:
                trailing = text[entity_data["end"]:entity_data["end"] + 40]
                form_cache[name] = extract_legal_form(name, trailing)
            form, nationality = form_cache[name]

            entity_data["presidio_type"] = f"ORGANIZATION_{form}" if form else "ORGANIZATION"
            entity_data["nationality"] = nationality

        for presidio_type, entity_dict in unique_entities.items():
            for entity_data in entity_dict.values():
                final_type = entity_data.get("presidio_type", presidio_type)
                results.append(RecognizerResult(
                    entity_type=final_type,
                    start=entity_data["start"],
                    end=entity_data["end"],
                    score=entity_data["score"],
                    analysis_explanation=AnalysisExplanation(
                        recognizer=self.name,
                        original_score=entity_data["score"],
                        textual_explanation="GLiNER2 batch processing",
                    ),
                ))
        return results


# ---------------------------------------------------------------------------
# Logging helper — writes to stderr so it doesn't pollute the JSON protocol
# ---------------------------------------------------------------------------
def _log(msg: str):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Analyzer cache — avoids rebuilding for same language
# ---------------------------------------------------------------------------
_analyzer_cache: Dict[str, AnalyzerEngine] = {}
_gliner_model = None  # Shared GLiNER2 model instance


def _disable_unused_spacy_components(nlp_engine, language: str) -> None:
    """Turn off every spaCy pipe whose output nothing reads.

    Entities come from GLiNER2; spaCy is kept only because presidio needs a tokenizer
    and NlpArtifacts. Failing to disable a pipe is not fatal, so this never raises.
    """
    nlp = nlp_engine.nlp.get(language)
    if nlp is None:
        return

    for pipe_name in list(nlp.pipe_names):
        try:
            nlp.disable_pipe(pipe_name)
        except Exception as exc:  # noqa: BLE001
            _log(f"Could not disable spaCy pipe '{pipe_name}': {exc}")

    _log(f"spaCy [{language}] active pipes: {nlp.pipe_names or 'tokenizer only'}")


def _get_or_build_analyzer(language: str) -> AnalyzerEngine:
    """Get a cached analyzer or build one for the given language.

    Reuses the same GLiNER2 model instance across languages.
    """
    global _gliner_model

    if language in _analyzer_cache:
        return _analyzer_cache[language]

    lang_models = {"fr": "fr_core_news_sm", "en": "en_core_web_sm"}
    model_name = lang_models.get(language, "en_core_web_sm")

    _log(f"Building analyzer for language: {language} (spaCy model: {model_name})")

    nlp_provider = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy",
        "models": [{"lang_code": language, "model_name": model_name}],
    })
    nlp_engine = nlp_provider.create_engine()
    nlp_engine.nlp[language].max_length = 5_000_000

    # presidio's SpacyNlpEngine calls spacy.load() with no `disable=`, so the whole
    # pipeline — tagger, morphologizer, parser, attribute_ruler, lemmatizer, ner —
    # runs over the document. SpacyRecognizer is then removed below, so the NER output
    # is thrown away and only tokenisation is used. Measured on 300k characters:
    # 20.6 s with the full pipeline, 0.9 s with tokenisation alone, and ~1 GB less
    # resident memory (which matters on an 8 GB machine).
    _disable_unused_spacy_components(nlp_engine, language)

    analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=[language])

    # Passed in, not assigned after construction: presidio's EntityRecognizer.__init__
    # calls load(), so a recognizer built without a model loads its own copy first.
    gliner_recognizer = GLiNER2Recognizer(
        model_name=GLINER_MODEL,
        entity_mapping=ENTITY_MAPPING,
        supported_language=language,
        batch_size=BATCH_SIZE,
        model=_gliner_model,
    )

    analyzer.registry.add_recognizer(gliner_recognizer)
    analyzer.registry.remove_recognizer("SpacyRecognizer")

    _analyzer_cache[language] = analyzer
    return analyzer


def _ensure_gliner_loaded():
    """Pre-load the GLiNER2 model so it's ready for the first scan."""
    global _gliner_model
    if _gliner_model is None and GLINER2_AVAILABLE:
        _log("Loading GLiNER2 model...")
        _gliner_model = AutoExtractor.from_pretrained(
            GLINER_MODEL,
            local_files_only=True,
        )

        # The encoder dominates the wall clock. CoreML uses an artifact compiled from
        # this exact GLiNER2.5 checkpoint; otherwise it falls back to torch on its own.
        coreml_runtime.maybe_accelerate(_gliner_model, GLINER_MODEL)

        _log("GLiNER2 model loaded.")


# ---------------------------------------------------------------------------
# Scan a single file (reuses loaded models)
# ---------------------------------------------------------------------------

def scan_file(md_file: str, output_dir: str) -> str:
    """Scan a markdown file for PII. Returns path to the output JSON."""
    if not validate_md_input(md_file):
        raise ValueError(f"Invalid input: {md_file}")

    os.makedirs(output_dir, exist_ok=True)

    with open(md_file, "r", encoding="utf-8") as fh:
        text = fh.read()

    detected_lang = detect_language(text)
    _log(f"Detected language: {detected_lang}")

    # Pattern recognizers (fast, no model needed)
    pattern_recognizers = build_pattern_recognizers()
    all_results = run_pattern_recognizers(text, pattern_recognizers)

    # NER with Presidio + GLiNER2
    _log("Running NER with Presidio + GLiNER2...")
    analyzer = _get_or_build_analyzer(detected_lang)

    # Make sure the GLiNER2 model is shared
    global _gliner_model
    for rec in analyzer.registry.recognizers:
        if isinstance(rec, GLiNER2Recognizer) and rec.model is None and _gliner_model is not None:
            rec.model = _gliner_model

    ner_results = analyzer.analyze(
        text=text,
        language=detected_lang,
        entities=["PERSON", "ORGANIZATION", "LOCATION"],
        return_decision_process=False,
    )

    # Capture the model reference if it was just loaded
    for rec in analyzer.registry.recognizers:
        if isinstance(rec, GLiNER2Recognizer) and rec.model is not None:
            _gliner_model = rec.model
            break

    _log(f"Presidio-GLiNER2 NER complete ({len(ner_results)} unique entities)")
    # One stderr line per entity is 3 586 lines on GENSIGHT_URD. A parent that does not
    # drain stderr continuously fills the 64 KB pipe and the worker blocks forever inside
    # print() — observed as a 25-minute hang, mid-scan, with no error. The volume buys
    # nothing in normal operation, so the whole listing is now behind the same flag that
    # already guarded the entity text.
    if DEBUG_ENTITIES:
        for r in ner_results:
            _log(f"  [RAW] {r.entity_type}: \"{text[r.start:r.end]}\" score={r.score:.3f} ({r.start}-{r.end})")

    extra_summary = {"ner_engine": "presidio-gliner2"}
    all_results.extend(ner_results)

    # resolve_overlapping_spans replaces EntityRecognizer.remove_duplicates, which only
    # drops a contained span when both results share an entity_type and therefore lets
    # cross-type overlaps through (81 double-typed spans and 179 overlapping pairs on
    # GENSIGHT_URD, e.g. LOCATION "French" inside ORGANIZATION "French Monetary and
    # Financial Code" — the inner one corrupts the outer during substitution).
    before_arbitration = len(all_results)
    all_results = resolve_overlapping_spans(all_results)
    _log(f"Span arbitration: {before_arbitration} -> {len(all_results)} entities")

    payload = build_output_payload(all_results, text, md_file, extra_summary)

    # Document-level metadata (nature / date / juridiction). This travels inside
    # the transient sensitive map, so it may carry clear text freely — the
    # pipeline reads it and persists only codes + non-PII fields. A failure here
    # must never lose a completed PII scan, hence the blanket guard.
    try:
        payload["document_meta"] = extract_document_meta(text)
    except Exception as exc:  # noqa: BLE001
        _log(f"document_meta extraction skipped: {exc}")
        payload["document_meta"] = {}

    stem = os.path.splitext(os.path.basename(md_file))[0]
    output_path = os.path.join(output_dir, f"{stem}_sensitive_map.json")

    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)

    # print_summary writes to stdout, which here carries the JSON-line protocol —
    # an unredirected summary is parsed by the orchestrator as a malformed response.
    with contextlib.redirect_stdout(sys.stderr):
        print_summary(payload["entities"], md_file, output_path)

    return output_path


# ---------------------------------------------------------------------------
# Main loop — JSON-line protocol on stdin/stdout
# ---------------------------------------------------------------------------

def main():
    _log("Scanner worker starting — loading models...")

    # Pre-load GLiNER2 model (the expensive part)
    _ensure_gliner_loaded()

    # Pre-build analyzers for both languages
    _log("Pre-building French analyzer...")
    _get_or_build_analyzer("fr")
    _log("Pre-building English analyzer...")
    _get_or_build_analyzer("en")

    # Signal readiness to the orchestrator via stdout
    print("READY", flush=True)
    _log("Scanner worker ready — waiting for commands on stdin")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"status": "error", "message": f"Invalid JSON: {e}"}), flush=True)
            continue

        action = cmd.get("cmd")

        if action == "quit":
            print(json.dumps({"status": "bye"}), flush=True)
            break

        if action == "scan":
            md_file = cmd.get("md_file")
            output_dir = cmd.get("output_dir")

            if not md_file or not output_dir:
                print(json.dumps({"status": "error", "message": "Missing md_file or output_dir"}), flush=True)
                continue

            try:
                json_path = scan_file(md_file, output_dir)
                print(json.dumps({"status": "ok", "json_path": json_path}), flush=True)
            except Exception as e:
                _log(f"Scan error: {e}")
                print(json.dumps({"status": "error", "message": str(e)}), flush=True)
        else:
            print(json.dumps({"status": "error", "message": f"Unknown command: {action}"}), flush=True)

    _log("Scanner worker exiting.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        _log("Scanner worker interrupted.")
        sys.exit(130)
    except Exception as e:
        _log(f"Scanner worker fatal error: {e}")
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
