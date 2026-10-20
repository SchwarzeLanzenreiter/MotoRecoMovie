"""For each of the left and right sides of the comparison video, estimate the virtual camera rotation between frames from the essential matrix
and compare the magnitude of the high-frequency component (vibration). A metric unaffected by translation (parallax)."""
import sys

import cv2
import numpy as np
from scipy.spatial.transform import Rotation as Rot

path = sys.argv[1]
hfov = float(sys.argv[2]) if len(sys.argv) > 2 else 110.0
cap = cv2.VideoCapture(path)
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) // 2
H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
f = (W / 2) / np.tan(np.radians(hfov) / 2)
K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]])
prev = None
rv = {"raw": [], "stab": []}
while True:
    ok, fr = cap.read()
    if not ok:
        break
    g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
    halves = {"raw": g[:, :W], "stab": g[:, W:]}
    if prev is not None:
        for k in halves:
            a, b = prev[k], halves[k]
            pa = cv2.goodFeaturesToTrack(a, 800, 0.01, 6)
            pb, st, _ = cv2.calcOpticalFlowPyrLK(a, b, pa, None)
            m = st.ravel() == 1
            E, mask = cv2.findEssentialMat(pa[m], pb[m], K, cv2.RANSAC, 0.999, 0.5)
            if E is None or E.shape != (3, 3):
                rv[k].append(rv[k][-1] if rv[k] else np.zeros(3))
                continue
            _, R, t, _ = cv2.recoverPose(E, pa[m], pb[m], K, mask=mask)
            rv[k].append(Rot.from_matrix(R.T).as_rotvec())
    prev = halves
fps = 50
win = int(0.3 * fps)
kern = np.ones(win) / win
names = ["pitch(x)", "yaw(y)", "roll(z)"]
for k, v in rv.items():
    w = np.degrees(np.array(v)) * fps  # angular velocity deg/s
    low = np.stack([np.convolve(w[:, j], kern, mode="same") for j in range(3)], 1)
    hf = (w - low)[win:-win]
    print(f"{k:5s} angular velocity high-freq RMS[deg/s]: " + "  ".join(f"{n} {hf[:, j].std():6.2f}" for j, n in enumerate(names)))
