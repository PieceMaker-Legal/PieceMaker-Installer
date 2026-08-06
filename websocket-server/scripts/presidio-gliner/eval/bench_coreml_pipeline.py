#!/usr/bin/env python3
"""End-to-end test of the CoreML GPU encoder inside the real pipeline.

The isolated encoder benchmark says CoreML/GPU is ~2.8x faster per sequence than torch,
but in fp16: max |Δ| on last_hidden_state is 0.68, which is far from free. Whether that
drift changes the entities is not something to reason about — it is scored on the corpus,
with the same metric as everything else.

The converted model has a fixed shape (1 x 772), so each sequence is padded to 772 and run
alone; sequences longer than 772 fall back to torch and are counted (a fallback that fires
often would invalidate the timing).

    python3 bench_coreml_pipeline.py
"""
import json
import os
import sys
import time

import numpy as np
import torch

S = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(S, "artifacts")
sys.path.insert(0, S)
from bench_backend import BATCH, CKPT, DESCS, FLOOR, MAPPING, SLICES, chunk  # noqa: E402

sys.path.insert(0, "/Users/tsardet/Documents/GitHub/PieceMaker_Claude_CLI/websocket-server/scripts")
from scan_utils import normalize_entity_text  # noqa: E402

# 832, not 772: French batches reach 811 tokens (padding is to the longest sequence in the
# batch), and at 772 two of the three batches of Assignation_URGOT fell back to torch, which
# cost most of the speed-up. Measured lengths on the Dossier AVION: 741, 770, 781, 811.
SEQ = int(os.environ.get("PIECEMAKER_COREML_SEQ", "832"))
MLPKG = os.path.join(ART, "encoder_b1.mlpackage")
MLMODELC = os.environ.get("PIECEMAKER_COREML_MODEL",
                          os.path.join(ART, "encoder_b1_832.mlmodelc"))


class Out:
    def __init__(self, h):
        self.last_hidden_state = h


class CoreMLEncoder:
    def __init__(self, mlmodel, torch_forward):
        self.m = mlmodel
        self.torch_forward = torch_forward
        self.fallbacks = 0
        self.calls = 0

    def __call__(self, input_ids=None, attention_mask=None, **kw):
        b, s = input_ids.shape
        self.calls += 1
        if s > SEQ:
            self.fallbacks += 1
            return self.torch_forward(input_ids=input_ids, attention_mask=attention_mask, **kw)

        pad = SEQ - s
        ids = torch.nn.functional.pad(input_ids, (0, pad)).numpy().astype(np.int32)
        msk = torch.nn.functional.pad(attention_mask, (0, pad)).numpy().astype(np.int32)

        rows = []
        for i in range(b):
            r = self.m.predict({"input_ids": ids[i:i + 1], "attention_mask": msk[i:i + 1]})
            rows.append(r["last_hidden_state"])
        h = torch.from_numpy(np.concatenate(rows, axis=0)[:, :s, :]).float()
        return Out(h)


def run_slice(model, text):
    chunks = chunk(text)
    preds = {}
    t0 = time.perf_counter()
    for i in range(0, len(chunks), BATCH):
        res = model.batch_extract_entities(chunks[i:i + BATCH], DESCS, batch_size=BATCH,
                                           threshold=FLOOR, include_confidence=True,
                                           include_spans=True)
        for r in res:
            for label, matches in r.get("entities", {}).items():
                etype = MAPPING.get(label, label.upper())
                for m in matches:
                    key = (etype, normalize_entity_text(m["text"]))
                    if key[1]:
                        preds[key] = max(preds.get(key, 0.0), m["confidence"])
    return ([{"type": t, "text": x, "score": s} for (t, x), s in preds.items()],
            time.perf_counter() - t0, len(chunks))


def main():
    import coremltools as ct
    from gliner2 import GLiNER2

    torch.set_num_threads(6)
    torch.set_grad_enabled(False)

    model = GLiNER2.from_pretrained(CKPT).eval()
    print("chargement du modele CoreML (GPU)...", flush=True)
    t0 = time.perf_counter()
    # Loading the .mlpackage recompiles every time (97 s, measured twice in a row) because
    # each load compiles into a fresh temp directory the OS cache never recognises. Loading
    # a persisted .mlmodelc hits that cache: 5.8 s once warm.
    mlmodel = ct.models.CompiledMLModel(MLMODELC, compute_units=ct.ComputeUnit.CPU_AND_GPU)
    print(f"  {time.perf_counter() - t0:.1f}s", flush=True)

    shim = CoreMLEncoder(mlmodel, model.encoder.forward)
    model.encoder.forward = shim

    model.batch_extract_entities(["Bernard Gilly, GenSight Biologics, Paris."], DESCS,
                                 batch_size=1, threshold=FLOOR, include_confidence=True,
                                 include_spans=True)

    entry = {"checkpoint": CKPT, "chunk": [250, 50], "backend": "coreml-gpu",
             "slices": {}, "timing": {}}
    total_s, total_chunks = 0.0, 0
    for sname, text in SLICES.items():
        preds, secs, nch = run_slice(model, text)
        entry["slices"][sname] = preds
        entry["timing"][sname] = {"seconds": round(secs, 2), "chunks": nch}
        total_s += secs
        total_chunks += nch
        print(f"  coreml-gpu/{sname}: {len(preds)} entites, {nch} chunks en {secs:.1f}s", flush=True)

    entry.update(total_s=round(total_s, 2), total_chunks=total_chunks,
                 s_per_chunk=round(total_s / total_chunks, 3),
                 encoder_calls=shim.calls, torch_fallbacks=shim.fallbacks)

    path = os.path.join(S, "bench_results.json")
    all_res = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    all_res["coreml-gpu"] = entry
    json.dump(all_res, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"[coreml-gpu] {total_s:.1f}s / {total_chunks} chunks = "
          f"{total_s / total_chunks:.3f} s/chunk · {shim.fallbacks}/{shim.calls} repli torch",
          flush=True)


if __name__ == "__main__":
    main()
