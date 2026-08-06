#!/usr/bin/env python3
"""Benchmark one inference backend on the three reference slices.

Runs ONE backend per process so the timing and the resident memory are not polluted by
another backend's allocations, and appends the result to bench_results.json.

Predictions are stored in the exact shape sweep.py produces, so evaluate.py's scoring
(recall over distinct gold entities, precision weighted by blast radius) applies to a
backend exactly as it applies to a configuration — the point being that a speed-up is
only worth keeping if the corpus score does not move.

    python3 bench_backend.py fp32
    python3 bench_backend.py int8
"""
import json
import os
import re
import resource
import sys
import time

import torch
from gliner2 import GLiNER2

sys.path.insert(0, "/Users/tsardet/Documents/GitHub/PieceMaker_Claude_CLI/websocket-server/scripts")
from scan_utils import normalize_entity_text  # noqa: E402

S = os.path.dirname(os.path.abspath(__file__))
SLICES = {n: open(os.path.join(S, f"{n}.md"), encoding="utf-8").read()
          for n in ("slice_A", "slice_B", "slice_C")}

CKPT = "fastino/gliner2-multi-v1"
MAPPING = {"person": "PERSON", "company": "ORGANIZATION",
           "organization": "ORGANIZATION", "location": "LOCATION"}

# Verbatim from scanner_worker.py — the descriptions in production.
DESCS = {
    "person": ("Full name of a specific individual human being, such as Bernard Gilly or "
               "Mrs Laurence Rodriguez. Never a job title, never a role, never an acronym, "
               "never a gene or a product name"),
    "company": ("Name of a specific named commercial company, such as Novartis or Sofinnova "
                "Partners SAS. Never a generic word like company, group or shareholders"),
    "organization": ("Name of a specific named institution, agency or regulator, such as FDA, "
                     "EMA or Inserm. Never a generic body such as board of directors, "
                     "committee or working group"),
    "location": ("Name of a specific geographic place: a country, a city, a region or a postal "
                 "address. Never a nationality adjective such as French or European, never an "
                 "anatomical part"),
}

CHUNK_SIZE, OVERLAP, BATCH = 250, 50, 8
FLOOR = 0.05  # store everything; the threshold is swept offline


def chunk(text, max_words=CHUNK_SIZE, overlap=OVERLAP):
    spans = [(m.start(), m.end()) for m in re.finditer(r"\S+", text)]
    step = max(1, max_words - overlap)
    out = []
    for i in range(0, len(spans), step):
        g = spans[i:i + max_words]
        out.append(text[g[0][0]:g[-1][1]])
        if i + max_words >= len(spans):
            break
    return out


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
                    if not key[1]:
                        continue
                    preds[key] = max(preds.get(key, 0.0), m["confidence"])
    elapsed = time.perf_counter() - t0
    return [{"type": t, "text": x, "score": s} for (t, x), s in preds.items()], elapsed, len(chunks)


def build_fp32():
    return GLiNER2.from_pretrained(CKPT)


def build_int8():
    """Dynamic int8 on every nn.Linear.

    The earlier attempt failed with NoQEngine: torch.backends.quantized.engine defaults
    to 'none' on this build even though qnnpack is in supported_engines. Setting it
    explicitly is the whole fix — no different torch wheel is needed.
    """
    torch.backends.quantized.engine = "qnnpack"
    model = GLiNER2.from_pretrained(CKPT)
    qmodel = torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
    return qmodel


BACKENDS = {"fp32": build_fp32, "int8": build_int8}


def main():
    name = sys.argv[1]
    torch.set_num_threads(int(os.environ.get("PIECEMAKER_TORCH_THREADS", "6")))
    torch.set_grad_enabled(False)

    t0 = time.perf_counter()
    model = BACKENDS[name]()
    model.eval()
    load_s = time.perf_counter() - t0

    # Warm-up: the first forward pays lazy allocator and kernel-selection costs that
    # would otherwise be charged to slice_A.
    model.batch_extract_entities(["Bernard Gilly, GenSight Biologics, Paris."], DESCS,
                                 batch_size=1, threshold=FLOOR, include_confidence=True,
                                 include_spans=True)

    entry = {"checkpoint": CKPT, "chunk": [CHUNK_SIZE, OVERLAP], "backend": name,
             "load_s": round(load_s, 1), "slices": {}, "timing": {}}
    total_s, total_chunks = 0.0, 0
    for sname, text in SLICES.items():
        preds, secs, nch = run_slice(model, text)
        entry["slices"][sname] = preds
        entry["timing"][sname] = {"seconds": round(secs, 2), "chunks": nch,
                                  "s_per_chunk": round(secs / nch, 3)}
        total_s += secs
        total_chunks += nch
        print(f"  {name}/{sname}: {len(preds)} entites, {nch} chunks en {secs:.1f}s "
              f"({secs / nch:.2f} s/chunk)", flush=True)

    entry["total_s"] = round(total_s, 2)
    entry["total_chunks"] = total_chunks
    entry["s_per_chunk"] = round(total_s / total_chunks, 3)
    entry["rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1)

    path = os.path.join(S, "bench_results.json")
    all_res = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    all_res[name] = entry
    json.dump(all_res, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"[{name}] load {load_s:.1f}s · {total_s:.1f}s / {total_chunks} chunks "
          f"= {total_s / total_chunks:.3f} s/chunk · RSS {entry['rss_mb']:.0f} Mo", flush=True)


if __name__ == "__main__":
    main()
