"""生の魚眼画像の特徴点の動きとジャイロを突き合わせ、
ジャイロ時刻オフセット・読み出し時間・読み出し方向を推定する（Gyroflowの同期と同じ考え方）。

特徴点 p1（フレームk）→ p2（フレームk+1）について、
  t1 = tf_k   + offset + frac(p1)·readout
  t2 = tf_k+1 + offset + frac(p2)·readout
  予測 p2' = project( R_rc · q(t2)⁻¹ · q(t1) · R_rcᵀ · unproject(p1) )
の誤差 |p2' - p2| を最小化する。並進による視差は外れ値として頑健統計で除く。
offset=0 は「露出レコードの ts = 読み出し開始」に相当する。

評価はエピポーラ誤差: フレームペアごとに並進方向 t を未知数として推定し、
ジャイロで回転させた光線 d1' と観測 d2 が t を含む平面に乗るかを角度で測る。
これで並進による視差の影響を受けずに、回転（=ジャイロと時刻）の正しさだけを測れる。
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

# ---- 特徴点の追跡 ----
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
        # 魚眼の外周（約88°より外）は除外
        r = np.hypot(p[:, 0] - cxp, p[:, 1] - cyp)
        keep = r < 820
        for (u1, v1), (u2, v2) in zip(p[keep], pb[keep]):
            obs.append((li, tf[k], tf[k + 1], u1, v1, u2, v2, k))
obs = np.array(obs)
print(f"特徴点ペア {len(obs)} 件（{time.time() - t:.0f}s）", flush=True)

li_arr = obs[:, 0].astype(int)
C1 = np.zeros((len(obs), 3))
for li in (0, 1):
    m = li_arr == li
    C1[m] = lenses[li].unproject_cam(obs[m, 3], obs[m, 4])
# リグ座標の光線
D1 = np.zeros_like(C1)
for li in (0, 1):
    m = li_arr == li
    D1[m] = C1[m] @ lenses[li].R_cam_from_rig  # R_rcᵀ · c


def frac(u, v, axis, sign):
    r = (v if axis == "row" else u) / SIZE
    return r if sign > 0 else 1 - r


K_arr = obs[:, 7].astype(int)
pair_idx = [np.where(K_arr == k)[0] for k in np.unique(K_arr)]
PX_PER_RAD = lenses[0].fx * lenses[0].scale / (1 + lenses[0].xi)  # 光軸付近の画素/ラジアン


def unit(a):
    return a / np.linalg.norm(a, axis=-1, keepdims=True)


D2_obs = np.zeros_like(D1)
for li in (0, 1):
    m = li_arr == li
    D2_obs[m] = lenses[li].unproject_cam(obs[m, 5], obs[m, 6]) @ lenses[li].R_cam_from_rig


def epipolar_err(D1r, D2):
    """フレームペアごとに並進方向を推定し、各点のエピポーラ誤差[rad]を返す。"""
    n = unit(np.cross(D1r, D2))  # 光線ペアが張る平面の法線。t はこれに直交する
    err = np.zeros(len(D2))
    for idx in pair_idx:
        if len(idx) < 20:
            err[idx] = np.nan
            continue
        use = idx
        for _ in range(3):  # 外れ値（動く物体など）を除いて再推定
            _, _, Vt = np.linalg.svd(n[use], full_matrices=False)
            t = Vt[-1]
            e = np.abs(n[idx] @ t) * np.linalg.norm(np.cross(D1r[idx], D2[idx]), axis=1)
            # 誤差角 ≈ |n·t|·sin(視差角)。視差角が小さい点は誤差が出にくいので正規化:
            # 平面 (t, d1') からの d2 の角距離
            m = unit(np.cross(t, D1r[idx]))
            e = np.abs((m * D2[idx]).sum(1))
            use = idx[e <= np.percentile(e, 80)]
        err[idx] = e
    return err


def cost(offset_us, readout_us, axis, sign, return_err=False):
    t1 = obs[:, 1] + offset_us + frac(obs[:, 3], obs[:, 4], axis, sign) * readout_us
    t2 = obs[:, 2] + offset_us + frac(obs[:, 5], obs[:, 6], axis, sign) * readout_us
    q1, q2 = sample(tsw, q, t1), sample(tsw, q, t2)
    rel = (q2.inv() * q1).as_matrix()  # リグ座標で t1 → t2 の光線の変換
    D1r = np.einsum("nij,nj->ni", rel, D1)
    err = epipolar_err(D1r, D2_obs) * PX_PER_RAD
    if return_err:
        return err
    e = np.sort(err[~np.isnan(err)])
    return e[: int(len(e) * 0.8)].mean()


# 参考: 回転ゼロと仮定した場合（ジャイロなし）のエピポーラ誤差
e0 = epipolar_err(D1, D2_obs) * PX_PER_RAD
e0 = np.sort(e0[~np.isnan(e0)])
print(f"ジャイロなし（回転ゼロ）の誤差: {e0[: int(len(e0) * 0.8)].mean():.3f}px", flush=True)

readout_meta = x.meta[25][0] * 1000
results = []
for axis in ("row", "col"):
    for sign in (1, -1):
        best = min(((cost(o, readout_meta, axis, sign), o) for o in np.arange(-20000, 20001, 2000)))
        results.append((best[0], axis, sign, best[1]))
        print(f"{axis} {'+' if sign > 0 else '-'} : 最良offset {best[1] / 1000:+.0f}ms  誤差 {best[0]:.3f}px", flush=True)
c0 = min((cost(o, 0, "row", 1), o) for o in np.arange(-20000, 20001, 2000))
print(f"RSなし: 最良offset {c0[1] / 1000:+.0f}ms  誤差 {c0[0]:.3f}px")

# 最良の方向で、オフセットと読み出し時間を細かく探索
_, axis, sign, o0 = min(results)
best = None
for ro in np.arange(0, 30001, 2500):
    for o in np.arange(o0 - 4000, o0 + 4001, 500):
        c = cost(o, ro, axis, sign)
        if best is None or c < best[0]:
            best = (c, o, ro)
print(f"\n最良: 方向 {axis} {'+' if sign > 0 else '-'}  offset {best[1] / 1000:+.1f}ms  readout {best[2] / 1000:.1f}ms  誤差 {best[0]:.3f}px")
for ro in np.arange(0, 30001, 2500):
    c = min(cost(o, ro, axis, sign) for o in np.arange(best[1] - 2000, best[1] + 2001, 500))
    print(f"  readout {ro / 1000:5.1f}ms → 誤差 {c:.3f}px")
