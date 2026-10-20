"""Evaluate, for each smoothing strength (sigma), the smoothness and tracking of the output virtual camera trajectory using the gyro alone.

If rolling shutter correction and stabilization work correctly, the motion the viewer sees = the smoothed trajectory qs.
  Residual shake : RMS [deg/s] of the 1 to 10 Hz component of the angular velocity of qs (per vehicle pitch/yaw/roll)
  Tracking error : 95th percentile [deg] of the difference between the actual camera attitude and qs (the larger it is, the more the view lags/leads in corners)
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
    # Angular velocity of the output trajectory (vehicle axis components)
    w = (qs[:-1].inv() * qs[1:]).as_rotvec() @ R_mount * 50
    band = sosfiltfilt(sos, np.degrees(w), axis=0)
    shake = np.sqrt((band ** 2).mean(0))
    dev = np.degrees(np.abs((q_f.inv() * qs).as_rotvec() @ R_mount))
    d95 = np.percentile(dev, 95, axis=0)
    print(f"{label:22s} residual shake[deg/s] pitch {shake[0]:5.2f} yaw {shake[1]:5.2f} roll {shake[2]:5.2f}"
          f" | tracking error 95%[deg] pitch {d95[0]:5.2f} yaw {d95[1]:5.2f} roll {d95[2]:5.2f}", flush=True)


w_raw = (q_f[:-1].inv() * q_f[1:]).as_rotvec() @ R_mount * 50
band = sosfiltfilt(sos, np.degrees(w_raw), axis=0)
r = np.sqrt((band ** 2).mean(0))
print(f"{'No correction':22s} residual shake[deg/s] pitch {r[0]:5.2f} yaw {r[1]:5.2f} roll {r[2]:5.2f}")
for s in (0.1, 0.15, 0.25, 0.4, 0.6, 1.0):
    evaluate(s, f"sigma {s}s")
for sig in ((0.5, 0.25, 0.15), (0.6, 0.3, 0.2), (0.8, 0.4, 0.25)):
    evaluate(sig, f"P{sig[0]}/Y{sig[1]}/R{sig[2]}")
