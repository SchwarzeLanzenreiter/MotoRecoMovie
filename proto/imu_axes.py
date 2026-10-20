"""Match the frame-to-frame rotation estimated from the video against the gyro integral to find the IMU -> rig coordinates rotation.

Steps:
  1. From frame pairs every 0.1 s, build front and back perspective views
  2. Estimate the camera rotation with feature matching + the essential matrix (rotation is recovered even with translation)
  3. Compare with the rotation vector from integrating the gyro over the same interval and estimate the axis correspondence with Procrustes
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
EVERY = 5  # every 0.1 s

x = Insv(path)
fps = x.fps
f0 = int(round(t_start * fps))
n = int(dur * fps / EVERY)
imgs = [read_frames(path, lens, f0, n, SIZE, fps, EVERY) for lens in (0, 1)]
n = min(len(imgs[0]), len(imgs[1]))
print("Frame count", n)
lenses = make_rig(x, picture_w=SIZE)
ft = x.frame_times(0)
ts, acc, gyro = x.imu()

# Perspective views (rig coordinates): front, back, right, left
VW, VH, VF = 960, 720, 480.0  # focal length 480px ≈ horizontal FOV 90°
K = np.array([[VF, 0, VW / 2], [0, VF, VH / 2], [0, 0, 1]])
uu, vv = np.meshgrid(np.arange(VW) + 0.5, np.arange(VH) + 0.5)
cam_rays = np.stack([(uu - VW / 2) / VF, (vv - VH / 2) / VF, np.ones_like(uu)], -1)
views = {name: Rot.from_euler("y", deg, degrees=True).as_matrix() for name, deg in
         [("front", 0), ("right", 90), ("back", 180), ("left", -90)]}
view_maps = {}
for name, Rv in views.items():
    rays = cam_rays @ Rv.T
    pr = [L.project(rays) for L in lenses]
    use0 = pr[0][2] < pr[1][2]  # use the lens closer to the optical axis
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
    """Gyro integral from ta to tb (IMU coordinates). Returns the change of body attitude as a rotation vector."""
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
        # R from recoverPose is the rotation that "maps points from cam1 to cam2". The change of camera attitude is its transpose.
        Rrig = Rv @ R.T @ Rv.T
        meas.append(Rot.from_matrix(Rrig).as_rotvec())
    if len(meas) < 2:
        continue
    w_img = np.median(meas, axis=0)
    W_img.append(w_img)
    W_imu.append(w_imu)
    T_ab.append((ta, tb))
    print(f"{k:3d} image {np.degrees(w_img).round(2)}  gyro {np.degrees(w_imu).round(2)}")

A, B = np.array(W_imu), np.array(W_img)
# Procrustes: orthogonal matrix M such that B ≈ A @ M.T
U, S, Vt = np.linalg.svd(B.T @ A)
M = U @ Vt
print("det(M) =", np.linalg.det(M))
print("M (IMU -> rig) =\n", M.round(3))
res = B - A @ M.T
print("Residual RMS [deg]", np.degrees(np.sqrt((res ** 2).mean(0))).round(3),
      " Image-side rotation RMS [deg]", np.degrees(np.sqrt((B ** 2).mean(0))).round(3))
np.save("out/imu_to_rig.npy", M)

# ---- With M rounded to a signed permutation, search the time offset between gyro and video ----
M0 = np.round(M)
print("Rounded M =\n", M0)
np.save("out/imu_to_rig.npy", M0)
for dus in range(-60000, 60001, 5000):
    P = np.array([gyro_rotvec(ta + dus, tb + dus) for ta, tb in T_ab]) @ M0.T
    r = np.degrees(np.sqrt(((B - P) ** 2).mean()))
    print(f"offset {dus / 1000:+5.0f}ms  residual RMS {r:.3f}°")
