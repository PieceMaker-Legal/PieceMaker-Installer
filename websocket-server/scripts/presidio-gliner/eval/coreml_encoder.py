#!/usr/bin/env python3
"""Direct coremltools conversion of the mdeberta encoder — the fair test of the ANE.

onnxruntime's CoreML execution provider is not a verdict on the Neural Engine: it only
claimed 592 of 1825 nodes and split the graph into 25 partitions, so every forward pass
would pay 25 CPU<->CoreML round trips. coremltools converts the whole traced graph into
one MLProgram instead, which is the only way to know whether mdeberta can run on the ANE
at all.

Batch 1 (not 8): conversion peaks at several GB and this machine has 8. The comparison is
therefore against torch at batch 1 too — same tensor, same process, same threads.

    python3 coreml_encoder.py convert
    python3 coreml_encoder.py bench {torch,all,ane,cpugpu}
"""
import json
import os
import sys
import time

import numpy as np
import torch

S = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(S, "artifacts")
INPUTS = os.path.join(ART, "encoder_inputs.pt")

torch.set_num_threads(6)
torch.set_grad_enabled(False)


class Wrap(torch.nn.Module):
    def __init__(self, enc):
        super().__init__()
        self.enc = enc

    def forward(self, input_ids, attention_mask):
        return self.enc(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state


# Sequence length of the converted model. 772 was simply the length of the captured batch;
# it turned out to be too short for French: real batches reach 811 tokens (padding is to the
# longest sequence in the batch), so 2 of 3 batches of the Assignation fell back to torch and
# most of the speed-up was lost. 832 covers every length measured on the Dossier AVION.
SEQ = int(os.environ.get("PIECEMAKER_COREML_SEQ", "832"))
MLPKG = os.path.join(ART, f"encoder_b1_{SEQ}.mlpackage")
REF1 = os.path.join(ART, f"encoder_ref_b1_{SEQ}.npy")
RESULTS = os.path.join(ART, "coreml_bench.json")


def _b1():
    inp = torch.load(INPUTS)
    ids, mask = inp["input_ids"][:1], inp["attention_mask"][:1]
    n = ids.shape[1]
    if n < SEQ:
        ids = torch.nn.functional.pad(ids, (0, SEQ - n))
        mask = torch.nn.functional.pad(mask, (0, SEQ - n))
    return ids[:, :SEQ], mask[:, :SEQ]


def _save(name, entry):
    all_res = json.load(open(RESULTS, encoding="utf-8")) if os.path.exists(RESULTS) else {}
    all_res[name] = entry
    json.dump(all_res, open(RESULTS, "w"), indent=1)
    print(f"[{name}] {entry}", flush=True)


def _patch_deberta_scale():
    """deberta computes its attention scale as sqrt(tensor(query.size(-1)) * factor).

    Under torch.jit.trace, size(-1) becomes a traced int32 tensor and the dtype argument is
    lost, so coremltools receives sqrt(int32) and refuses it ("expects fp16/fp32, got
    int32"). The shape is fixed in this conversion anyway, so folding the scale into a
    python float makes it a constant — mathematically identical, and traceable.
    """
    from transformers.models.deberta_v2 import modeling_deberta_v2 as m

    def scaled_size_sqrt(query_layer, scale_factor):
        return torch.tensor(float(query_layer.size(-1)) * scale_factor).sqrt()

    # The methods resolve the name from module globals at call time, so rebinding the
    # module attribute is enough.
    m.scaled_size_sqrt = scaled_size_sqrt

    # build_rpos carries @torch.jit.script, so its `if` survives tracing as a prim::If
    # whose two branches return different ranks ([1,772,772] vs [1,1,772,772]) — MIL
    # rejects a cond whose branches disagree on type. In self-attention query and key are
    # the same length, so the condition is statically false; evaluating it in python folds
    # the branch away.
    def build_rpos(query_layer, key_layer, relative_pos, position_buckets: int,
                   max_relative_positions: int):
        if key_layer.size(-2) != query_layer.size(-2):
            return m.build_relative_position(key_layer, key_layer, bucket_size=position_buckets,
                                             max_position=max_relative_positions)
        return relative_pos

    m.build_rpos = build_rpos

    # deberta masks with torch.finfo(fp32).min = -3.4e38. That constant is baked into the
    # trace, and it is NOT representable in fp16: CoreML turns it into -inf, a fully masked
    # softmax row becomes 0/0, and the whole output is NaN (measured: max_delta = nan on
    # the GPU). -1e4 is the standard fp16-safe mask value and is just as saturating after
    # softmax.
    _masked_fill = torch.Tensor.masked_fill

    def masked_fill(self, mask, value):
        if isinstance(value, (int, float)) and value < -1e4:
            value = -1e4
        return _masked_fill(self, mask, value)

    torch.Tensor.masked_fill = masked_fill


def convert():
    import coremltools as ct
    from gliner2 import GLiNER2

    _patch_deberta_scale()
    ids, mask = _b1()
    model = GLiNER2.from_pretrained("fastino/gliner2-multi-v1").eval()
    wrap = Wrap(model.encoder).eval()

    ref = wrap(ids, mask)
    np.save(REF1, ref.numpy())
    del model

    print("tracing...", flush=True)
    traced = torch.jit.trace(wrap, (ids, mask), strict=False)

    print("converting to MLProgram (fp16)...", flush=True)
    mlmodel = ct.convert(
        traced,
        inputs=[ct.TensorType(name="input_ids", shape=ids.shape, dtype=np.int32),
                ct.TensorType(name="attention_mask", shape=mask.shape, dtype=np.int32)],
        outputs=[ct.TensorType(name="last_hidden_state")],
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.macOS14,
    )
    mlmodel.save(MLPKG)
    print(f"saved {MLPKG}", flush=True)


def bench():
    which = sys.argv[2]
    ids, mask = _b1()

    if which == "torch":
        from gliner2 import GLiNER2
        enc = GLiNER2.from_pretrained("fastino/gliner2-multi-v1").eval().encoder
        fn = lambda: enc(input_ids=ids, attention_mask=mask)  # noqa: E731
        fn()
        ts = [(_t := time.perf_counter(), fn(), time.perf_counter() - _t)[2] for _ in range(3)]
        _save("torch-fp32-b1", {"best_s": min(ts), "avg_s": sum(ts) / len(ts), "max_delta": 0.0})
        return

    import coremltools as ct
    units = {"all": ct.ComputeUnit.ALL,
             "ane": ct.ComputeUnit.CPU_AND_NE,
             "cpugpu": ct.ComputeUnit.CPU_AND_GPU}[which]
    t0 = time.perf_counter()
    m = ct.models.MLModel(MLPKG, compute_units=units)
    load_s = time.perf_counter() - t0
    print(f"chargement/compilation: {load_s:.1f}s", flush=True)

    feed = {"input_ids": ids.numpy().astype(np.int32),
            "attention_mask": mask.numpy().astype(np.int32)}
    out = m.predict(feed)["last_hidden_state"]
    ref = np.load(REF1)
    d = float(np.abs(out - ref).max())

    ts = []
    for _ in range(3):
        t = time.perf_counter()
        m.predict(feed)
        ts.append(time.perf_counter() - t)
    _save(f"coreml-{which}", {"best_s": min(ts), "avg_s": sum(ts) / len(ts),
                              "max_delta": d, "load_s": round(load_s, 1)})


if __name__ == "__main__":
    {"convert": convert, "bench": bench}[sys.argv[1]]()
