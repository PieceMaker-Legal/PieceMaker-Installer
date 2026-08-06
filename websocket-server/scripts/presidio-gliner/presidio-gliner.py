"""
Presidio-GLiNER2 PII Scanner — scans a Markdown file for sensitive data using
presidio-analyzer with a custom GLiNER2 recognizer (gliner2 pip package) and
the fastino/gliner2-multi-v1 model.

Usage:
    python presidio-gliner.py <md_file> -o <output_dir>

Pip deps:
    presidio-analyzer>=2.2.0
    gliner2>=1.2.0
    spacy>=3.7.0
    # + spaCy models: fr_core_news_sm, en_core_web_sm

Language is auto-detected (fr/en) from the document content.
"""

import argparse
import json
import os
import sys
import warnings
from collections import defaultdict
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# Import from the *real* installed presidio-analyzer BEFORE adding the parent
# dir to sys.path (the parent dir contains a vendored presidio_analyzer subset
# that would shadow the real package).
# ---------------------------------------------------------------------------
from presidio_analyzer import (
    AnalysisExplanation,
    AnalyzerEngine,
    LocalRecognizer,
    RecognizerResult,
)
from presidio_analyzer.nlp_engine import NlpArtifacts, NlpEngineProvider

try:
    from gliner2 import GLiNER2

    GLINER2_AVAILABLE = True
except ImportError:
    GLINER2_AVAILABLE = False

# ---------------------------------------------------------------------------
# Parent dir on sys.path so we can import scan_utils.
# scan_utils imports from a *vendored* presidio_analyzer subset that lives in
# the parent dir.  The real package is already loaded above, so we temporarily
# hide it from sys.modules so the vendored copy is picked up by scan_utils,
# then restore the real modules afterwards.
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

# See scanner_worker.py for the measurements behind both settings.
try:
    import torch

    torch.set_num_threads(int(os.environ.get("PIECEMAKER_TORCH_THREADS", "6")))
except ImportError:  # pragma: no cover - torch ships with gliner2
    pass

DEBUG_ENTITIES = os.environ.get("PIECEMAKER_DEBUG_ENTITIES", "").lower() in ("1", "true", "yes")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
GLINER_MODEL = "fastino/gliner2-multi-v1"

