"""data_audit.npz 로 학습 제외 목록(leak_manifest.json)을 만듭니다.

    python leak_manifest.py reports/data_audit.npz --threshold 25 --out reports/leak_manifest.json

규칙(같은 원본으로 판단 = ORB+RANSAC inlier >= threshold)
· train_exclude : val 또는 test 영상과 같은 원본인 train 영상  → 학습에서 뺌 (test/val 는 버리지 않음)
· val_keep      : test 와 같은 원본이 아닌 val 영상            → 모델 선택에 사용
· {val,test}_clean : 원래 train(및 test 는 val)에 같은 원본이 전혀 없는 영상 → 기존 모델(전체 train 으로 학습)을 공정하게 평가
· 한계 : 후보 탐색(상위 K) + 임계값에 의존하는 best-effort 이며 환자 단위 분리가 아님
"""
import argparse, json
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audit"); ap.add_argument("--threshold", type=int, required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args(); T = a.threshold
    z = np.load(a.audit, allow_pickle=False)
    rel, split = z["rel"], z["split"]
    def pairs(k):
        p = z[f"{k}_pairs"]; return p[p[:, 2] >= T]
    vt, tt, tv = pairs("val_vs_train"), pairs("test_vs_train"), pairs("test_vs_val")
    val_sib_train = set(vt[:, 0]); test_sib_train = set(tt[:, 0]); test_sib_val = set(tv[:, 0])
    train_excl = set(vt[:, 1]) | set(tt[:, 1])
    val_sib_test = set(tv[:, 1])
    ix = {s: np.where(split == s)[0] for s in ("train", "val", "test")}
    R = lambda idxs: [str(rel[i]) for i in sorted(idxs)]
    man = {
        "threshold_inliers": T,
        "train_all": R(ix["train"]), "train_exclude": R(train_excl),
        "val_all": R(ix["val"]), "val_keep": R(set(ix["val"]) - val_sib_test),
        "val_clean": R(set(ix["val"]) - val_sib_train - val_sib_test),
        "test_all": R(ix["test"]), "test_clean": R(set(ix["test"]) - test_sib_train - test_sib_val),
    }
    n = lambda k: len(man[k])
    man["stats"] = {
        "train_all": n("train_all"), "train_exclude": n("train_exclude"), "train_used": n("train_all") - n("train_exclude"),
        "val_all": n("val_all"), "val_with_train_sibling": len(val_sib_train), "val_with_test_sibling": len(val_sib_test), "val_keep": n("val_keep"),
        "test_all": n("test_all"), "test_with_train_sibling": len(test_sib_train), "test_with_val_sibling": len(test_sib_val),
        "test_clean": n("test_clean"),
        "test_leaked_fraction": round(1 - n("test_clean") / n("test_all"), 4),
        "val_leaked_fraction": round(len(val_sib_train) / n("val_all"), 4),
    }
    json.dump(man, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(man["stats"], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
