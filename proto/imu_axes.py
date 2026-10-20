"""映像から推定したフレーム間回転とジャイロ積分を突き合わせ、IMU→リグ座標の回転を求める。

手順:
  1. 0.1秒おきのフレームペアから、前方・後方の透視投影ビューを作る
  2. 特徴点マッチング＋基本行列でカメラ回転を推定する（並進があっても回転は求まる）
  3. 同じ区間のジャイロを積分した回転ベクトルと比べ、Procrustes 法で軸の対応を推定する
"""
import sys

import cv2
import numpy as np
from scipy.spatial.transform import Rotation as Rot

from frames import read_frames
from insv import Insv
from lens import make_rig

path = sys.argv[1]
t_start = float(sys.argv[2]) if len(sys.argv) > 2 else 1396.0
dur = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0
SIZE = 1280
EVERY = 5  # 0.1秒おき

x = Insv(path)
fps = x.fps
f0 = int(round(t_start * fps))
n = int(dur * fps / EVERY)
imgs = [read_frames(path, lens, f0, n, SIZE, fps, EVERY) for lens in (0, 1)]
n = min(len(imgs[0]), len(imgs[1]))
print("フレーム数", n)
lenses = make_rig(x, picture_w=SIZE)
ft = x.frame_times(0)
ts, acc, gyro = x.imu()

# 透視投影ビュー（リグ座標）: 前、後、右、左
VW, VH, VF = 960, 720, 480.0  # 焦点距離 480px ≒ 水平FOV 90°
K = np.array([[VF, 0, VW / 2], [0, VF, VH / 2], [0, 0, 1]])
uu, vv = np.meshgrid(np.arange(VW) + 0.5, np.arange(VH) + 0.5)
cam_rays = np.stack([(uu - VW / 2) / VF, (vv - VH / 2) / VF, np.ones_like(uu)], -1)
views = {name: Rot.from_euler("y", deg, degrees=True).as_matrix() for name, deg in
         [("front", 0), ("right", 90), ("back", 180), ("left", -90)]}
view_maps = {}
for name, Rv in views.items():
    rays = cam_rays @ Rv.T
    pr = [L.project(rays) for L in lenses]
    use0 = pr[0][2] < pr[1][2]  # 光軸に近いレンズを使う
    view_maps[name] = (pr, use0)


def render_view(k, name):
    pr, use0 = view_maps[name]
    out = np.zeros((VH, VW, 3), np.uint8)
    for i in (0, 1):
        s = cv2.remap(imgs[i][k], pr[i][0].astype(np.float32), pr[i][1].astype(np.float32), cv2.INTER_LINEAR)
        m = use0 if i == 0 else ~use0
        out[m] = s[m]
    return cv2.cvtColor(out, cv2.COLOR_BGR2GRAY)


sift = cv2.SIFT_create(3000)


def view_rotation(a, b):
    ka, da = sift.detectAndCompute(a, None)
    kb, db = sift.detectAndCompute(b, None)
    if da is None or db is None:
        return None
    m = cv2.BFMatcher().knnMatch(da, db, k=2)
    good = [p[0] for p in m if len(p) == 2 and p[0].distance < 0.7 * p[1].distance]
    if len(good) < 40:
        return None
    pa = np.float32([ka[g.queryIdx].pt for g in good])
    pb = np.float32([kb[g.trainIdx].pt for g in good])
    E, mask = cv2.findEssentialMat(pa, pb, K, cv2.RANSAC, 0.999, 1.0)
    if E is None or E.shape != (3, 3):
        return None
    inl, R, t, _ = cv2.recoverPose(E, pa, pb, K, mask=mask)
    if inl < 30:
        return None
    return R, inl


def gyro_rotvec(ta, tb):
    """ta→tb のジャイロ積分（IMU座標）。体の姿勢変化を回転ベクトルで返す。"""
    i0, i1 = np.searchsorted(ts, [ta, tb])
    q = Rot.identity()
    for i in range(i0, i1):
        dt = (ts[i + 1] - ts[i]) / 1e6
        q = q * Rot.from_rotvec(np.radians(gyro[i]) * dt)
    return q.as_rotvec()


W_img, W_imu, T_ab = [], [], []
for k in range(n - 1):
    ta, tb = ft[f0 + k * EVERY], ft[f0 + (k + 1) * EVERY]
    w_imu = gyro_rotvec(ta, tb)
    meas = []
    for name, Rv in views.items():
        r = view_rotation(render_view(k, name), render_view(k + 1, name))
        if r is None:
            continue
        R, inl = r
        # recoverPose の R は「点を cam1→cam2 に移す」回転。カメラ姿勢の変化はその転置。
        Rrig = Rv @ R.T @ Rv.T
        meas.append(Rot.from_matrix(Rrig).as_rotvec())
    if len(meas) < 2:
        continue
    w_img = np.median(meas, axis=0)
    W_img.append(w_img)
    W_imu.append(w_imu)
    T_ab.append((ta, tb))
    print(f"{k:3d} 画像 {np.degrees(w_img).round(2)}  ジャイロ {np.degrees(w_imu).round(2)}")

A, B = np.array(W_imu), np.array(W_img)
# Procrustes: B ≈ A @ M.T となる直交行列 M
U, S, Vt = np.linalg.svd(B.T @ A)
M = U @ Vt
print("det(M) =", np.linalg.det(M))
print("M (IMU→リグ) =\n", M.round(3))
res = B - A @ M.T
print("残差RMS [deg]", np.degrees(np.sqrt((res ** 2).mean(0))).round(3),
      " 画像側の回転RMS [deg]", np.degrees(np.sqrt((B ** 2).mean(0))).round(3))
np.save("out/imu_to_rig.npy", M)

# ---- 符号付き置換に丸めた M で、ジャイロと映像の時間オフセットを探索 ----
M0 = np.round(M)
print("丸めた M =\n", M0)
np.save("out/imu_to_rig.npy", M0)
for dus in range(-60000, 60001, 5000):
    P = np.array([gyro_rotvec(ta + dus, tb + dus) for ta, tb in T_ab]) @ M0.T
    r = np.degrees(np.sqrt(((B - P) ** 2).mean()))
    print(f"オフセット {dus / 1000:+5.0f}ms  残差RMS {r:.3f}°")
