#!/usr/bin/env python3
"""Score every configuration against the reference annotation, sweeping the threshold
offline (the sweep stored all predictions down to 0.05).

Metric rationale — anonymisation substitutes entity strings globally, so:
  * RECALL is over DISTINCT gold entities: finding an entity once redacts every mention.
    A miss is PII left in a document handed to a third party.
  * PRECISION matters more than usual: a false positive is not one redacted word, it is
    every occurrence of that string rewritten across the whole document.
"""
import json, os, sys, unicodedata, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gold import GOLD, PERSON_KEY

S = os.path.dirname(os.path.abspath(__file__))
# Defaults to the configuration sweep; pass bench_results.json explicitly to score
# inference backends with this exact scoring.
RESULTS_FILE = sys.argv[1] if len(sys.argv) > 1 else "sweep_results.json"
OUT_FILE = sys.argv[2] if len(sys.argv) > 2 else "eval_results.json"
RES = json.load(open(os.path.join(S, RESULTS_FILE), encoding="utf-8"))
SLICE_TEXT = {n: open(os.path.join(S, f"{n}.md"), encoding="utf-8").read()
              for n in ("slice_A", "slice_B", "slice_C")}

norm = lambda s: re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s)).strip().lower()


def matches(pred_text, pred_type, gold_text, gold_type):
    if pred_type != gold_type:
        return False
    p, g = norm(pred_text), norm(gold_text)
    if gold_type == "PERSON":
        return PERSON_KEY.get(gold_text, g) in p
    return p == g or p in g or g in p


def is_fragment(pred_text, pred_type, gold):
    """A prediction that is a strict part of a gold entity of the same type.

    "Elsy" alongside the correctly detected "Elsy Boglioli" is not a hallucination:
    it is a shorter span nested inside a real entity, and resolve_overlapping_spans
    deletes it before anything reaches the mapping. Counting it as a false positive
    would charge the model for something the pipeline already removes, so fragments
    are reported separately and excluded from precision.
    """
    p = norm(pred_text)
    for gtype, gitems in gold.items():
        if gtype != pred_type:
            continue
        for g in gitems:
            ng = norm(g)
            if p != ng and p in ng:
                return True
    return False


def score(preds, slice_name, threshold):
    gold = GOLD[slice_name]
    kept = [p for p in preds if p["score"] >= threshold]

    found, missed = 0, []
    for gtype, gitems in gold.items():
        for g in gitems:
            if any(matches(p["text"], p["type"], g, gtype) for p in kept):
                found += 1
            else:
                missed.append(f"{gtype}:{g}")
    total_gold = sum(len(v) for v in gold.values())

    tp, fp, frag = 0, [], []
    for p in kept:
        if any(matches(p["text"], p["type"], g, gtype)
               for gtype, gitems in gold.items() for g in gitems):
            tp += 1
        elif is_fragment(p["text"], p["type"], gold):
            frag.append(f"{p['type']}:{p['text']}")
        else:
            fp.append(f"{p['type']}:{p['text']}")
    scored = tp + len(fp)  # fragments are removed by span arbitration, not charged
    return {
        "recall": found / total_gold if total_gold else 1.0,
        "precision": tp / scored if scored else 1.0,
        "n_pred": len(kept), "gold": total_gold,
        "missed": missed, "fp": fp, "fragments": frag,
    }


def blast(fp_labels, slice_name):
    """How many words of the document a config's false positives would rewrite."""
    text = SLICE_TEXT[slice_name]
    total = 0
    for lab in fp_labels:
        ent = lab.split(":", 1)[1]
        if len(ent) < 2:
            continue
        total += len(re.findall(r"(?<!\w)" + re.escape(ent) + r"(?!\w)", text, re.I))
    return total


THRESHOLDS = [0.05, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90]

print(f"{'config':<16}{'thr':>5}{'rappel':>9}{'precis.':>9}{'F1':>7}{'F2':>7}"
      f"{'pred':>6}{'FP mots':>9}")
print("-" * 68)
best = []
for cfg, data in RES.items():
    for thr in THRESHOLDS:
        R = P = 0.0
        npred = fpw = 0
        allmissed, allfp, allfrag = [], [], []
        for sname in SLICE_TEXT:
            s = score(data["slices"][sname], sname, thr)
            R += s["recall"] / 3
            P += s["precision"] / 3
            npred += s["n_pred"]
            allmissed += s["missed"]
            allfp += s["fp"]
            allfrag += s.get("fragments", [])
            fpw += blast(s["fp"], sname)
        f1 = 2 * P * R / (P + R) if P + R else 0
        f2 = 5 * P * R / (4 * P + R) if P + R else 0
        print(f"{cfg:<16}{thr:>5.2f}{R:>9.3f}{P:>9.3f}{f1:>7.3f}{f2:>7.3f}{npred:>6}{fpw:>9}")
        best.append((cfg, thr, R, P, f1, f2, npred, fpw, allmissed, allfp, allfrag))
    print("-" * 68)

json.dump([{"config": b[0], "threshold": b[1], "recall": b[2], "precision": b[3],
            "f1": b[4], "f2": b[5], "n_pred": b[6], "fp_words": b[7],
            "missed": b[8], "fp": b[9], "fragments": b[10]} for b in best],
          open(os.path.join(S, OUT_FILE), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print(f"\nWROTE {OUT_FILE}")
