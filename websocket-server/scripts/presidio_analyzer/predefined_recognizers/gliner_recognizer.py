"""GLiNER2-based entity recognizer for Presidio.

Wraps the gliner2 library into a Presidio LocalRecognizer so it can be used
as a drop-in NER backend alongside pattern-based recognizers.
"""

import logging
import time
from typing import Dict, List, Optional

from presidio_analyzer import (
    AnalysisExplanation,
    LocalRecognizer,
    RecognizerResult,
)
from presidio_analyzer.nlp_engine import NlpArtifacts

try:
    from gliner2 import GLiNER2
except ImportError:
    GLiNER2 = None

logger = logging.getLogger("presidio-analyzer")

# GLiNER2 label → Presidio entity type
DEFAULT_ENTITY_MAPPING = {
    "person": "PERSON",
    "organization": "ORGANIZATION",
    "address": "LOCATION",
}

# Descriptions fed to GLiNER2's extract_entities API
DEFAULT_ENTITY_DESCRIPTIONS = {
    "person": "Names of individuals",
    "organization": "Company and organization names",
    "address": "Physical addresses and locations",
}


class GLiNERRecognizer(LocalRecognizer):
    """GLiNER2 model based entity recognizer."""

    def __init__(
        self,
        supported_entities: Optional[List[str]] = None,
        name: str = "GLiNERRecognizer",
        supported_language: str = "en",
        version: str = "0.0.1",
        context: Optional[List[str]] = None,
        entity_mapping: Optional[Dict[str, str]] = None,
        entity_descriptions: Optional[Dict[str, str]] = None,
        model_name: str = "fastino/gliner2-base-v1",
        threshold: float = 0.5,
        chunk_size: int = 15000,
        chunk_overlap: int = 1500,
        defer_load: bool = False,
    ):
        """GLiNER2 model based entity recognizer.

        :param entity_mapping: GLiNER2 label → Presidio entity type mapping.
        :param entity_descriptions: Label descriptions for GLiNER2's API.
        :param model_name: HuggingFace model ID.
        :param threshold: Confidence threshold for predictions.
        :param chunk_size: Max characters per chunk (GLiNER2 context limit).
        :param chunk_overlap: Overlap between chunks to avoid missed entities.
        :param defer_load: If True, don't load the model at init time.
        """
        self.model_to_presidio_entity_mapping = entity_mapping or DEFAULT_ENTITY_MAPPING
        self.entity_descriptions = entity_descriptions or DEFAULT_ENTITY_DESCRIPTIONS

        supported_entities = list(set(self.model_to_presidio_entity_mapping.values()))

        self.model_name = model_name
        self.threshold = threshold
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.gliner = None

        super().__init__(
            supported_entities=supported_entities,
            name=name,
            supported_language=supported_language,
            version=version,
            context=context,
        )

        if not defer_load:
            self.load()

    def load(self) -> None:
        """Load the GLiNER2 model."""
        if not GLiNER2:
            raise ImportError(
                "gliner2 is not installed. Install with: pip install gliner2"
            )
        self.gliner = GLiNER2.from_pretrained(self.model_name)

    def load_with_progress(self) -> None:
        """Load the GLiNER2 model with user-friendly progress messages."""
        if not GLiNER2:
            raise ImportError(
                "gliner2 is not installed. Install with: pip install gliner2"
            )

        print(f"\U0001f504 Loading GLiNER2 model ({self.model_name})...")
        start = time.time()

        try:
            self.gliner = GLiNER2.from_pretrained(self.model_name)
            elapsed = time.time() - start
            print(f"\u2713 Model loaded ({elapsed:.1f}s)")
        except Exception as exc:
            elapsed = time.time() - start
            print(f"\u274c Failed to load model ({elapsed:.1f}s): {exc}")
            raise

    def _chunk_text(self, text: str) -> List[tuple]:
        """Split text into overlapping chunks for large documents."""
        if len(text) <= self.chunk_size:
            return [(text, 0)]

        chunks = []
        start = 0
        while start < len(text):
            end = min(start + self.chunk_size, len(text))

            # Try to break at a natural boundary
            if end < len(text):
                newline_pos = text.rfind("\n", start, end)
                if newline_pos > start + self.chunk_size * 0.8:
                    end = newline_pos + 1
                else:
                    space_pos = text.rfind(" ", start, end)
                    if space_pos > start + self.chunk_size * 0.8:
                        end = space_pos + 1

            chunks.append((text[start:end], start))

            if end >= len(text):
                break
            start = end - self.chunk_overlap

        return chunks

    def analyze(
        self,
        text: str,
        entities: List[str],
        nlp_artifacts: Optional[NlpArtifacts] = None,
    ) -> List[RecognizerResult]:
        """Analyze text to identify entities using the GLiNER2 model.

        :param text: The text to be analyzed.
        :param entities: The list of entities this recognizer should return.
        :param nlp_artifacts: Not used by this recognizer.
        """
        if not self.gliner:
            raise RuntimeError("Model not loaded. Call load() first.")

        all_results: List[RecognizerResult] = []
        seen: set = set()

        for chunk_text, offset in self._chunk_text(text):
            try:
                raw = self.gliner.extract_entities(
                    chunk_text,
                    self.entity_descriptions,
                    threshold=self.threshold,
                    include_confidence=True,
                    include_spans=True,
                )
            except Exception as exc:
                logger.warning("GLiNER2 chunk failed: %s", exc)
                continue

            for gliner_label, entities_list in raw.get("entities", {}).items():
                presidio_type = self.model_to_presidio_entity_mapping.get(
                    gliner_label, gliner_label.upper()
                )

                if entities and presidio_type not in entities:
                    continue

                for ent in entities_list:
                    abs_start = ent["start"] + offset
                    abs_end = ent["end"] + offset
                    dedup_key = (presidio_type, abs_start, abs_end)
                    if dedup_key in seen:
                        continue
                    seen.add(dedup_key)

                    score = ent.get("confidence", self.threshold)

                    explanation = AnalysisExplanation(
                        recognizer=self.name,
                        original_score=score,
                        textual_explanation=(
                            f"Identified as {presidio_type} by GLiNER2"
                        ),
                    )

                    all_results.append(
                        RecognizerResult(
                            entity_type=presidio_type,
                            start=abs_start,
                            end=abs_end,
                            score=score,
                            analysis_explanation=explanation,
                        )
                    )

        return all_results
