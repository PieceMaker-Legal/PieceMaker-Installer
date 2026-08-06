#!/usr/bin/env python3
"""Is BATCH_SIZE = 8 actually the right batch size on this machine?

The encoder benchmark gave 11.26 s for a batch of 8 (1.41 s/sample) and 0.85 s for a
batch of 1 — i.e. batching may be *costing* throughput, not buying it, which would make
BATCH_SIZE a free speed-up with no effect on the output (the batch dimension does not
change any result, only how many sequences are encoded at once).

Times the encoder alone on the same real tokens, batch 1/2/4/8, in one process.
"""
import json
import os
import time

import torch
from gliner2 import GLiNER2

S = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(S, "artifacts")
INPUTS = os.path.join(ART, "encoder_inputs.pt")

torch.set_num_threads(6)
torch.set_grad_enabled(False)

inp = torch.load(INPUTS)
ids_full, mask_full = inp["input_ids"], inp["attention_mask"]

enc = GLiNER2.from_pretrained("fastino/gliner2-multi-v1").eval().encoder

out = {}
for bs in (1, 2, 4, 8):
    ids, mask = ids_full[:bs], mask_full[:bs]
    enc(input_ids=ids, attention_mask=mask)  # warm-up
    ts = []
    for _ in range(3):
        t = time.perf_counter()
        enc(input_ids=ids, attention_mask=mask)
        ts.append(time.perf_counter() - t)
    best = min(ts)
    out[bs] = {"batch_s": round(best, 3), "s_per_sample": round(best / bs, 3)}
    print(f"batch {bs}: {best:.2f}s pour {bs} sequences = {best / bs:.3f} s/sequence", flush=True)

base = out[8]["s_per_sample"]
for bs, v in out.items():
    print(f"  batch {bs}: {base / v['s_per_sample']:.2f}x vs batch 8")

json.dump(out, open(os.path.join(ART, "batchsize_bench.json"), "w"), indent=1)
