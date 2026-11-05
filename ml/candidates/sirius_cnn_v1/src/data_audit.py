"""데이터 감사 v3: split 간 '같은 원본에서 나온 증강 복제본' 탐지 (메모리·속도 개선, 단계별 저장).

    python data_audit.py "<MRI Dataset>" --stage val_vs_train  --out reports/audit_val_vs_train.npz
    python data_audit.py "<MRI Dataset>" --stage test_vs_train --out reports/audit_test_vs_train.npz
    python data_audit.py "<MRI Dataset>" --stage test_vs_val   --out reports/audit_test_vs_val.npz

1) 후보: 32x32 정규화 / 16x16 블러 축소본의 최근접(상하좌우 뒤집기·90도 회전 8방향 포함) 상위 후보
2) 검증: ORB 특징점 매칭 + RANSAC(유사변환). ORB 는 회전에 불변이라 '좌우 반전 여부'만 맞춰 비교
   → 이동·회전·확대·밝기 변경된 복제본이라도 같은 원본이면 inlier(일치 특징점 수)가 크게 나옴
3) 기준선: 무작위 서로 다른 쌍의 inlier 분포
정확 중복(파일/픽셀 SHA-256)도 함께 셉니다.
"""
import argparse, glob, hashlib, json, os, time
import cv2
import numpy as np
from sklearn.neighbors import NearestNeighbors

CLASSES = ["glioma_tumor", "meningioma_tumor", "pituitary_tumor", "no_tumor"]
SPLITS = ["train", "val", "test"]
NCAND = 16
cv2.setNumThreads(1)
orb = cv2.ORB_create(nfeatures=1000, scaleFactor=1.2, nlevels=8, fastThreshold=7)
bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))


def orient(a, o):
    r = np.rot90(a, o // 2)
    return np.ascontiguousarray(r[:, ::-1] if o % 2 else r)


def znorm(a, s):
    v = cv2.resize(a, (s, s), interpolation=cv2.INTER_AREA).astype(np.float32).ravel()
    return (v - v.mean()) / (v.std() + 1e-6)


def feats(g):
    kp, des = orb.detectAndCompute(clahe.apply(g), None)
    if des is None or len(kp) < 8:
        return None
    return np.float32([k.pt for k in kp]), des


def inliers(fa, fb):
    if fa is None or fb is None:
        return 0
    m = bf.match(fa[1], fb[1])
    if len(m) < 8:
        return 0
    src = fa[0][[x.queryIdx for x in m]]; dst = fb[0][[x.trainIdx for x in m]]
    M, mask = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0,
                                          maxIters=2000, confidence=0.99)
    return int(mask.sum()) if mask is not None else 0


def reps(g):
    return znorm(g, 32), znorm(cv2.GaussianBlur(g, (0, 0), 6), 16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root"); ap.add_argument("--stage", required=True, choices=["val_vs_train", "test_vs_train", "test_vs_val"])
    ap.add_argument("--out", required=True)
    a = ap.parse_args(); t0 = time.time()
    qsplit, bsplit = a.stage.split("_vs_")
    rows = []
    for sp in SPLITS:
        for c in CLASSES:
            for f in sorted(glob.glob(os.path.join(a.root, sp, c, "*.jpg"))):
                rows.append((sp, c, os.path.relpath(f, a.root).replace("\\", "/")))
    n = len(rows); split = np.array([r[0] for r in rows]); rel = np.array([r[2] for r in rows])
    qi = np.where(split == qsplit)[0]; bi = np.where(split == bsplit)[0]
    need = set(qi) | set(bi)
    sha_f, sha_p, qimg = [], [], {}
    R32 = np.zeros((n, 32 * 32), np.float32); R16 = np.zeros((n, 16 * 16), np.float32); F = [None] * n
    for i, (sp, c, r) in enumerate(rows):
        b = open(os.path.join(a.root, r), "rb").read()
        g = cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_GRAYSCALE)
        sha_f.append(hashlib.sha256(b).hexdigest()); sha_p.append(hashlib.sha256(g.tobytes()).hexdigest())
        if i in need:
            R32[i], R16[i] = reps(g); F[i] = feats(g)
            if i in set(qi):
                qimg[i] = g          # 질의 영상만 보관 (메모리 절약)
    print("prepared", n, f"{time.time()-t0:.0f}s", flush=True)
    base_rep = {32: R32, 16: R16}
    nns = {s: NearestNeighbors(n_neighbors=10, algorithm="brute").fit(base_rep[s][bi]) for s in (32, 16)}
    cand = [dict() for _ in qi]
    for s in (32, 16):
        for o in range(8):
            Q = np.stack([reps(orient(qimg[i], o))[0 if s == 32 else 1] for i in qi])
            d, ix = nns[s].kneighbors(Q)
            for k in range(len(qi)):
                for dd, jj in zip(d[k], ix[k]):
                    j = int(bi[jj])
                    if j not in cand[k] or dd < cand[k][j][0]:
                        cand[k][j] = (float(dd), o)
    print("candidates", f"{time.time()-t0:.0f}s", flush=True)
    qf = {}
    best = np.zeros(len(qi), int); best_j = np.full(len(qi), -1); pairs = []
    for k, i in enumerate(qi):
        for j, (dd, o) in sorted(cand[k].items(), key=lambda kv: kv[1][0])[:NCAND]:
            if j == i:
                continue
            par = o % 2
            if (i, par) not in qf:
                qf[(i, par)] = F[i] if par == 0 else feats(np.ascontiguousarray(qimg[i][:, ::-1]))
            v = inliers(qf[(i, par)], F[j])
            if v >= 10:
                pairs.append((int(i), int(j), v))
            if v > best[k]:
                best[k], best_j[k] = v, j
        if k % 200 == 0:
            print(" ", k, "/", len(qi), f"{time.time()-t0:.0f}s", flush=True)
    rng = np.random.default_rng(0); base = []
    pool = np.array(sorted(need))
    for _ in range(1500):
        x, y = rng.choice(pool, 2, replace=False); base.append(inliers(F[x], F[y]))
    base = np.array(base)
    np.savez_compressed(a.out, rel=rel, split=split, q_index=qi, best_inl=best, best_idx=best_j,
                        pairs=np.array(pairs, np.int32).reshape(-1, 3), baseline=base,
                        exact_file_dups=n - len(set(sha_f)), exact_pixel_dups=n - len(set(sha_p)))
    print(json.dumps({"stage": a.stage, "queries": len(qi), "best_inlier_pct[0,5,25,50,75,90,100]": [int(x) for x in np.percentile(best, [0, 5, 25, 50, 75, 90, 100])],
                      "baseline_p99_p999_max": [int(x) for x in np.percentile(base, [99, 99.9, 100])],
                      "exact_file_dups": n - len(set(sha_f)), "exact_pixel_dups": n - len(set(sha_p))}), flush=True)
    print("total", f"{time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
