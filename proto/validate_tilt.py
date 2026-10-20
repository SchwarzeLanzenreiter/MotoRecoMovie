"""出力画面の水平線の傾きを、ログと融合したリーン角と比べる（レンダリングなし）。

各フレームで:
  リグ座標の真上 = 車体の上方向を、車体の前後軸まわりに -L 回したもの
  画面の傾き = 真上を画面に射影したときの、画面の上方向とのなす角
ホライズンロックなしの理想は「画面の傾き = リーン角 L」。
差 (傾き - L) のうち 1Hz 以下は平滑化による「なまり」、1Hz 以上は取り除いた振動。
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
base = Settings(out_w=64, out_h=36, hfov=110.0)  # レンダリングしないので出力は小さくてよい
sos = butter(2, 1.0, fs=50, output="sos")


def tilt_series(rf):
    fwd = rf.R_mount[:, 2]
    up_b = -rf.R_mount[:, 1]
    L = np.interp(rf.t_video, lean[0], lean[1])
    out = []
    for i in range(rf.nf):
        W = (rf.q_c[i].inv() * rf.view_world[i]).as_matrix()  # リグ座標での仮想カメラ（列=右,下,前）
        g = Rot.from_rotvec(np.radians(-L[i]) * fwd).apply(up_b)
        out.append(np.degrees(np.arctan2(g @ W[:, 0], -(g @ W[:, 1]))))
    return np.array(out), L


configs = [
    ("補正なし（リグ固定）", replace(base, sigma=0.0, rs_iters=0)),
    ("σ0.25", replace(base, sigma=0.25)),
    ("軸別 P0.6/Y0.3/R0.2", replace(base, sigma=(0.6, 0.3, 0.2))),
    ("σ0.25 + ロール補完", replace(base, sigma=0.25, lean=lean)),
    ("軸別 + ロール補完", replace(base, sigma=(0.6, 0.3, 0.2), lean=lean)),
    ("σ0.6 + ロール補完", replace(base, sigma=0.6, lean=lean)),
    ("σ1.0 + ロール補完", replace(base, sigma=1.0, lean=lean)),
]
res = {}
for label, st in configs:
    rf = Reframer(path, st, t0, dur)
    tilt, L = tilt_series(rf)
    s = np.sign(np.corrcoef(tilt, L)[0, 1])
    e = tilt - s * L
    lp = sosfiltfilt(sos, e)
    hp = e - lp
    lp -= np.median(lp)  # 取り付け補正の一定のずれは別に見る
    res[label] = (tilt, L, s)
    print(f"{label:22s} 傾きとリーンの相関 {np.corrcoef(tilt, L)[0, 1]:+.3f}  "
          f"なまり(1Hz以下) RMS {np.sqrt(np.mean(lp ** 2)):5.2f}° 最大 {np.abs(lp).max():5.2f}°  "
          f"| 振動(1Hz以上) RMS {np.sqrt(np.mean(hp ** 2)):5.2f}°  | 一定のずれ {np.median(e):+.2f}°", flush=True)
np.savez("out/tilt_series.npz", **{k: np.stack([v[0], v[1]]) for k, v in res.items()}, t=rf.t_video)

# ---- 水平固定（lean_ratio=0）で傾きが0になるか（符号の確認）----
for lr in (0.0, 0.5):
    rf = Reframer(path, replace(base, sigma=(0.6, 0.3, 0.2), lean=lean, lean_ratio=lr), t0, dur)
    tilt, L = tilt_series(rf)
    print(f"lean_ratio {lr}: 傾き = {np.polyfit(L, tilt, 1)[0]:+.3f}·L  （期待値 {-lr:+.1f}·L）  残差RMS {np.std(tilt + lr * L):.2f}°")
