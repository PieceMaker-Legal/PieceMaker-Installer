"""Sélection et chargement du checkpoint GLiNER local de PieceMaker.

GLiNER2.5 utilise une architecture ``boundary`` que l'ancienne classe
``GLiNER2`` (architecture ``span``) ne sait pas charger. ``AutoExtractor``
choisit la bonne implémentation. Le checkpoint historique n'est conservé ici
que pour que l'installateur puisse détecter qu'une migration est nécessaire :
il n'est jamais sélectionné à l'exécution.
"""

import os


PREFERRED_GLINER_MODEL = "fastino/gliner2.5-multi-v1"
LEGACY_GLINER_MODELS = ("fastino/gliner2-multi-v1",)


def is_model_cached(model_id: str) -> bool:
    """Retourne vrai si la configuration et les poids sont déjà locaux."""
    try:
        from huggingface_hub import try_to_load_from_cache

        for filename in ("config.json", "model.safetensors"):
            cached_path = try_to_load_from_cache(repo_id=model_id, filename=filename)
            if not isinstance(cached_path, str) or not os.path.exists(cached_path):
                return False
        return True
    except Exception:  # noqa: BLE001 - le cache ne doit jamais bloquer un scan
        return False
