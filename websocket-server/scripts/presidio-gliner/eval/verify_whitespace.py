#!/usr/bin/env python3
"""Check the whitespace normalisation against the criterion the plan set for it:
"zero entity containing \\n or a double space in the sensitive_map", and the 1273 ->
971 collapse of falsely-distinct entities.

An entity carrying a hard line break was, before the fix, escaped literally into the
substitution regex — so it matched only where that exact run of whitespace occurred, i.e.
almost nowhere. Those entities were detected and then never redacted: the one real PII
leak the audit found (277 entities on GENSIGHT).

    python3 verify_whitespace.py <document_sensitive_map.json> [document.md]
"""
import json
import re
import sys
import unicodedata

NBSP = "   "
ZERO_WIDTH = "​‌‍﻿"


def main():
    payload = json.load(open(sys.argv[1], encoding="utf-8"))
    ents = [(etype, e["text"]) for etype, items in payload["entities"].items() for e in items]

    bad_nl = [(t, x) for t, x in ents if "\n" in x]
    bad_dbl = [(t, x) for t, x in ents if re.search(r"[ \t]{2,}", x)]
    bad_nbsp = [(t, x) for t, x in ents if any(c in x for c in NBSP)]
    bad_zw = [(t, x) for t, x in ents if any(c in x for c in ZERO_WIDTH)]

    print(f"occurrences dans le sensitive_map : {len(ents)}")
    print(f"entités distinctes (texte)        : {len({x for _, x in ents})}\n")

    print(f"contenant un saut de ligne \\n     : {len(bad_nl)}")
    print(f"contenant un double espace        : {len(bad_dbl)}")
    print(f"contenant une espace insécable    : {len(bad_nbsp)}")
    print(f"contenant une espace de largeur 0 : {len(bad_zw)}")

    for label, items in (("\\n", bad_nl), ("double espace", bad_dbl),
                         ("insécable", bad_nbsp), ("largeur nulle", bad_zw)):
        for t, x in items[:5]:
            print(f"   [{label}] {t}: {x!r}")

    # False distinctness: how many entities would be extra without normalisation.
    raw = {x for _, x in ents}
    norm = {re.sub(r"\s+", " ", unicodedata.normalize("NFKC", x)).strip() for x in raw}
    print(f"\nentités distinctes brutes {len(raw)} -> normalisées {len(norm)} "
          f"({len(raw) - len(norm)} faux distincts restants)")

    total_bad = len(bad_nl) + len(bad_dbl) + len(bad_nbsp) + len(bad_zw)
    print(f"\nCRITERE «0 entité avec \\n ou double espace» : {'TENU' if total_bad == 0 else 'ECHOUE'}")

    if len(sys.argv) > 2:
        text = open(sys.argv[2], encoding="utf-8").read()
        # An entity that never occurs verbatim in the document would never be substituted
        # by a literal regex — the leak the normalisation is meant to close.
        missing = [x for x in raw if x and x not in text]
        print(f"\nentités absentes du document tel quel (donc jamais substituées "
              f"par une regex littérale) : {len(missing)}")
        for x in missing[:8]:
            print(f"   {x!r}")

    sys.exit(0 if total_bad == 0 else 1)


if __name__ == "__main__":
    main()
