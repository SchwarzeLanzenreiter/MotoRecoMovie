"""Compare the direction, readout time and gyro time offset of the rolling shutter correction.

Metrics:
  sampson : median Sampson error [px] when fitting the essential matrix to feature points between consecutive frames.
            The more distortion within a frame (rolling shutter) remains, the more the rigid-body assumption breaks and the larger it gets
  jitter  : high-frequency RMS [deg/s] of the camera angular velocity estimated from the video
"""
import sys
import time
from dataclasses import replace

import cv2
import numpy as np
from scipy.spatial.transform import Rotation as Rot

from renderer import Reframer, Settings

PATH = sys.argv[1]
T0 = float(sys.argv[2]) if len(sys.argv) > 2 else 462.0
DUR = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
BASE = Settings(out_w=960, out_h=540, in_size=1920, hfov=90.0, sigma=0.25)


def metrics(frames, hfov):
    h, w = frames[0].shape[:2]
    f = (w / 2) / np.tan(np.radians(hfov) / 2)
    K = np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1]])
    samp, rots = [], []
    for a, b in zip(frames[:-1], frames[1:]):
        ga, gb = (cv2.cvtColor(x, cv2.COLOR_BGR2GRAY) for x in (a, b))
        pa = cv2.goodFeaturesToTrack(ga, 1000, 0.01, 6)
        pb, st, _ = cv2.calcOpticalFlowPyrLK(ga, gb, pa, None)
        m = st.ravel() == 1
        pa, pb = pa[m].reshape(-1, 2), pb[m].reshape(-1, 2)
        E, mask = cv2.findEssentialMat(pa, pb, K, cv2.RANSAC, 0.999, 1.0)
        if E is None or E.shape != (3, 3):
            continue
        Ki = np.linalg.inv(K)
        F = Ki.T @ E @ Ki
        x1 = np.c_[pa, np.ones(len(pa))]
        x2 = np.c_[pb, np.ones(len(pb))]
        Fx1, Ftx2 = x1 @ F.T, x2 @ F
        num = (x2 * Fx1).sum(1) ** 2
        den = Fx1[:, 0] ** 2 + Fx1[:, 1] ** 2 + Ftx2[:, 0] ** 2 + Ftx2[:, 1] ** 2
        d = np.sqrt(num / den)
        samp.append(np.median(d[d < np.percentile(d, 90)]))  # remove outliers such as moving objects
        _, R, _, _ = cv2.recoverPose(E, pa, pb, K, mask=mask)
        rots.append(Rot.from_matrix(R.T).as_rotvec())
    w_ = np.degrees(np.array(rots)) * 50
    k = np.ones(15) / 15
    low = np.stack([np.convolve(w_[:, j], k, mode="same") for j in range(3)], 1)
    jit = np.sqrt(((w_ - low)[15:-15] ** 2).sum(1).mean())
    return float(np.mean(samp)), float(jit)


def run(st, label):
    t = time.time()
    rf = Reframer(PATH, st, T0, DUR)
    frames = [rf.render(i, imgs) for i, imgs in rf.frames()]
    s, j = metrics(frames, st.hfov)
    print(f"{label:28s} sampson {s:.3f}px  jitter {j:6.2f}deg/s  ({time.time() - t:.0f}s)", flush=True)
    return frames, s, j


if __name__ == "__main__":
    mode = sys.argv[4] if len(sys.argv) > 4 else "dir"
    if mode == "final":
        run(replace(BASE, sigma=0.0, rs_iters=0), "No correction")
        run(replace(BASE, rs_iters=0), "Stabilization only (no RS)")
        run(BASE, "Stabilization + RS (readout 15.36ms)")
    elif mode == "dir":
        run(replace(BASE, sigma=0.0, rs_iters=0), "No correction")
        run(replace(BASE, rs_iters=0), "Stabilization only (no RS)")
        for axis in ("row", "col"):
            for sign in (1, -1):
                run(replace(BASE, rs_axis=axis, rs_sign=sign), f"RS {axis} {'+' if sign > 0 else '-'}")
    elif mode == "readout":
        axis, sign = sys.argv[5], int(sys.argv[6])
        for ms in (0, 8, 12, 15.36, 19, 24):
            run(replace(BASE, rs_axis=axis, rs_sign=sign, readout_ms=ms, rs_iters=2 if ms else 0), f"readout {ms}ms")
    elif mode == "offset":
        axis, sign = sys.argv[5], int(sys.argv[6])
        for off in (-2000, -1000, 0, 1000, 2000):
            run(replace(BASE, rs_axis=axis, rs_sign=sign, gyro_offset_us=off), f"gyro offset {off / 1000:+.1f}ms")
