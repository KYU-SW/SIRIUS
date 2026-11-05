"""학습된 CNN 을 온도 보정하고 ONNX 로 내보냅니다 (원본 모델·활성 모델은 건드리지 않음).

    python export_onnx.py --run runs/cnn_a --out models/cnn_v1 --name "SiriusNet v1"

· 온도: val 로짓에서 NLL 최소화(val 만 사용)
· 출력: model.onnx(입력 input[B,1,128,128]; 출력 probs[B,4], cam[B,4,16,16]), model_meta.json(해시·버전·보정값)
· 검증: onnxruntime 출력이 PyTorch 출력과 일치하는지 확인
"""
import argparse, hashlib, json, os, datetime
import numpy as np
import torch
import torch.nn.functional as F

from cnn import Export, SiriusNet
from features import CLASS_DIRS


def fit_temperature(logits, y):
    lg = torch.tensor(logits); yy = torch.tensor(y); lt = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([lt], lr=0.1, max_iter=200)
    def step():
        opt.zero_grad(); l = F.cross_entropy(lg / lt.exp(), yy); l.backward(); return l
    opt.step(step)
    return float(lt.exp())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--out", required=True); ap.add_argument("--name", required=True)
    ap.add_argument("--trained-on", default="user-supplied archive.zip (MRI Dataset; origin unverified)")
    a = ap.parse_args()
    hist = json.load(open(os.path.join(a.run, "history.json")))
    net = SiriusNet(width=hist["args"]["width"], drop=hist["args"]["drop"])
    net.load_state_dict(torch.load(os.path.join(a.run, "best.pt"), map_location="cpu")); net.eval()
    lg = np.load(os.path.join(a.run, "val_logits.npy")); y = np.load(os.path.join(a.run, "val_labels.npy"))
    nll0 = float(F.cross_entropy(torch.tensor(lg), torch.tensor(y)))
    T = fit_temperature(lg, y)
    nll1 = float(F.cross_entropy(torch.tensor(lg) / T, torch.tensor(y)))
    os.makedirs(a.out, exist_ok=True)
    m = Export(net, T).eval(); x = torch.rand(2, 1, 128, 128)
    path = os.path.join(a.out, "model.onnx")
    torch.onnx.export(m, x, path, input_names=["input"], output_names=["probs", "cam"],
                      dynamic_axes={"input": {0: "b"}, "probs": {0: "b"}, "cam": {0: "b"}}, opset_version=17, dynamo=False)
    import onnxruntime as ort
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    xs = torch.rand(8, 1, 128, 128)
    with torch.no_grad():
        pt_p, pt_c = m(xs)
    op, oc = s.run(["probs", "cam"], {"input": xs.numpy()})
    d_p, d_c = float(np.abs(op - pt_p.numpy()).max()), float(np.abs(oc - pt_c.numpy()).max())
    assert d_p < 1e-4 and d_c < 1e-3, (d_p, d_c)
    sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
    meta = {"name": a.name, "format": "onnx", "classes": CLASS_DIRS, "input": "gray float32 [B,1,128,128] in [0,1]",
            "outputs": ["probs[B,4]", "cam[B,4,16,16]"], "sha256": sha, "temperature": round(T, 4),
            "val_nll_before_after_calibration": [round(nll0, 4), round(nll1, 4)],
            "best_epoch": hist["best_epoch"], "validation_macro_f1": round(hist["best_val_macro_f1"], 4),
            "params": hist["params"], "trained_on": a.trained_on, "trained_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "onnx_parity_max_abs_diff": {"probs": d_p, "cam": d_c}, "clinical_validation": False,
            "test_status": "see eval_*.json; patient-level independence not established"}
    json.dump(meta, open(os.path.join(a.out, "model_meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
