#!/usr/bin/env python3
"""Isolate the mdeberta encoder (92 % of the wall clock) and time it under every backend
available on this machine, on the real tensors the pipeline feeds it.

Backends compared, all on the same captured batch:
  torch-fp32   what ships today (Accelerate/AMX GEMM on the M1's performance cores)
  ort-cpu      onnxruntime, CPU execution provider
  ort-coreml   onnxruntime, CoreML execution provider (GPU + Neural Engine)
  ort-int8     onnxruntime dynamic int8 quantisation, CPU

Also reports max |Δ| on last_hidden_state against torch-fp32: a backend that is fast but
drifts is caught here, before spending an hour on the corpus.

    python3 encoder_backends.py capture   # dump real input tensors
    python3 encoder_backends.py export    # torch -> onnx
    python3 encoder_backends.py bench
"""
import json
import os
import sys
import time

import numpy as np
import torch

S = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(S, "artifacts")
os.makedirs(ART, exist_ok=True)
INPUTS = os.path.join(ART, "encoder_inputs.pt")
ONNX_FP32 = os.path.join(ART, "encoder_fp32.onnx")
ONNX_INT8 = os.path.join(ART, "encoder_int8.onnx")
# CoreML refuses unbounded dimensions ("has unbounded dimension which is not supported"),
# so the dynamic export gets partitioned into 97 fragments and falls back. A static-shape
# export is the only one CoreML can actually compile.
ONNX_STATIC = os.path.join(ART, "encoder_static.onnx")
RESULTS = os.path.join(ART, "encoder_bench.json")

torch.set_num_threads(6)
torch.set_grad_enabled(False)


def load_model():
    from gliner2 import GLiNER2
    m = GLiNER2.from_pretrained("fastino/gliner2-multi-v1")
    m.eval()
    return m


# ---------------------------------------------------------------------------
def capture():
    """Run one real batch through the pipeline and keep the encoder's inputs."""
    from bench_backend import BATCH, DESCS, FLOOR, chunk
    text = open(os.path.join(S, "slice_C.md"), encoding="utf-8").read()
    chunks = chunk(text)[:BATCH]

    model = load_model()
    grabbed = {}
    real = model.encoder.forward

    def grab(input_ids=None, attention_mask=None, **kw):
        if "input_ids" not in grabbed:
            grabbed["input_ids"] = input_ids.detach().clone()
            grabbed["attention_mask"] = attention_mask.detach().clone()
        return real(input_ids=input_ids, attention_mask=attention_mask, **kw)

    model.encoder.forward = grab
    model.batch_extract_entities(chunks, DESCS, batch_size=BATCH, threshold=FLOOR,
                                 include_confidence=True, include_spans=True)
    torch.save(grabbed, INPUTS)
    print(f"capture: input_ids {tuple(grabbed['input_ids'].shape)} -> {INPUTS}")


# ---------------------------------------------------------------------------
def export():
    inp = torch.load(INPUTS)
    model = load_model()
    encoder = model.encoder

    class Wrap(torch.nn.Module):
        """last_hidden_state only — the heads stay in torch, they are 8 % of the time."""

        def __init__(self, enc):
            super().__init__()
            self.enc = enc

        def forward(self, input_ids, attention_mask):
            return self.enc(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state

    wrap = Wrap(encoder).eval()
    print("exporting to ONNX (opset 17)...", flush=True)
    torch.onnx.export(
        wrap, (inp["input_ids"], inp["attention_mask"]), ONNX_FP32,
        input_names=["input_ids", "attention_mask"], output_names=["last_hidden_state"],
        dynamic_axes={"input_ids": {0: "b", 1: "s"}, "attention_mask": {0: "b", 1: "s"},
                      "last_hidden_state": {0: "b", 1: "s"}},
        opset_version=17, do_constant_folding=True, dynamo=False,
    )
    print(f"export: {ONNX_FP32} ({os.path.getsize(ONNX_FP32) / 1e6:.0f} Mo)")

    from onnxruntime.quantization import QuantType, quantize_dynamic
    print("quantizing int8 (dynamic, per-channel)...", flush=True)
    quantize_dynamic(ONNX_FP32, ONNX_INT8, weight_type=QuantType.QInt8, per_channel=True)
    print(f"export: {ONNX_INT8} ({os.path.getsize(ONNX_INT8) / 1e6:.0f} Mo)")

    print("exporting static-shape ONNX for CoreML...", flush=True)
    torch.onnx.export(
        wrap, (inp["input_ids"], inp["attention_mask"]), ONNX_STATIC,
        input_names=["input_ids", "attention_mask"], output_names=["last_hidden_state"],
        opset_version=17, do_constant_folding=True, dynamo=False,
    )
    print(f"export: {ONNX_STATIC} ({os.path.getsize(ONNX_STATIC) / 1e6:.0f} Mo)")


# ---------------------------------------------------------------------------
def _time(fn, n=3):
    fn()  # warm-up
    ts = []
    for _ in range(n):
        t = time.perf_counter()
        fn()
        ts.append(time.perf_counter() - t)
    return min(ts), sum(ts) / len(ts)


REF_NPY = os.path.join(ART, "encoder_ref.npy")

COREML = {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL"}
ORT_BACKENDS = {
    "ort-cpu":           (ONNX_FP32,   ["CPUExecutionProvider"]),
    "ort-int8":          (ONNX_INT8,   ["CPUExecutionProvider"]),
    "ort-coreml-dyn":    (ONNX_FP32,   [("CoreMLExecutionProvider", COREML), "CPUExecutionProvider"]),
    "ort-coreml-static": (ONNX_STATIC, [("CoreMLExecutionProvider", COREML), "CPUExecutionProvider"]),
    "ort-coreml-ane":    (ONNX_STATIC, [("CoreMLExecutionProvider", dict(COREML, MLComputeUnits="CPUAndNeuralEngine")),
                                        "CPUExecutionProvider"]),
}


def _save(name, entry):
    all_res = json.load(open(RESULTS, encoding="utf-8")) if os.path.exists(RESULTS) else {}
    all_res[name] = entry
    json.dump(all_res, open(RESULTS, "w"), indent=1)
    print(f"\n[{name}] {entry}")


def bench():
    """One backend per process — a torch model plus three 1 GB ORT sessions in the same
    process is killed by the OOM killer on this 8 GB machine (exit 137)."""
    name = sys.argv[2]
    inp = torch.load(INPUTS)
    ids, mask = inp["input_ids"], inp["attention_mask"]

    if name == "torch-fp32":
        enc = load_model().encoder
        ref = enc(input_ids=ids, attention_mask=mask).last_hidden_state
        np.save(REF_NPY, ref.numpy())
        best, avg = _time(lambda: enc(input_ids=ids, attention_mask=mask))
        _save(name, {"best_s": best, "avg_s": avg, "max_delta": 0.0,
                     "shape": list(ids.shape)})
        return

    import onnxruntime as ort
    path, providers = ORT_BACKENDS[name]
    ref = np.load(REF_NPY)
    feed = {"input_ids": ids.numpy(), "attention_mask": mask.numpy()}
    try:
        so = ort.SessionOptions()
        so.intra_op_num_threads = 6
        sess = ort.InferenceSession(path, so, providers=providers)
        out = sess.run(None, feed)[0]
        d = float(np.abs(out - ref).max())
        best, avg = _time(lambda: sess.run(None, feed))
        _save(name, {"best_s": best, "avg_s": avg, "max_delta": d,
                     "providers": sess.get_providers()})
    except Exception as exc:
        _save(name, {"error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    {"capture": capture, "export": export, "bench": bench}[sys.argv[1]]()
