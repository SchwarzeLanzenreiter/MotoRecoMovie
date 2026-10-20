"""平滑化の強さ（sigma）ごとに、出力の仮想カメラ軌跡の滑らかさと追従性をジャイロだけで評価する。

ローリングシャッターとスタビが正しく効いていれば、視聴者に見える動き = 平滑化後の軌跡 qs。
  残る揺れ  : qs の角速度の 1〜10Hz 成分の RMS [deg/s]（車体のピッチ/ヨー/ロール別）
  追従のずれ: 実際のカメラ姿勢と qs の差の 95パーセンタイル [deg]（大きいほどコーナーで視点が遅れ/先行する）
"""
import sys

import numpy as np
from scipy.signal import butter, sosfiltfilt

from insv import Insv
from mount import estimate_mount
from stabilize import integrate, sample, smooth

path = sys.argv[1]
t0, dur = float(sys.argv[2]), float(sys.argv[3])
x = Insv(path)
ts, acc, gyro = x.imu()
R_mount, _ = estimate_mount(acc, gyro)
ft = x.frame_times(0).astype(np.float64)
f0, f1 = int(t0 * 50), int((t0 + dur) * 50)
tf = ft[f0:f1]
lo, hi = np.searchsorted(ts, [tf[0] - 5e6, tf[-1] + 5e6])
tsw = ts[lo:hi].astype(np.float64)
q = integrate(tsw, gyro[lo:hi])
q_f = sample(tsw, q, tf)
sos = butter(4, [1, 10], btype="band", fs=50, output="sos")


def evaluate(sig, label):
    qs = smooth(tsw, q, tf, sig, axes=R_mount)
    # 出力軌跡の角速度（車体の軸成分）
    w = (qs[:-1].inv() * qs[1:]).as_rotvec() @ R_mount * 50
    band = sosfiltfilt(sos, np.degrees(w), axis=0)
    shake = np.sqrt((band ** 2).mean(0))
    dev = np.degrees(np.abs((q_f.inv() * qs).as_rotvec() @ R_mount))
    d95 = np.percentile(dev, 95, axis=0)
    print(f"{label:22s} 残る揺れ[deg/s] ピッチ {shake[0]:5.2f} ヨー {shake[1]:5.2f} ロール {shake[2]:5.2f}"
          f" | 追従のずれ95%[deg] ピッチ {d95[0]:5.2f} ヨー {d95[1]:5.2f} ロール {d95[2]:5.2f}", flush=True)


w_raw = (q_f[:-1].inv() * q_f[1:]).as_rotvec() @ R_mount * 50
band = sosfiltfilt(sos, np.degrees(w_raw), axis=0)
r = np.sqrt((band ** 2).mean(0))
print(f"{'補正なし':22s} 残る揺れ[deg/s] ピッチ {r[0]:5.2f} ヨー {r[1]:5.2f} ロール {r[2]:5.2f}")
for s in (0.1, 0.15, 0.25, 0.4, 0.6, 1.0):
    evaluate(s, f"sigma {s}s")
for sig in ((0.5, 0.25, 0.15), (0.6, 0.3, 0.2), (0.8, 0.4, 0.25)):
    evaluate(sig, f"P{sig[0]}/Y{sig[1]}/R{sig[2]}")
