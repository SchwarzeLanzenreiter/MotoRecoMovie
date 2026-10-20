"""比較動画（左=補正なし, 右=補正あり）の画面上部（遠景）のフレーム間の動きを測り、揺れを数値化する。

各フレームペアで回転＋平行移動（相似変換）を推定し、
  - 高周波成分（0.5秒移動平均からの残差）= 振動
  - 低周波成分 = 意図的な動き（コーナリングでの傾きの変化など）
に分けて比べる。
"""
import sys

import cv2
import numpy as np

cap = cv2.VideoCapture(sys.argv[1])
prev = None
motion = {"raw": [], "stab": []}
while True:
    ok, fr = cap.read()
    if not ok:
        break
    g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
    h, w = g.shape
    halves = {"raw": g[: h // 2, : w // 2], "stab": g[: h // 2, w // 2:]}
    if prev is not None:
        for k in halves:
            a, b = prev[k], halves[k]
            pa = cv2.goodFeaturesToTrack(a, 400, 0.01, 8)
            if pa is None:
                motion[k].append((0, 0, 0))
                continue
            pb, st, _ = cv2.calcOpticalFlowPyrLK(a, b, pa, None)
            m = st.ravel() == 1
            A, _ = cv2.estimateAffinePartial2D(pa[m], pb[m], method=cv2.RANSAC)
            if A is None:
                motion[k].append((0, 0, 0))
                continue
            ang = np.degrees(np.arctan2(A[1, 0], A[0, 0]))
            motion[k].append((A[0, 2], A[1, 2], ang))
    prev = halves
fps = 50
win = int(0.5 * fps)
for k, v in motion.items():
    v = np.array(v)
    cum = np.cumsum(v, axis=0)  # 累積の画面位置・回転
    kern = np.ones(win) / win
    low = np.stack([np.convolve(cum[:, j], kern, mode="same") for j in range(3)], 1)
    hf = (cum - low)[win:-win]
    print(f"{k:5s}: 振動(高周波) RMS  x {hf[:, 0].std():6.2f}px  y {hf[:, 1].std():6.2f}px  回転 {hf[:, 2].std():5.3f}°"
          f"  | 総回転量 {cum[-1, 2]:+6.2f}°")
