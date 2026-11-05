"""모델 평가 (기존 RF·새 ONNX 를 같은 기준으로).

    python evaluate.py --data "<MRI Dataset>" --manifest reports/leak_manifest.json \
        --model rf   --path model_rf.joblib --split test --name RF_baseline
    python evaluate.py ... --model onnx --path models/cnn_v1/model.onnx --split val --name cnn_v1

· 평가 집합: <split>_all(원래 전체) 과 <split>_clean(전체 train/val 과 같은 원본이 없는 영상만)
· 지표: 정확도(Wilson 95% CI), macro-F1(부트스트랩 95% CI), 클래스별 P/R/F1, 혼동행렬, NLL, ECE
· test 평가는 reports/eval_log.jsonl 에 실행 기록(시각·모델 해시)이 남습니다.
"""
import argparse, hashlib, json, os, time
import numpy as np
from PIL import Image

from features import CLASS_DIRS, IMG_SIZE, hog_feature, to_gray


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (float(c - h), float(c + h))


def prf(y, p, k=4):
    rows = []
    for c in range(k):
        tp = int(((p == c) & (y == c)).sum()); fp = int(((p == c) & (y != c)).sum()); fn = int(((p != c) & (y == c)).sum())
        pr = tp / (tp + fp) if tp + fp else 0.0; rc = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * pr * rc / (pr + rc) if pr + rc else 0.0
        rows.append({"class": CLASS_DIRS[c], "precision": round(pr, 4), "recall": round(rc, 4), "f1": round(f1, 4), "support": tp + fn})
    return rows


def macro(y, p):
    return float(np.mean([r["f1"] for r in prf(y, p)]))


def metrics(y, probs, seed=0):
    p = probs.argmax(1); n = len(y); k = int((p == y).sum())
    rng = np.random.default_rng(seed); bs = []
    for _ in range(1000):
        i = rng.integers(0, n, n); bs.append(macro(y[i], p[i]))
    cm = np.zeros((4, 4), int)
    for t, q in zip(y, p):
        cm[t, q] += 1
    conf = probs.max(1); ece = 0.0
    for lo in np.linspace(0, 1, 11)[:-1]:
        m = (conf > lo) & (conf <= lo + 0.1)
        if m.any():
            ece += m.mean() * abs((p[m] == y[m]).mean() - conf[m].mean())
    return {"n": n, "accuracy": round(k / n, 4), "accuracy_ci95": [round(x, 4) for x in wilson(k, n)],
            "macro_f1": round(macro(y, p), 4), "macro_f1_ci95": [round(float(np.percentile(bs, 2.5)), 4), round(float(np.percentile(bs, 97.5)), 4)],
            "nll": round(float(-np.log(np.clip(probs[np.arange(n), y], 1e-9, 1)).mean()), 4), "ece": round(float(ece), 4),
            "per_class": prf(y, p), "confusion_matrix(rows=true, cols=pred)": cm.tolist(), "class_order": CLASS_DIRS}


def predict_rf(path, grays):
    import joblib
    clf = joblib.load(path)
    return clf.predict_proba(np.stack([hog_feature(g) for g in grays]))


def predict_onnx(path, grays, bs=128):
    import onnxruntime as ort
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    out = []
    for i in range(0, len(grays), bs):
        x = np.stack(grays[i:i + bs]).astype(np.float32)[:, None]
        out.append(s.run(["probs"], {"input": x})[0])
    return np.concatenate(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--manifest", required=True)
    ap.add_argument("--model", choices=["rf", "onnx"], required=True); ap.add_argument("--path", required=True)
    ap.add_argument("--split", choices=["val", "test"], required=True); ap.add_argument("--name", required=True)
    ap.add_argument("--out", default="reports")
    a = ap.parse_args()
    man = json.load(open(a.manifest, encoding="utf-8"))
    all_rels = man[f"{a.split}_all"]; clean = set(man[f"{a.split}_clean"])
    grays = []
    for r in all_rels:
        with Image.open(os.path.join(a.data, r)) as im:
            grays.append(to_gray(im))
    y = np.array([CLASS_DIRS.index(r.split("/")[1]) for r in all_rels])
    probs = predict_rf(a.path, grays) if a.model == "rf" else predict_onnx(a.path, grays)
    m_clean = np.array([r in clean for r in all_rels])
    res = {"name": a.name, "split": a.split, "model_file": os.path.basename(a.path),
           "model_sha256": hashlib.sha256(open(a.path, "rb").read()).hexdigest(),
           "all": metrics(y, probs), "clean": metrics(y[m_clean], probs[m_clean])}
    os.makedirs(a.out, exist_ok=True)
    json.dump(res, open(os.path.join(a.out, f"eval_{a.name}_{a.split}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    np.save(os.path.join(a.out, f"probs_{a.name}_{a.split}.npy"), probs)
    with open(os.path.join(a.out, "eval_log.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"time": time.strftime("%Y-%m-%d %H:%M:%S"), "name": a.name, "split": a.split,
                             "model_sha256": res["model_sha256"], "acc_all": res["all"]["accuracy"],
                             "acc_clean": res["clean"]["accuracy"]}, ensure_ascii=False) + "\n")
    for k in ("all", "clean"):
        m = res[k]
        print(f"[{a.name} / {a.split} / {k}] n={m['n']} acc={m['accuracy']} {m['accuracy_ci95']} macroF1={m['macro_f1']} {m['macro_f1_ci95']} nll={m['nll']} ece={m['ece']}")
        for r in m["per_class"]:
            print("   ", r)


if __name__ == "__main__":
    main()
