#!/usr/bin/env python3
"""Drive the real scanner_worker.py through its stdin/stdout protocol, once with CoreML and
once without, and diff the two sensitive_map.json files.

The benchmarks measured the encoder inside a hand-built harness. This measures the thing
that actually ships: the worker process, its presidio pipeline, its pattern recognizers, its
span arbitration and its JSON output. If the CoreML path changed anything the user would
see, the diff shows it here and nowhere else.

    python3 verify_worker.py <fichier.md>
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = os.path.join(HERE, "scanner_worker.py")


def run(md_file, out_dir, coreml: bool):
    env = dict(os.environ, PIECEMAKER_COREML="1" if coreml else "0")
    p = subprocess.Popen([sys.executable, WORKER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, env=env, bufsize=1)

    # The worker logs one line per detected entity. Reading stderr only at the end fills
    # the 64 KB pipe on any large document and the worker blocks forever inside its own
    # print — GENSIGHT deadlocked here for 25 minutes. Drain it continuously instead.
    err_lines = []

    def drain():
        for line in p.stderr:
            err_lines.append(line)

    err_thread = threading.Thread(target=drain, daemon=True)
    err_thread.start()

    # The worker prints READY on stdout once the models are loaded.
    t0 = time.perf_counter()
    while True:
        line = p.stdout.readline()
        if not line:
            raise RuntimeError("worker mort avant READY:\n" + "".join(err_lines)[-2000:])
        if line.strip() == "READY":
            break
    ready_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    p.stdin.write(json.dumps({"cmd": "scan", "md_file": md_file, "output_dir": out_dir}) + "\n")
    p.stdin.flush()
    resp = json.loads(p.stdout.readline())
    scan_s = time.perf_counter() - t0

    p.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
    p.stdin.flush()
    p.wait(timeout=60)
    err_thread.join(timeout=10)
    err = "".join(err_lines)

    if resp.get("status") != "ok":
        raise RuntimeError(f"scan echoue: {resp}\n{err[-2000:]}")

    active = "CoreML GPU encoder active" in err
    fallback = [l for l in err.splitlines() if "torch CPU" in l or "falling back" in l]
    return resp["json_path"], ready_s, scan_s, active, fallback


def entities(path):
    """`entities` is keyed by entity type, each holding a list of occurrences."""
    payload = json.load(open(path, encoding="utf-8"))
    return {(etype, e["text"], e["start"], e["end"])
            for etype, items in payload["entities"].items() for e in items}


def main():
    md = sys.argv[1]
    print(f"document: {os.path.basename(md)}\n")
    results = {}
    for label, coreml in (("torch", False), ("coreml", True)):
        with tempfile.TemporaryDirectory() as d:
            path, ready_s, scan_s, active, notes = run(md, d, coreml)
            ents = entities(path)
            results[label] = ents
            flag = "ACTIF" if active else "inactif"
            print(f"{label:<7} demarrage {ready_s:>6.1f}s · scan {scan_s:>6.1f}s · "
                  f"CoreML {flag} · {len(ents)} entites")
            for n in notes:
                print(f"         {n.strip()}")

    a, b = results["torch"], results["coreml"]
    print(f"\nentites torch {len(a)} · coreml {len(b)} · communes {len(a & b)}")
    if a == b:
        print("\nIDENTIQUE — sortie du worker strictement inchangee")
    else:
        print(f"\nDIFFERENCES ({len(a ^ b)}):")
        for x in sorted(a - b)[:20]:
            print(f"  seulement torch : {x}")
        for x in sorted(b - a)[:20]:
            print(f"  seulement coreml: {x}")


if __name__ == "__main__":
    main()
