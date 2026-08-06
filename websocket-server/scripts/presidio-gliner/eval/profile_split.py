#!/usr/bin/env python3
"""Where does the 1.29 s/chunk actually go?

CoreML / ONNX can only accelerate the transformer encoder. If the encoder is 60 % of the
wall clock, Amdahl caps a 5x encoder speed-up at 2.2x overall — worth knowing before
converting anything. Times the encoder forward, the tokenisation/preprocessing and the
python-side head work separately, on real chunks.
"""
import os
import re
import sys
import time

import torch
from gliner2 import GLiNER2

S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, "/Users/tsardet/Documents/GitHub/PieceMaker_Claude_CLI/websocket-server/scripts")

from bench_backend import BATCH, DESCS, FLOOR, chunk  # noqa: E402

torch.set_num_threads(6)
torch.set_grad_enabled(False)

text = open(os.path.join(S, "slice_C.md"), encoding="utf-8").read()
chunks = chunk(text)

model = GLiNER2.from_pretrained("fastino/gliner2-multi-v1")
model.eval()

stats = {"encoder_s": 0.0, "calls": 0, "tokens": []}
real_forward = model.encoder.forward


def timed_forward(input_ids=None, attention_mask=None, **kw):
    t = time.perf_counter()
    out = real_forward(input_ids=input_ids, attention_mask=attention_mask, **kw)
    stats["encoder_s"] += time.perf_counter() - t
    stats["calls"] += 1
    stats["tokens"].append(tuple(input_ids.shape))
    return out


model.encoder.forward = timed_forward

# Warm-up
model.batch_extract_entities([chunks[0]], DESCS, batch_size=1, threshold=FLOOR,
                             include_confidence=True, include_spans=True)
stats["encoder_s"], stats["calls"], stats["tokens"] = 0.0, 0, []

t0 = time.perf_counter()
for i in range(0, len(chunks), BATCH):
    model.batch_extract_entities(chunks[i:i + BATCH], DESCS, batch_size=BATCH,
                                 threshold=FLOOR, include_confidence=True, include_spans=True)
total = time.perf_counter() - t0

enc = stats["encoder_s"]
print(f"chunks           : {len(chunks)}")
print(f"encoder calls    : {stats['calls']}  shapes {sorted(set(stats['tokens']))}")
print(f"total            : {total:.2f}s   ({total / len(chunks):.3f} s/chunk)")
print(f"encoder          : {enc:.2f}s   {100 * enc / total:.1f} %")
print(f"tout le reste    : {total - enc:.2f}s   {100 * (total - enc) / total:.1f} %")
for speedup in (2, 3, 5, 100):
    new = enc / speedup + (total - enc)
    print(f"  si encodeur {speedup}x plus rapide -> {new:.2f}s  = {total / new:.2f}x global")
