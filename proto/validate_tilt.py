"""Compare the tilt of the horizon on the output screen with the lean angle fused with the log (no rendering).

For each frame:
  True up in rig coordinates = the vehicle up direction rotated by -L around the vehicle front-back axis
  Screen tilt = the angle between true up projected onto the screen and the screen up direction
Without a horizon lock, the ideal is "screen tilt = lean angle L".
Of the difference (tilt - L), the part at or below 1 Hz is "blunting" due to smoothing, and the part at or above 1 Hz is the removed vibration.
"""
import sys
from dataclasses import replace

import numpy as np
from scipy.signal import butter, sosfiltfilt
from scipy.spatial.transform import Rotation as Rot

from renderer import Reframer, Settings

path = sys.argv[1]
t0, dur = float(sys.argv[2]), float(sys.argv[3])
f = np.load("out/lean_fused.npz")
lean = (f["t"], f["L"], float(f["k"]))
base = Settings(out_w=64, out_h=36, hfov=110.0)  # nothing is rendered, so the output can be small
sos = butter(2, 1.0, fs=50, output="sos")


def tilt_series(rf):
    fwd = rf.R_mount[:, 2]
    up_b = -rf.R_mount[:, 1]
    L = np.interp(rf.t_video, lean[0], lean[1])
    out = []
    for i in range(rf.nf):
        W = (rf.q_c[i].inv() * rf.view_world[i]).as_matrix()  # virtual camera in rig coordinates (columns = right, down, front)
        g = Rot.from_rotvec(np.radians(-L[i]) * fwd).apply(up_b)
        out.append(np.degrees(np.arctan2(g @ W[:, 0], -(g @ W[:, 1]))))
    return np.array(out), L


configs = [
    ("No correction (rig-fixed)", replace(base, sigma=0.0, rs_iters=0)),
    ("σ0.25", replace(base, sigma=0.25)),
    ("Per-axis P0.6/Y0.3/R0.2", replace(base, sigma=(0.6, 0.3, 0.2))),
    ("σ0.25 + roll inpainting", replace(base, sigma=0.25, lean=lean)),
    ("Per-axis + roll inpainting", replace(base, sigma=(0.6, 0.3, 0.2), lean=lean)),
    ("σ0.6 + roll inpainting", replace(base, sigma=0.6, lean=lean)),
    ("σ1.0 + roll inpainting", replace(base, sigma=1.0, lean=lean)),
]
res = {}
for label, st in configs:
    rf = Reframer(path, st, t0, dur)
    tilt, L = tilt_series(rf)
    s = np.sign(np.corrcoef(tilt, L)[0, 1])
    e = tilt - s * L
    lp = sosfiltfilt(sos, e)
    hp = e - lp
    lp -= np.median(lp)  # the constant offset of the mount correction is examined separately
    res[label] = (tilt, L, s)
    print(f"{label:22s} correlation of tilt and lean {np.corrcoef(tilt, L)[0, 1]:+.3f}  "
          f"blunting (<=1Hz) RMS {np.sqrt(np.mean(lp ** 2)):5.2f}° max {np.abs(lp).max():5.2f}°  "
          f"| vibration (>=1Hz) RMS {np.sqrt(np.mean(hp ** 2)):5.2f}°  | constant offset {np.median(e):+.2f}°", flush=True)
np.savez("out/tilt_series.npz", **{k: np.stack([v[0], v[1]]) for k, v in res.items()}, t=rf.t_video)

# ---- Does the tilt become 0 with the horizon locked (lean_ratio=0)? (sign check) ----
for lr in (0.0, 0.5):
    rf = Reframer(path, replace(base, sigma=(0.6, 0.3, 0.2), lean=lean, lean_ratio=lr), t0, dur)
    tilt, L = tilt_series(rf)
    print(f"lean_ratio {lr}: tilt = {np.polyfit(L, tilt, 1)[0]:+.3f}·L  (expected {-lr:+.1f}·L)  residual RMS {np.std(tilt + lr * L):.2f}°")
