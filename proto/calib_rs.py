"""Match the motion of feature points in the raw fisheye images against the gyro,
and estimate the gyro time offset, readout time and readout direction (same idea as Gyroflow sync).

For feature points p1 (frame k) -> p2 (frame k+1),
  t1 = tf_k   + offset + frac(p1)·readout
  t2 = tf_k+1 + offset + frac(p2)·readout
  prediction p2' = project( R_rc · q(t2)⁻¹ · q(t1) · R_rcᵀ · unproject(p1) )
minimize the error |p2' - p2|. Parallax from translation is removed as outliers with robust statistics.
offset=0 corresponds to "ts of the exposure record = start of readout".

Evaluation uses the epipolar error: for each frame pair, estimate the translation direction t as an unknown,
and measure by angle whether the gyro-rotated ray d1' and the observed d2 lie on a plane containing t.
This measures only the correctness of the rotation (= gyro and timing), unaffected by parallax from translation.
"""
import sys
import time

import cv2
import numpy as np

from frames import read_frames
from insv import Insv
from lens import make_rig
from stabilize import integrate, sample

PATH = sys.argv[1]
T0 = float(sys.argv[2]) if len(sys.argv) > 2 else 462.0
DUR = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
SIZE = 1920

x = Insv(PATH)
fps = x.fps
f0 = int(round(T0 * fps))
nf = int(round(DUR * fps))
lenses = make_rig(x, picture_w=SIZE)
ts, acc, gyro = x.imu()
lo, hi = np.searchsorted(ts, [x.frame_times(0)[f0] - 1e6, x.frame_times(0)[f0 + nf] + 1e6])
tsw = ts[lo:hi].astype(np.float64)
q = integrate(tsw, gyro[lo:hi])

# ---- Feature point tracking ----
obs = []  # (lens, tf1, tf2, u1, v1, u2, v2, k)
t = time.time()
for li in (0, 1):
    fr = read_frames(PATH, li, f0, nf, SIZE, fps, gray=True)
    tf = x.frame_times(li)[f0:f0 + len(fr)].astype(np.float64)
    L = lenses[li]
    cxp, cyp = L.cx * L.scale, L.cy * L.scale
    for k in range(len(fr) - 1):
        a, b = fr[k], fr[k + 1]
        p = cv2.goodFeaturesToTrack(a, 800, 0.01, 12)
        if p is None:
            continue
        pb, st1, _ = cv2.calcOpticalFlowPyrLK(a, b, p, None, winSize=(21, 21), maxLevel=4)
        pa2, st2, _ = cv2.calcOpticalFlowPyrLK(b, a, pb, None, winSize=(21, 21), maxLevel=4)
        good = (st1.ravel() == 1) & (st2.ravel() == 1) & (np.linalg.norm((pa2 - p).reshape(-1, 2), axis=1) < 0.5)
        p, pb = p.reshape(-1, 2)[good], pb.reshape(-1, 2)[good]
        # Exclude the fisheye periphery (beyond about 88°)
        r = np.hypot(p[:, 0] - cxp, p[:, 1] - cyp)
        keep = r < 820
        for (u1, v1), (u2, v2) in zip(p[keep], pb[keep]):
            obs.append((li, tf[k], tf[k + 1], u1, v1, u2, v2, k))
obs = np.array(obs)
print(f"Feature point pairs: {len(obs)} ({time.time() - t:.0f}s)", flush=True)

li_arr = obs[:, 0].astype(int)
C1 = np.zeros((len(obs), 3))
for li in (0, 1):
    m = li_arr == li
    C1[m] = lenses[li].unproject_cam(obs[m, 3], obs[m, 4])
# Rays in rig coordinates
D1 = np.zeros_like(C1)
for li in (0, 1):
    m = li_arr == li
    D1[m] = C1[m] @ lenses[li].R_cam_from_rig  # R_rcᵀ · c


def frac(u, v, axis, sign):
    r = (v if axis == "row" else u) / SIZE
    return r if sign > 0 else 1 - r


K_arr = obs[:, 7].astype(int)
pair_idx = [np.where(K_arr == k)[0] for k in np.unique(K_arr)]
PX_PER_RAD = lenses[0].fx * lenses[0].scale / (1 + lenses[0].xi)  # pixels per radian near the optical axis


