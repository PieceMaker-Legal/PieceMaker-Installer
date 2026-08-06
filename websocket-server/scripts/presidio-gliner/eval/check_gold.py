#!/usr/bin/env python3
"""Consistency checks on the reference annotation itself.

The ranking of every configuration rests on gold.py, so gold.py needs auditing too.
Two failure modes are detectable without a second annotator:

  1. an entity annotated in a slice whose text does not actually contain it;
  2. an entity annotated in one slice but silently left out of another slice that
     contains it — which would score a correct detection as a false positive.

Run after any edit to gold.py.
"""
import os, re, sys, unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gold import GOLD, PERSON_KEY

S = os.path.dirname(os.path.abspath(__file__))
TEXT = {n: open(os.path.join(S, f"{n}.md"), encoding="utf-8").read() for n in GOLD}

# Occurrences that are explained and deliberately left un-annotated. Keeping them
# here rather than in a comment means the check stays green and the reasoning
# survives; anything NOT listed shows up as a finding.
ACCEPTED = {
    ("LOCATION", "France", "slice_C"):
        "only occurs inside the company name 'GenSight Biologics France SAS'; it is "
        "not a standalone place mention, so tagging it LOCATION is a genuine model "
        "error that resolve_overlapping_spans drops as a nested span",
    ("ORGANIZATION", "GenSight", "slice_B"):
        "page footer 'GENSIGHT BIOLOGICS'; already covered by the gold entry "
        "'GenSight Biologics', which the matcher reaches by containment",
    ("ORGANIZATION", "GenSight", "slice_C"):
        "same page footer as slice_B",
}

present = lambda key, text: bool(re.search(r"(?<!\w)" + re.escape(key) + r"(?!\w)", text, re.I))
findings = []

for sname, gold in GOLD.items():
    for etype, items in gold.items():
        for e in items:
            key = PERSON_KEY.get(e, e) if etype == "PERSON" else e
            if not present(key, TEXT[sname]):
                findings.append(f"annotated but absent: {sname} {etype}:{e!r}")

annotated = {}
for sname, gold in GOLD.items():
    for etype, items in gold.items():
        for e in items:
            annotated.setdefault((etype, e), set()).add(sname)

for (etype, e), where in sorted(annotated.items()):
    key = PERSON_KEY.get(e, e) if etype == "PERSON" else e
    for sname in GOLD:
        if sname in where or not present(key, TEXT[sname]):
            continue
        if (etype, e, sname) in ACCEPTED:
            continue
        findings.append(
            f"present but not annotated: {etype}:{e!r} in {sname} "
            f"(annotated in {sorted(where)})")

for f in findings:
    print("  FINDING:", f)
print(f"\n{len(findings)} finding(s); {len(ACCEPTED)} occurrence(s) accepted with a documented reason.")
sys.exit(1 if findings else 0)
