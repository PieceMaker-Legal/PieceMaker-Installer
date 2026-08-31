#!/usr/bin/env python3
"""Run mdeberta's encoder on the Mac GPU through CoreML instead of the CPU.

The encoder dominates a scan's wall clock. Historical GLiNER2 measurements showed that a
CoreML/GPU MLProgram ran it about twice as fast as torch on this hardware (see
eval/BACKENDS_MESURES.md §6):

    GENSIGHT_URD_2023  972 chunks   18,76 min -> 8,96 min    2,09x
    Assignation URGOT   18 chunks   0,932 -> 0,403 s/chunk    2,31x
    Conclusions         13 chunks   0,999 -> 0,441 s/chunk    2,27x

Those quality and speed measurements concern the historical checkpoint. GLiNER2.5 gets a
separate compiled artifact so old weights can never be injected into the new model.

NOT the Neural Engine: `CPU_AND_NE` measured **3,3x slower** than the CPU on this model.
deberta-v3's disentangled attention is the pattern the ANE handles worst. `CPU_AND_GPU` is
a measured choice, not a default.

Everything degrades to plain torch: coremltools missing, model file missing, a load failure,
a prediction failure, or a sequence longer than the converted shape — each falls back
correctly. A scan must never fail because of an optimisation.

Environment:
    PIECEMAKER_COREML=0          disable entirely (default: enabled)
    PIECEMAKER_COREML_MODEL=...  path to the .mlmodelc (default: model-specific
                               file in models/ next to this file)
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SEQ = 832
LEGACY_MODEL_ID = "fastino/gliner2-multi-v1"


def default_model_path(model_id=None, seq_len=DEFAULT_SEQ):
    """Return a CoreML artifact tied to the exact checkpoint weights.

    Reusing the historical GLiNER2 encoder with GLiNER2.5 would silently
    produce invalid detections. Keep the old filename only for the old model;
    every newer checkpoint gets its own explicit artifact.
    """
    if not model_id or model_id == LEGACY_MODEL_ID:
        filename = f"encoder_b1_{seq_len}.mlmodelc"
    else:
        slug = str(model_id).rsplit("/", 1)[-1].replace("/", "-")
        filename = f"{slug}-encoder_b1_{seq_len}.mlmodelc"
    return os.path.join(_HERE, "models", filename)


DEFAULT_MODEL = default_model_path()


def _log(msg):
    print(msg, file=sys.stderr, flush=True)


class _Out:
    """Duck-types the HF model output — gliner2 only reads `.last_hidden_state`."""

    __slots__ = ("last_hidden_state",)

    def __init__(self, h):
        self.last_hidden_state = h


class CoreMLEncoder:
    """Callable replacement for `model.encoder.forward`.

    The converted model has a fixed shape (1 x seq_len), so each sequence is padded to
    seq_len and predicted on its own. Sequences longer than seq_len — 11 batches of 122 on
    GENSIGHT, none on the French corpus — go to torch, which is why the original forward is
    kept rather than replaced.
    """

    def __init__(self, mlmodel, torch_forward, seq_len):
        import numpy as np
        import torch

        self._np = np
        self._torch = torch
        self.m = mlmodel
        self.torch_forward = torch_forward
        self.seq_len = seq_len
        self.calls = 0
        self.fallbacks = 0

    def __call__(self, input_ids=None, attention_mask=None, **kw):
        torch, np = self._torch, self._np
        self.calls += 1

        if input_ids is None or attention_mask is None:
            return self.torch_forward(input_ids=input_ids, attention_mask=attention_mask, **kw)

        _, s = input_ids.shape
        if s > self.seq_len:
            self.fallbacks += 1
            return self.torch_forward(input_ids=input_ids, attention_mask=attention_mask, **kw)

        pad = self.seq_len - s
        ids = torch.nn.functional.pad(input_ids, (0, pad)).numpy().astype(np.int32)
        msk = torch.nn.functional.pad(attention_mask, (0, pad)).numpy().astype(np.int32)

        try:
            rows = [self.m.predict({"input_ids": ids[i:i + 1], "attention_mask": msk[i:i + 1]})
                    ["last_hidden_state"] for i in range(ids.shape[0])]
        except Exception as exc:  # noqa: BLE001
            self.fallbacks += 1
            _log(f"CoreML predict failed ({type(exc).__name__}: {exc}) — falling back to torch")
            return self.torch_forward(input_ids=input_ids, attention_mask=attention_mask, **kw)

        h = np.concatenate(rows, axis=0)[:, :s, :].astype(np.float32)
        return _Out(torch.from_numpy(h))


# The worker builds one GLiNER2Recognizer per language and pre-loads a shared model, so
# maybe_accelerate is reached three times per process. Loading the .mlmodelc three times
# took startup from 63 s to 208 s (measured); the model is immutable, so cache it.
_MLMODEL_CACHE = {}


def _seq_len_from_path(path: str) -> int:
    """The sequence length is encoded in the filename (encoder_b1_832.mlmodelc).

    Guessing wrong in the safe direction matters: too small only costs speed (more torch
    fallbacks), while too large would feed the model a shape it was not converted for.
    """
    base = os.path.basename(path)
    tail = base.rsplit("_", 1)[-1].split(".")[0] if "_" in base else ""
    return int(tail) if tail.isdigit() else DEFAULT_SEQ


def maybe_accelerate(model, model_id=None) -> bool:
    """Point `model.encoder.forward` at CoreML when it is available and wanted.

    Returns True if the encoder was swapped. Never raises.
    """
    if os.environ.get("PIECEMAKER_COREML", "1").lower() in ("0", "false", "no"):
        _log("CoreML disabled (PIECEMAKER_COREML=0) — torch CPU")
        return False

    path = os.environ.get("PIECEMAKER_COREML_MODEL", default_model_path(model_id))
    if not os.path.exists(path):
        _log(f"CoreML model absent ({path}) — torch CPU")
        return False

    if path in _MLMODEL_CACHE:
        mlmodel = _MLMODEL_CACHE[path]
        if mlmodel is None:  # a previous attempt already failed; don't retry per recognizer
            return False
    else:
        try:
            import coremltools as ct

            mlmodel = ct.models.CompiledMLModel(path, compute_units=ct.ComputeUnit.CPU_AND_GPU)
        except Exception as exc:  # noqa: BLE001
            _MLMODEL_CACHE[path] = None
            _log(f"CoreML unavailable ({type(exc).__name__}: {exc}) — torch CPU")
            return False
        _MLMODEL_CACHE[path] = mlmodel
        _log(f"CoreML GPU encoder active (seq {_seq_len_from_path(path)}) — ~2x faster than torch CPU")

    model.encoder.forward = CoreMLEncoder(mlmodel, model.encoder.forward, _seq_len_from_path(path))
    return True
