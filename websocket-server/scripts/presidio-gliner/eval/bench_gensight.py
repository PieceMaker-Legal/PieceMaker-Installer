#!/usr/bin/env python3
"""Full GENSIGHT_URD_2023 (194 391 words, 972 chunks) through one backend.

The 33-chunk corpus gave the ratio; this gives the number that matters operationally, on
the document the whole speed question came from. It also gives a far stronger quality
comparison than three slices: ~600 distinct entities, compared set against set between
backends rather than against 27 reference entities.

Predictions are stored at threshold 0.05 so the production threshold can be applied
offline, and both backends are compared on the same stored output.

    python3 bench_gensight.py fp32
    python3 bench_gensight.py coreml
"""
import json
import os
import resource
import sys
import time

import numpy as np
import torch

S = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(S, "artifacts")
sys.path.insert(0, S)
from bench_backend import BATCH, CKPT, DESCS, FLOOR, MAPPING, chunk  # noqa: E402

sys.path.insert(0, "/Users/tsardet/Documents/GitHub/PieceMaker_Claude_CLI/websocket-server/scripts")
from scan_utils import normalize_entity_text  # noqa: E402

DOC = ("/Users/tsardet/Documents/07 - PieceMaker/PieceMaker Test Files/PieceMaker_Output/"
       "doc_1770716974608_sbodwxf8y/GENSIGHT_URD_2023_2024-04-17_VDEF.md")
RESULTS = os.path.join(ART, "gensight_bench.json")
MLMODELC = os.environ.get("PIECEMAKER_COREML_MODEL",
                          os.path.join(ART, "encoder_b1_832.mlmodelc"))
# 832, not 772: French batches reach 811 tokens (padding is to the longest sequence in the
# batch), and at 772 two of the three batches of Assignation_URGOT fell back to torch, which
# cost most of the speed-up. Measured lengths on the Dossier AVION: 741, 770, 781, 811.
SEQ = int(os.environ.get("PIECEMAKER_COREML_SEQ", "832"))


def main():
    backend = sys.argv[1]
    # Optional second argument: any other document. GENSIGHT is English; the real files are
    # French, and fp16 drift has no reason to behave identically on another language.
    doc = sys.argv[2] if len(sys.argv) > 2 else DOC
    run_key = backend if doc == DOC else f"{backend}:{os.path.basename(doc)[:30]}"
    torch.set_num_threads(6)
    torch.set_grad_enabled(False)

    from gliner2 import GLiNER2

    t0 = time.perf_counter()
    model = GLiNER2.from_pretrained(CKPT).eval()
    load_s = time.perf_counter() - t0

    fallbacks = [0]
    if backend == "coreml":
        import coremltools as ct
        from bench_coreml_pipeline import CoreMLEncoder

        t = time.perf_counter()
        mlmodel = ct.models.CompiledMLModel(MLMODELC, compute_units=ct.ComputeUnit.CPU_AND_GPU)
        load_s += time.perf_counter() - t
        shim = CoreMLEncoder(mlmodel, model.encoder.forward)
        model.encoder.forward = shim
    else:
        shim = None

    text = open(doc, encoding="utf-8").read()
    chunks = chunk(text)
    n = len(chunks)
    print(f"[{backend}] {len(text.split())} mots, {n} chunks, chargement {load_s:.1f}s", flush=True)

    # Warm-up outside the clock.
    model.batch_extract_entities([chunks[0]], DESCS, batch_size=1, threshold=FLOOR,
                                 include_confidence=True, include_spans=True)

    preds = {}
    t0 = time.perf_counter()
    for i in range(0, n, BATCH):
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
        done = min(i + BATCH, n)
        if done % 80 < BATCH or done == n:
            el = time.perf_counter() - t0
            print(f"  {done}/{n} chunks · {el / 60:.1f} min ecoulees · "
                  f"{el / done:.3f} s/chunk · ETA {(el / done * (n - done)) / 60:.1f} min",
                  flush=True)
    total = time.perf_counter() - t0

    if shim is not None:
        fallbacks[0] = shim.fallbacks

    entry = {
        "backend": backend, "words": len(text.split()), "chunks": n,
        "total_s": round(total, 1), "total_min": round(total / 60, 2),
        "s_per_chunk": round(total / n, 3), "model_load_s": round(load_s, 1),
        "distinct_entities": len(preds),
        "entities_at_070": sum(1 for v in preds.values() if v >= 0.70),
        "torch_fallbacks": fallbacks[0],
        "rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1),
        "preds": [{"type": t, "text": x, "score": float(s)} for (t, x), s in preds.items()],
    }
    all_res = json.load(open(RESULTS, encoding="utf-8")) if os.path.exists(RESULTS) else {}
    all_res[run_key] = entry
    json.dump(all_res, open(RESULTS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"[{run_key}] TERMINE {total / 60:.2f} min · {total / n:.3f} s/chunk · "
          f"{len(preds)} entites distinctes ({entry['entities_at_070']} au seuil 0.70) · "
          f"replis torch {fallbacks[0]} · RSS {entry['rss_mb']:.0f} Mo", flush=True)


if __name__ == "__main__":
    main()