def unit(a):
    return a / np.linalg.norm(a, axis=-1, keepdims=True)


D2_obs = np.zeros_like(D1)
for li in (0, 1):
    m = li_arr == li
    D2_obs[m] = lenses[li].unproject_cam(obs[m, 5], obs[m, 6]) @ lenses[li].R_cam_from_rig


def epipolar_err(D1r, D2):
    """Estimate the translation direction per frame pair and return the epipolar error [rad] of each point."""
    n = unit(np.cross(D1r, D2))  # Normal of the plane spanned by the ray pair. t is orthogonal to it
    err = np.zeros(len(D2))
    for idx in pair_idx:
        if len(idx) < 20:
            err[idx] = np.nan
            continue
        use = idx
        for _ in range(3):  # Re-estimate after removing outliers (moving objects etc.)
            _, _, Vt = np.linalg.svd(n[use], full_matrices=False)
            t = Vt[-1]
            e = np.abs(n[idx] @ t) * np.linalg.norm(np.cross(D1r[idx], D2[idx]), axis=1)
            # Error angle ≈ |n·t|·sin(parallax angle). Points with a small parallax angle show little error, so normalize:
            # Angular distance of d2 from the plane (t, d1')
            m = unit(np.cross(t, D1r[idx]))
            e = np.abs((m * D2[idx]).sum(1))
            use = idx[e <= np.percentile(e, 80)]
        err[idx] = e
    return err


def cost(offset_us, readout_us, axis, sign, return_err=False):
    t1 = obs[:, 1] + offset_us + frac(obs[:, 3], obs[:, 4], axis, sign) * readout_us
    t2 = obs[:, 2] + offset_us + frac(obs[:, 5], obs[:, 6], axis, sign) * readout_us
    q1, q2 = sample(tsw, q, t1), sample(tsw, q, t2)
    rel = (q2.inv() * q1).as_matrix()  # Ray transform from t1 to t2 in rig coordinates
    D1r = np.einsum("nij,nj->ni", rel, D1)
    err = epipolar_err(D1r, D2_obs) * PX_PER_RAD
    if return_err:
        return err
    e = np.sort(err[~np.isnan(err)])
    return e[: int(len(e) * 0.8)].mean()


# Reference: epipolar error assuming zero rotation (no gyro)
e0 = epipolar_err(D1, D2_obs) * PX_PER_RAD
e0 = np.sort(e0[~np.isnan(e0)])
print(f"Error without gyro (zero rotation): {e0[: int(len(e0) * 0.8)].mean():.3f}px", flush=True)

readout_meta = x.meta[25][0] * 1000
results = []
for axis in ("row", "col"):
    for sign in (1, -1):
        best = min(((cost(o, readout_meta, axis, sign), o) for o in np.arange(-20000, 20001, 2000)))
        results.append((best[0], axis, sign, best[1]))
        print(f"{axis} {'+' if sign > 0 else '-'} : best offset {best[1] / 1000:+.0f}ms  error {best[0]:.3f}px", flush=True)
c0 = min((cost(o, 0, "row", 1), o) for o in np.arange(-20000, 20001, 2000))
print(f"No RS: best offset {c0[1] / 1000:+.0f}ms  error {c0[0]:.3f}px")

# With the best direction, search the offset and readout time finely
_, axis, sign, o0 = min(results)
best = None
for ro in np.arange(0, 30001, 2500):
    for o in np.arange(o0 - 4000, o0 + 4001, 500):
        c = cost(o, ro, axis, sign)
        if best is None or c < best[0]:
            best = (c, o, ro)
print(f"\nBest: direction {axis} {'+' if sign > 0 else '-'}  offset {best[1] / 1000:+.1f}ms  readout {best[2] / 1000:.1f}ms  error {best[0]:.3f}px")
for ro in np.arange(0, 30001, 2500):
    c = min(cost(o, ro, axis, sign) for o in np.arange(best[1] - 2000, best[1] + 2001, 500))
    print(f"  readout {ro / 1000:5.1f}ms -> error {c:.3f}px")
