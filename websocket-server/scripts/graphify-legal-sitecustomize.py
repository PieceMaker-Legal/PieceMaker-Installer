"""Charge le prompt juridique PieceMaker dans le moteur sémantique Graphify.

Ce module est copié sous le nom ``sitecustomize.py`` dans un répertoire
temporaire ajouté au ``PYTHONPATH`` du seul processus Graphify concerné. Il ne
modifie ni l'installation Graphify globale, ni les autres extractions.
"""

from __future__ import annotations

import os
import hashlib
from pathlib import Path


def _installer_prompt_juridique() -> None:
    prompt_file = os.environ.get("PIECEMAKER_GRAPHIFY_LEGAL_PROMPT", "").strip()
    if not prompt_file:
        return
    prompt_path = Path(prompt_file)
    prompt = prompt_path.read_text(encoding="utf-8").strip()
    if not prompt:
        raise RuntimeError("Le prompt juridique PieceMaker est vide.")

    import graphify.llm as graphify_llm

    deep_suffix = (
        "\n\nMODE_APPROFONDI : recherche les chaînes contrat → obligation → "
        "inexécution → prétention → moyen de défense → norme, ainsi que les "
        "contradictions entre pièces. Toute étape non littérale reste INFERRED "
        "ou AMBIGUOUS et demeure rattachée à ses sources.\n"
    )
    graphify_llm._EXTRACTION_SYSTEM = prompt
    graphify_llm._DEEP_EXTRACTION_SUFFIX = deep_suffix

    # Remplacer aussi le point d'accès : une évolution interne de Graphify qui
    # mettrait en cache l'ancien global ne doit pas réactiver son prompt générique.
    def _prompt_piecemaker(*, deep: bool = False) -> str:
        return prompt + deep_suffix if deep else prompt

    graphify_llm._extraction_system = _prompt_piecemaker

    marker_file = os.environ.get("PIECEMAKER_GRAPHIFY_LEGAL_MARKER", "").strip()
    if marker_file:
        Path(marker_file).write_text(
            hashlib.sha256(prompt_path.read_bytes()).hexdigest(),
            encoding="utf-8",
        )


_installer_prompt_juridique()
