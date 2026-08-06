#!/usr/bin/env python3
"""Run each configuration ONCE at a very low threshold, storing every prediction with
its score. The threshold can then be swept offline at zero extra inference cost.

Configurations vary: checkpoint, label descriptions, chunk size / overlap.
"""
import json, os, re, sys, time
import torch
from gliner2 import GLiNER2

sys.path.insert(0, "/Users/tsardet/Documents/GitHub/PieceMaker_Claude_CLI/websocket-server/scripts")
from scan_utils import normalize_entity_text

S = os.path.dirname(os.path.abspath(__file__))
SLICES = {n: open(os.path.join(S, f"{n}.md"), encoding="utf-8").read()
          for n in ("slice_A", "slice_B", "slice_C")}

MAPPING = {"person": "PERSON", "company": "ORGANIZATION",
           "organization": "ORGANIZATION", "location": "LOCATION"}

# --- label description variants -------------------------------------------------
DESC_BASELINE = {   # what the pipeline ships today
    "person":       "Names of individual human beings or natural persons",
    "company":      "Business entities, commercial companies, corporations of any country",
    "organization": "Non-profit, governmental, or other institutional entities",
    "location":     "Geographic locations, addresses, cities, or countries",
}
DESC_SHARP = {      # spells out the exclusions the baseline leaves implicit
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

PII_LOCAL = os.path.join(S, "pii_ckpt")   # patched copy, see pii_dl.log

CONFIGS = [
    ("baseline",        "fastino/gliner2-multi-v1", DESC_BASELINE, 250, 50),
    ("sharp-desc",      "fastino/gliner2-multi-v1", DESC_SHARP,    250, 50),
    ("chunk180",        "fastino/gliner2-multi-v1", DESC_BASELINE, 180, 20),
    ("chunk120",        "fastino/gliner2-multi-v1", DESC_BASELINE, 120, 15),
    ("sharp+chunk180",  "fastino/gliner2-multi-v1", DESC_SHARP,    180, 20),
    ("pii-ckpt",        PII_LOCAL,                  DESC_BASELINE, 250, 50),
    ("pii-ckpt+sharp",  PII_LOCAL,                  DESC_SHARP,    250, 50),
]

FLOOR = 0.05  # ask for everything; threshold is applied offline


def chunk(text, max_words, overlap):
    spans = [(m.start(), m.end()) for m in re.finditer(r"\S+", text)]
    step = max(1, max_words - overlap)
    out = []
    for i in range(0, len(spans), step):
        g = spans[i:i + max_words]
        out.append({"text": text[g[0][0]:g[-1][1]], "off": g[0][0]})
        if i + max_words >= len(spans):
            break
    return out


def run(model, text, descs, cs, ov):
    chunks = chunk(text, cs, ov)
    preds = {}
    for i in range(0, len(chunks), 8):
        batch = [c["text"] for c in chunks[i:i + 8]]
        res = model.batch_extract_entities(batch, descs, batch_size=8, threshold=FLOOR,
                                           include_confidence=True, include_spans=True)
        for c, r in zip(chunks[i:i + 8], res):
            for label, matches in r.get("entities", {}).items():
                etype = MAPPING.get(label, label.upper())
                for m in matches:
                    key = (etype, normalize_entity_text(m["text"]))
                    if not key[1]:
                        continue
                    preds[key] = max(preds.get(key, 0.0), m["confidence"])
    return [{"type": t, "text": x, "score": s} for (t, x), s in preds.items()]


def main():
    torch.set_num_threads(6)
    out = {}
    loaded, model = None, None
    for name, ckpt, descs, cs, ov in CONFIGS:
        if ckpt != loaded:
            print(f"[load] {ckpt}", flush=True)
            try:
                model = GLiNER2.from_pretrained(ckpt)
            except Exception as exc:
                print(f"  !! {name} ignore: {type(exc).__name__}: {exc}", flush=True)
                loaded = None
                continue
            loaded = ckpt
        out[name] = {"checkpoint": ckpt, "chunk": [cs, ov], "slices": {}}
        for sname, text in SLICES.items():
            t = time.perf_counter()
            out[name]["slices"][sname] = run(model, text, descs, cs, ov)
            print(f"  {name}/{sname}: {len(out[name]['slices'][sname])} entites "
                  f"en {time.perf_counter()-t:.1f}s", flush=True)
        with open(os.path.join(S, "sweep_results.json"), "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(S, "sweep_results.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print("WROTE sweep_results.json", flush=True)


if __name__ == "__main__":
    main()
