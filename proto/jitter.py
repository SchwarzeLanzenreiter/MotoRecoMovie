"""Measure the frame-to-frame motion in the upper part (distant view) of the comparison video (left = no correction, right = corrected) to quantify shake.

For each frame pair, estimate rotation + translation (similarity transform) and
  - high-frequency component (residual from a 0.5 s moving average) = vibration
  - low-frequency component = intentional motion (change of lean in cornering etc.)
compare them separately.
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
    cum = np.cumsum(v, axis=0)  # cumulative screen position and rotation
    kern = np.ones(win) / win
    low = np.stack([np.convolve(cum[:, j], kern, mode="same") for j in range(3)], 1)
    hf = (cum - low)[win:-win]
    print(f"{k:5s}: vibration (high freq) RMS  x {hf[:, 0].std():6.2f}px  y {hf[:, 1].std():6.2f}px  rotation {hf[:, 2].std():5.3f}°"
          f"  | total rotation {cum[-1, 2]:+6.2f}°")
