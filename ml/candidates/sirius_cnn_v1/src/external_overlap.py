"""외부 공개 데이터의 Testing 영상이 우리 아카이브(train/val/test 전체)와 같은 원본인지 검사.

    python external_overlap.py "<MRI Dataset>" "<외부 루트 이름=경로>" ... --out reports/external_overlap.npz

외부 루트 구조: <경로>/Testing/<클래스>/*.jpg  (클래스 폴더명: glioma|meningioma|pituitary|notumor 또는 *_tumor|no_tumor)
data_audit.py 와 같은 방식(후보 탐색 → ORB+RANSAC 검증)을 씁니다.
"""
import argparse, glob, os, time
import cv2
import numpy as np
from sklearn.neighbors import NearestNeighbors

from data_audit import CLASSES, SPLITS, feats, inliers, orient, znorm

ALIAS = {"glioma": "glioma_tumor", "meningioma": "meningioma_tumor", "pituitary": "pituitary_tumor",
         "notumor": "no_tumor", "no_tumor": "no_tumor", "glioma_tumor": "glioma_tumor",
         "meningioma_tumor": "meningioma_tumor", "pituitary_tumor": "pituitary_tumor"}
TOPK = 8


def rep_vecs(g):
    return znorm(g, 32), znorm(cv2.GaussianBlur(g, (0, 0), 6), 16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("archive"); ap.add_argument("ext", nargs="+"); ap.add_argument("--out", required=True)
    a = ap.parse_args(); t0 = time.time()
    arch = []
    for sp in SPLITS:
        for c in CLASSES:
            arch += sorted(glob.glob(os.path.join(a.archive, sp, c, "*.jpg")))
    A = [cv2.imread(f, cv2.IMREAD_GRAYSCALE) for f in arch]
    FA = [feats(g) for g in A]
    R = {32: np.stack([rep_vecs(g)[0] for g in A]), 16: np.stack([rep_vecs(g)[1] for g in A])}
    nns = {s: NearestNeighbors(n_neighbors=TOPK, algorithm="brute").fit(R[s]) for s in R}
    print("archive ready", len(arch), f"{time.time()-t0:.0f}s", flush=True)
    out = {}
    for spec in a.ext:
        name, root = spec.split("=", 1)
        files, labels = [], []
        for d in sorted(os.listdir(os.path.join(root, "Testing"))):
            for f in sorted(glob.glob(os.path.join(root, "Testing", d, "*.jpg"))):
                files.append(f); labels.append(CLASSES.index(ALIAS[d]))
        imgs = [cv2.imread(f, cv2.IMREAD_GRAYSCALE) for f in files]
        best = np.zeros(len(files), int); bj = np.full(len(files), -1)
        cand = [dict() for _ in files]
        for s in (32, 16):
            for o in range(8):
                Q = np.stack([rep_vecs(orient(g, o))[0 if s == 32 else 1] for g in imgs])
                d, ix = nns[s].kneighbors(Q)
                for i in range(len(files)):
                    for dd, j in zip(d[i], ix[i]):
                        if j not in cand[i] or dd < cand[i][j][0]:
                            cand[i][j] = (float(dd), o)
        for i, g in enumerate(imgs):
            for j, (dd, o) in sorted(cand[i].items(), key=lambda kv: kv[1][0])[:TOPK]:
                v = inliers(feats(orient(g, o)), FA[j])
                if v > best[i]:
                    best[i], bj[i] = v, j
        sp_of = np.array([os.path.relpath(arch[j], a.archive).split(os.sep)[0] if j >= 0 else "" for j in bj])
        out[f"{name}_files"] = np.array([os.path.relpath(f, root).replace("\\", "/") for f in files])
        out[f"{name}_labels"] = np.array(labels); out[f"{name}_best_inliers"] = best
        out[f"{name}_match_split"] = sp_of
        print(name, len(files), "images; best-inlier percentiles(0,50,90,99,100):",
              [int(x) for x in np.percentile(best, [0, 50, 90, 99, 100])], f"{time.time()-t0:.0f}s", flush=True)
    rng = np.random.default_rng(1); base = []
    for _ in range(2000):
        i, j = rng.integers(0, len(A), 2)
        if i != j:
            base.append(inliers(FA[i], FA[j]))
    out["baseline"] = np.array(base)
    np.savez_compressed(a.out, **out)
    print("baseline random pairs p99/p99.9/max:", [int(x) for x in np.percentile(base, [99, 99.9, 100])])


if __name__ == "__main__":
    main()
