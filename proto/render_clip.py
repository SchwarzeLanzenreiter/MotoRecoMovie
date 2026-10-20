"""短いクリップを透視投影でリフレームして書き出す。補正なし｜補正ありの比較動画も作る。

使い方:
  python render_clip.py <insv> <開始秒> <秒数> <ヨー(度, 0=車体の前)> [ピッチ] [水平FOV] [sigma秒] [タグ]
"""
import subprocess
import sys
import time

import cv2
import numpy as np
from scipy.spatial.transform import Rotation as Rot

from frames import LENS_TO_STREAM
from insv import Insv
from lens import make_rig
from mount import estimate_mount
from stabilize import integrate, smooth

path = sys.argv[1]
t_start, dur = float(sys.argv[2]), float(sys.argv[3])
yaw = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
pitch = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
hfov = float(sys.argv[6]) if len(sys.argv) > 6 else 110.0
sigma = float(sys.argv[7]) if len(sys.argv) > 7 else 0.25
tag = sys.argv[8] if len(sys.argv) > 8 else f"t{int(t_start)}_y{int(yaw)}"

IN = 3840
OW, OH = 1920, 1080
x = Insv(path)
fps = x.fps
f0 = int(round(t_start * fps))
nf = int(round(dur * fps))
ft = x.frame_times(0)[f0:f0 + nf]
lenses = make_rig(x, picture_w=IN)

# ---- 姿勢 ----
ts, acc, gyro = x.imu()
lo, hi = np.searchsorted(ts, [ft[0] - 3_000_000, ft[-1] + 3_000_000])
ts_w, gy_w = ts[lo:hi], gyro[lo:hi]
q = integrate(ts_w, gy_w)
from stabilize import sample
q_f = sample(ts_w, q, ft)
qs_f = smooth(ts_w, q, ft, sigma)
# 取り付け補正: 視点は車体座標（右・下・前）で指定し、リグ座標へは R_mount で変換する
# ヨー0°=車体の前方。全走行のIMUから推定する
R_mount, _ = estimate_mount(acc, gyro)
R_user = Rot.from_matrix(R_mount) * Rot.from_euler("YX", [yaw, pitch], degrees=True)

# 補正なし: 仮想カメラはリグに固定（R_rig = R_user）
# 補正あり: R_rig = q⁻¹ · qs · R_user
R_raw = [R_user.as_matrix()] * nf
R_stab = [(q_f[i].inv() * qs_f[i] * R_user).as_matrix() for i in range(nf)]
corr = np.degrees(np.linalg.norm((q_f.inv() * qs_f).as_rotvec(), axis=1))
print(f"補正量: 平均 {corr.mean():.2f}° 最大 {corr.max():.2f}°")

# ---- 透視投影の光線 ----
fpx = (OW / 2) / np.tan(np.radians(hfov) / 2)
uu, vv = np.meshgrid(np.arange(OW, dtype=np.float32) + 0.5, np.arange(OH, dtype=np.float32) + 0.5)
cam_rays = np.stack([(uu - OW / 2) / fpx, (vv - OH / 2) / fpx, np.ones_like(uu)], -1).astype(np.float32)


def render(imgs, Rrig, blend_deg=6.0):
    rays = cam_rays @ Rrig.T.astype(np.float32)
    pr = [L.project(rays) for L in lenses]
    diff = np.degrees(pr[1][2] - pr[0][2])
    w0 = np.clip(0.5 + diff / blend_deg, 0, 1).astype(np.float32)[..., None]
    out = np.zeros((OH, OW, 3), np.float32)
    for i in (0, 1):
        w = w0 if i == 0 else 1 - w0
        if (w > 0).any():
            s = cv2.remap(imgs[i], pr[i][0].astype(np.float32), pr[i][1].astype(np.float32), cv2.INTER_LINEAR)
            out += s.astype(np.float32) * w
    return np.clip(out, 0, 255).astype(np.uint8)


def reader(lens):
    cmd = ["ffmpeg", "-v", "error", "-hwaccel", "cuda", "-ss", f"{f0 / fps:.6f}", "-i", path,
           "-map", f"0:{LENS_TO_STREAM[lens]}", "-frames:v", str(nf), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=IN * IN * 3)


def writer(fn, w, h):
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps),
           "-i", "-", "-ss", f"{f0 / fps:.6f}", "-t", f"{dur:.3f}", "-i", path, "-map", "0:v", "-map", "1:a",
           "-c:v", "hevc_nvenc", "-preset", "p5", "-cq", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fn]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


rd = [reader(0), reader(1)]
w_stab = writer(f"out/{tag}_stab.mp4", OW, OH)
w_cmp = writer(f"out/{tag}_compare.mp4", OW, OH // 2)
t0 = time.time()
for i in range(nf):
    imgs = []
    for r in rd:
        buf = r.stdout.read(IN * IN * 3)
        if len(buf) < IN * IN * 3:
            break
        imgs.append(np.frombuffer(buf, np.uint8).reshape(IN, IN, 3))
    if len(imgs) < 2:
        print("フレームが足りません", i)
        break
    stab = render(imgs, R_stab[i])
    raw = render(imgs, R_raw[i])
    w_stab.stdin.write(stab.tobytes())
    half = lambda im: cv2.resize(im, (OW // 2, OH // 2), interpolation=cv2.INTER_AREA)
    cmp_ = np.hstack([half(raw), half(stab)])
    cv2.putText(cmp_, "raw", (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
    cv2.putText(cmp_, f"stabilized (sigma {sigma}s)", (OW // 2 + 12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
    w_cmp.stdin.write(cmp_.tobytes())
    if i == nf // 2:
        cv2.imwrite(f"out/{tag}_mid_compare.jpg", cmp_)
    if i % 50 == 0:
        print(f"{i}/{nf}  {(time.time() - t0) / (i + 1):.2f}s/frame", flush=True)
for w in (w_stab, w_cmp):
    w.stdin.close()
    w.wait()
for r in rd:
    r.kill()
print("完了", time.time() - t0, "s")
