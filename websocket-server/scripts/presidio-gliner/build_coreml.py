#!/usr/bin/env python3
"""Génère une fois l'encodeur CoreML, pour que les scans GLiNER tournent sur le GPU.

Le runtime (`coreml_runtime.py`) accélère l'encodeur mdeberta sur le GPU du Mac
et libère surtout les cœurs CPU pour que la machine reste utilisable pendant un
scan. Les mesures historiques sont documentées dans `eval/BACKENDS_MESURES.md` ;
GLiNER2.5 reçoit son propre artefact compilé à partir de ses poids exacts.

Ce script est **best-effort et idempotent** :
  - il ne refait rien si le `.mlmodelc` est déjà là ;
  - il sort 0 quoi qu'il arrive (dépendance manquante, conversion refusée…), car
    le runtime retombe seul sur torch — un scan ne doit jamais échouer à cause
    d'une optimisation.

Il réutilise `Wrap` et `_patch_deberta_scale` de `eval/coreml_encoder.py` pour ne
pas dupliquer les correctifs de traçage deberta, mais synthétise ses propres
entrées (la conversion ne dépend que de leur forme, pas de leurs valeurs).

    python3 build_coreml.py            # génère l'encodeur GLiNER2.5 dans models/
    PIECEMAKER_COREML_SEQ=832          # longueur de séquence (défaut 832)
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SEQ = int(os.environ.get("PIECEMAKER_COREML_SEQ", "832"))
MODELS_DIR = os.path.join(HERE, "models")

from model_config import PREFERRED_GLINER_MODEL  # noqa: E402
from coreml_runtime import default_model_path  # noqa: E402

GLINER_MODEL = PREFERRED_GLINER_MODEL
TARGET = default_model_path(GLINER_MODEL, SEQ)


def _log(msg):
    print(msg, flush=True)


def main():
    if os.path.exists(TARGET):
        _log(f"Encodeur CoreML déjà présent : {TARGET}")
        return 0

    try:
        import numpy as np
        import torch
        import coremltools as ct
        from gliner2 import AutoExtractor
    except Exception as exc:  # noqa: BLE001
        _log(f"CoreML non généré (dépendance manquante : {type(exc).__name__}: {exc}) — les scans resteront sur CPU torch")
        return 0

    # Correctifs de traçage deberta partagés avec l'outil d'évaluation.
    sys.path.insert(0, os.path.join(HERE, "eval"))
    try:
        from coreml_encoder import Wrap, _patch_deberta_scale
    except Exception as exc:  # noqa: BLE001
        _log(f"CoreML non généré (helpers de conversion introuvables : {exc}) — CPU torch")
        return 0

    try:
        torch.set_grad_enabled(False)
        _patch_deberta_scale()

        # Entrées factices de la bonne forme : seule la forme (1 x SEQ) est gravée
        # dans le modèle converti, pas les valeurs.
        ids = torch.zeros((1, SEQ), dtype=torch.long)
        mask = torch.ones((1, SEQ), dtype=torch.long)

        _log(f"Chargement de {GLINER_MODEL}...")
        model = AutoExtractor.from_pretrained(
            GLINER_MODEL,
            local_files_only=True,
        ).eval()
        wrap = Wrap(model.encoder).eval()
        del model

        _log("Traçage du modèle...")
        traced = torch.jit.trace(wrap, (ids, mask), strict=False)

        _log("Conversion en MLProgram (fp16)...")
        mlmodel = ct.convert(
            traced,
            inputs=[ct.TensorType(name="input_ids", shape=ids.shape, dtype=np.int32),
                    ct.TensorType(name="attention_mask", shape=mask.shape, dtype=np.int32)],
            outputs=[ct.TensorType(name="last_hidden_state")],
            convert_to="mlprogram",
            compute_precision=ct.precision.FLOAT16,
            minimum_deployment_target=ct.target.macOS14,
        )

        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, f"encoder_b1_{SEQ}.mlpackage")
            mlmodel.save(pkg)

            # Le .mlmodelc persisté touche le cache système : ~6 s au chargement
            # ensuite, contre ~97 s si l'on rechargeait le .mlpackage à chaque fois
            # (cf. MODELE_COREML.md). On garde une référence vivante le temps de la
            # copie, sinon le répertoire compilé temporaire peut disparaître.
            _log("Compilation en .mlmodelc (peut prendre ~2 min)...")
            compiled_model = ct.models.MLModel(pkg, compute_units=ct.ComputeUnit.CPU_AND_GPU)
            os.makedirs(MODELS_DIR, exist_ok=True)
            if os.path.exists(TARGET):
                shutil.rmtree(TARGET, ignore_errors=True)
            shutil.copytree(compiled_model.get_compiled_model_path(), TARGET)

        _log(f"Encodeur GPU CoreML prêt : {TARGET}")
        return 0
    except Exception as exc:  # noqa: BLE001
        _log(f"Génération CoreML échouée ({type(exc).__name__}: {exc}) — les scans resteront sur CPU torch, sans conséquence sur la qualité")
        return 0


if __name__ == "__main__":
    sys.exit(main())