ENTITY_MAPPING = {
    "person":       "PERSON",
    "company":      "ORGANIZATION",   # explicit commercial entity
    "organization": "ORGANIZATION",   # non-profit / institutional
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

# Confidence threshold, swept 0.05 -> 0.90 on the reference corpus. 0.70 is the
# highest value that still finds every reference entity; above it OBA is lost, below it
# precision falls without recovering any entity. The previous 0.30 filtered nothing
# useful and let through twice as many false positives.
GLINER_THRESHOLD = 0.7

# Legal forms are read literally from the text by scan_utils.extract_legal_form;
# the previous 30-label classify_text schema is gone (see scanner_worker.py).

CHUNK_SIZE = 250  # words per chunk
CHUNK_OVERLAP = 50  # words of overlap between chunks
BATCH_SIZE = 8  # number of chunks to process in parallel


# ---------------------------------------------------------------------------
# Chunking utility
# ---------------------------------------------------------------------------


def chunk_text_by_words(
    text: str,
    max_words: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> List[Dict]:
    """
    Split text into overlapping chunks based on word count, preserving
    original char offsets.

    Uses regex to locate every word boundary in the original text so that
    start_char / end_char are always exact offsets and original whitespace
    (tabs, newlines, multiple spaces) is preserved inside each chunk.
    """
    import re

    word_spans = [(m.start(), m.end()) for m in re.finditer(r"\S+", text)]
    if not word_spans:
        return []

    step = max(1, max_words - overlap)
    chunks = []
    for i in range(0, len(word_spans), step):
        span_group = word_spans[i : i + max_words]
        start_char = span_group[0][0]
        end_char = span_group[-1][1]

        chunks.append(
            {
                "text": text[start_char:end_char],
                "start_char": start_char,
                "end_char": end_char,
            }
        )

        # Stop if this chunk already reached the end
        if i + max_words >= len(word_spans):
            break

    return chunks


# ---------------------------------------------------------------------------
# Custom GLiNER2 Presidio recognizer
# ---------------------------------------------------------------------------


class GLiNER2Recognizer(LocalRecognizer):
    """Presidio recognizer wrapping the gliner2 package with batch processing."""

    def __init__(
        self,
        model_name: str = GLINER_MODEL,
        entity_mapping: Optional[Dict[str, str]] = None,
        supported_language: str = "en",
        threshold: float = GLINER_THRESHOLD,
        batch_size: int = BATCH_SIZE,
    ):
        self.model_name = model_name
        self.model_to_presidio = entity_mapping or ENTITY_MAPPING
        self.gliner_labels = list(self.model_to_presidio.keys())
        self.threshold = threshold
        self.batch_size = batch_size
        self.model = None

        supported_entities = list(set(self.model_to_presidio.values()))

        super().__init__(
            supported_entities=supported_entities,
            name="GLiNER2Recognizer",
            supported_language=supported_language,
        )

    def load(self) -> None:
        if not GLINER2_AVAILABLE:
            raise ImportError("gliner2 is not installed.")
        self.model = GLiNER2.from_pretrained(self.model_name)
        # Same CoreML/GPU encoder as the worker (~2x, identical output). Falls back to
        # torch on its own when coremltools or the compiled model is absent.
        coreml_runtime.maybe_accelerate(self.model)

    def analyze(
        self,
        text: str,
        entities: List[str],
        nlp_artifacts: Optional[NlpArtifacts] = None,
    ) -> List[RecognizerResult]:
        if self.model is None:
            self.load()

        # Chunk the text
        chunks = chunk_text_by_words(text, CHUNK_SIZE)
        total_chunks = len(chunks)
        print(f"⚡ Processing {total_chunks} chunks in batches of {self.batch_size}...")

        # Extract batch texts
        batch_texts = [chunk["text"] for chunk in chunks]

        # Process one batch at a time so PROGRESS:CHUNKS is emitted as each
        # batch actually finishes inference (real-time, not post-hoc).
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
            print(f"PROGRESS:CHUNKS:{pct}:{batch_end}:{total_chunks}", flush=True)

        print(f"✓ Completed processing all {len(batch_results)} chunks")

        # Deduplicate entities across chunks using text-based set
        unique_entities = defaultdict(lambda: defaultdict(dict))
        results = []

        for chunk_idx, (chunk, batch_result) in enumerate(zip(chunks, batch_results)):
            for label, matches in batch_result.get("entities", {}).items():
                presidio_type = self.model_to_presidio.get(label, label.upper())
                if entities and presidio_type not in entities:
                    continue

                for match in matches:
                    # Calculate absolute positions
                    abs_start = chunk["start_char"] + match["start"]
                    abs_end = chunk["start_char"] + match["end"]
                    entity_text = match["text"]

                    # Create unique key for deduplication
                    entity_key = (entity_text, abs_start, abs_end)

                    # Keep only the highest confidence score for each unique entity
                    if entity_key not in unique_entities[presidio_type]:
                        unique_entities[presidio_type][entity_key] = {
                            "text": entity_text,
                            "start": abs_start,
                            "end": abs_end,
                            "score": match["confidence"],
                        }
                    else:
                        # Update if higher confidence
                        if (
                            match["confidence"]
                            > unique_entities[presidio_type][entity_key]["score"]
                        ):
                            unique_entities[presidio_type][entity_key]["score"] = match[
                                "confidence"
                            ]

        # Read each ORGANIZATION's legal form straight out of the text, memoised
        # by normalised name (entity keys are per-occurrence).
        form_cache = {}
        for entity_data in unique_entities.get("ORGANIZATION", {}).values():
            name = normalize_entity_text(entity_data["text"])
            if name not in form_cache:
                trailing = text[entity_data["end"]:entity_data["end"] + 40]
                form_cache[name] = extract_legal_form(name, trailing)
            form, nationality = form_cache[name]

            entity_data["presidio_type"] = f"ORGANIZATION_{form}" if form else "ORGANIZATION"
            entity_data["nationality"] = nationality

        # Convert deduplicated entities to RecognizerResult objects
        for presidio_type, entity_dict in unique_entities.items():
            for entity_data in entity_dict.values():
                final_type = entity_data.get("presidio_type", presidio_type)
                results.append(
                    RecognizerResult(
                        entity_type=final_type,
                        start=entity_data["start"],
                        end=entity_data["end"],
                        score=entity_data["score"],
                        analysis_explanation=AnalysisExplanation(
                            recognizer=self.name,
                            original_score=entity_data["score"],
                            textual_explanation=f"GLiNER2 batch processing",
                        ),
                    )
                )

        return results


# ---------------------------------------------------------------------------
# Engine setup
# ---------------------------------------------------------------------------


def _build_analyzer(language: str):
    """Create an AnalyzerEngine with spaCy NLP + GLiNER2 recognizer."""
    lang_models = {
        "fr": "fr_core_news_sm",
        "en": "en_core_web_sm",
    }
    model_name = lang_models.get(language, "en_core_web_sm")

    nlp_provider = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": language, "model_name": model_name}],
        }
    )
    nlp_engine = nlp_provider.create_engine()
    # Raise spaCy max_length so large documents don't get rejected.
    # NER is handled by GLiNER2 in chunks, spaCy is only used for tokenization.
    nlp_engine.nlp[language].max_length = 5_000_000

    # ...so disable every other pipe. presidio loads the full pipeline by default and
    # SpacyRecognizer is removed below, meaning tagger/parser/lemmatizer/ner all run
    # over the document and their output is discarded (20.6 s vs 0.9 s per 300k chars).
    _nlp = nlp_engine.nlp.get(language)
    if _nlp is not None:
        for _pipe_name in list(_nlp.pipe_names):
            try:
                _nlp.disable_pipe(_pipe_name)
            except Exception as exc:  # noqa: BLE001
                warnings.warn(f"Could not disable spaCy pipe '{_pipe_name}': {exc}", stacklevel=1)

    analyzer = AnalyzerEngine(
        nlp_engine=nlp_engine,
        supported_languages=[language],
    )

    gliner_recognizer = GLiNER2Recognizer(
        model_name=GLINER_MODEL,
        entity_mapping=ENTITY_MAPPING,
        supported_language=language,
        batch_size=BATCH_SIZE,
    )
    analyzer.registry.add_recognizer(gliner_recognizer)
    analyzer.registry.remove_recognizer("SpacyRecognizer")

    return analyzer


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Presidio-GLiNER2 PII Scanner for .md files"
    )
    parser.add_argument("md_file", help="Path to the Markdown file to scan")
    parser.add_argument(
        "-o",
        "--output",
        default="./presidio_gliner_output",
        help="Output directory for the JSON entity map",
    )
    args = parser.parse_args()

    if not validate_md_input(args.md_file):
        return 1

    os.makedirs(args.output, exist_ok=True)

    with open(args.md_file, "r", encoding="utf-8") as fh:
        text = fh.read()

    detected_lang = detect_language(text)
    print(f"✓ Detected language: {detected_lang}")

    pattern_recognizers = build_pattern_recognizers()
    all_results = run_pattern_recognizers(text, pattern_recognizers)

    extra_summary = {}

    print("\U0001f50d Running NER with Presidio + GLiNER2...")
    try:
        analyzer = _build_analyzer(detected_lang)
        ner_results = analyzer.analyze(
            text=text,
            language=detected_lang,
            entities=["PERSON", "ORGANIZATION", "LOCATION"],
            return_decision_process=False,
        )
        # Re-include ORGANIZATION_* results that classify_text may have re-typed;
        # Presidio's engine only checks supported_entities at dispatch time, not on
        # results, so ORGANIZATION_SA / ORGANIZATION_GMBH etc. pass through as-is.
        print(f"✓ Presidio-GLiNER2 NER complete ({len(ner_results)} unique entities)")
        # DEBUG: Log raw GLiNER entities before any filtering
        for r in ner_results:
            if DEBUG_ENTITIES:
                print(f"  [RAW] {r.entity_type}: \"{text[r.start:r.end]}\" score={r.score:.3f} ({r.start}-{r.end})")
            else:
                print(f"  [RAW] {r.entity_type}: score={r.score:.3f} ({r.start}-{r.end})")
        extra_summary["ner_engine"] = "presidio-gliner2"
        all_results.extend(ner_results)
    except Exception as exc:  # noqa: BLE001
        warnings.warn(f"[presidio-gliner2] NER analysis failed: {exc}", stacklevel=1)

    # Trust GLiNER scores as-is; arbitrate overlapping spans across types (presidio's
    # remove_duplicates only handles same-type containment).
    all_results = resolve_overlapping_spans(all_results)

    payload = build_output_payload(all_results, text, args.md_file, extra_summary)

    stem = os.path.splitext(os.path.basename(args.md_file))[0]
    output_path = os.path.join(args.output, f"{stem}_sensitive_map.json")

    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)

    print_summary(payload["entities"], args.md_file, output_path)

    return 0


if __name__ == "__main__":
    sys.exit(main())
