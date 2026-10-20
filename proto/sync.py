"""Find the IMU axis correspondence and time offset from the cross-correlation between the camera IMU and the bike vehicle log (CSV)."""
import sys

import numpy as np
import pandas as pd

from insv import Insv

insv_path, csv_path = sys.argv[1], sys.argv[2]
x = Insv(insv_path)
ts, acc, gyro = x.imu()
t0 = x.first_frame_us
# IMU to 100 Hz (average of 10 samples)
n = len(ts) // 10 * 10
g100 = gyro[:n].reshape(-1, 10, 3).mean(1)
a100 = acc[:n].reshape(-1, 10, 3).mean(1)
t100 = (ts[:n].reshape(-1, 10).mean(1) - t0) / 1e6  # seconds from the start of the video

df = pd.read_csv(csv_path, skiprows=1)
df.columns = [c.strip() for c in df.columns]
tc = df["time (ms)"].to_numpy() / 1000.0
print("CSV columns:", list(df.columns))
for c in ["RollRate", "YawRate", "LeanAngle", "Speed"]:
    v = df[c].to_numpy()
    print(f"{c}: min {v.min():.2f} max {v.max():.2f} mean {v.mean():.2f}")

# Interpolate the CSV to uniform 100 Hz
grid = np.arange(0, tc[-1], 0.01)


def on_grid(name):
    return np.interp(grid, tc, df[name].to_numpy().astype(float))


def xcorr(a, b, max_lag):
    """Return the normalized correlation of a(t) and b(t+lag) for each lag (in samples)."""
    a = (a - a.mean()) / a.std()
    b = (b - b.mean()) / b.std()
    lags = np.arange(-max_lag, max_lag + 1)
    out = []
    for L in lags:
        if L >= 0:
            aa, bb = a[:len(a) - L], b[L:]
        else:
            aa, bb = a[-L:], b[:len(b) + L]
        m = min(len(aa), len(bb))
        out.append(np.dot(aa[:m], bb[:m]) / m)
    return lags, np.array(out)


# Put the IMU on the CSV time grid (assume offset 0 and search by lag)
gi = np.stack([np.interp(grid, t100, g100[:, k]) for k in range(3)], 1)
for name in ["RollRate", "YawRate"]:
    ref = on_grid(name)
    for k in range(3):
        lags, c = xcorr(ref, gi[:, k], 6000)  # ±60 s
        j = np.argmax(np.abs(c))
        print(f"{name} vs gyro[{k}]: max correlation {c[j]:+.3f} @ lag {lags[j] / 100:+.2f}s")

# ---- Exclude invalid values (-125), search the lag again finely, and find the linear map by least squares ----
roll, yaw = on_grid("RollRate"), on_grid("YawRate")
valid = (roll > -120) & (yaw > -120)
best = None
for L in range(600, 700):  # 6.0 to 7.0 s in 0.01 s steps
    gg = np.stack([np.interp(grid + L / 100, t100, g100[:, k]) for k in range(3)], 1)
    A = gg[valid]
    Y = np.stack([roll, yaw], 1)[valid]
    W, res, *_ = np.linalg.lstsq(A, Y, rcond=None)
    pred = A @ W
    r2 = 1 - ((Y - pred) ** 2).sum(0) / ((Y - Y.mean(0)) ** 2).sum(0)
    if best is None or r2.mean() > best[0]:
        best = (r2.mean(), L, W, r2)
r2m, L, W, r2 = best
print(f"Optimal lag {L / 100:.2f}s (bike log time = video time - lag)  R2 roll {r2[0]:.3f} yaw {r2[1]:.3f}")
print("gyro -> [roll,yaw] map:\n", np.round(W, 3))
print("column norm", np.round(np.linalg.norm(W, axis=0), 3))
# Axis directions as unit vectors (bike roll and yaw axes in camera coordinates)
for i, nm in enumerate(["roll axis", "yaw axis"]):
    v = W[:, i] / np.linalg.norm(W[:, i])
    print(nm, np.round(v, 3))
print("Angle between roll axis and yaw axis", np.degrees(np.arccos(np.dot(W[:, 0], W[:, 1]) / np.linalg.norm(W[:, 0]) / np.linalg.norm(W[:, 1]))))
# Gravity direction (mean of acc at low speed and upright)
sp = on_grid("Speed"); lean = on_grid("LeanAngle")
ai = np.stack([np.interp(grid + L / 100, t100, a100[:, k]) for k in range(3)], 1)
m = (sp > 30) & (np.abs(lean) < 2)
gdir = ai[m].mean(0)
print("Mean acceleration while riding upright (g)", np.round(gdir, 3), "norm", np.round(np.linalg.norm(gdir), 3))
# Intervals with large lean (video time)
win = 1000  # 10 s
lean_abs = np.convolve(np.abs(lean), np.ones(win) / win, mode="valid")
order = np.argsort(-lean_abs)
picked = []
for j in order:
    if all(abs(j - p) > 3000 for p in picked):
        picked.append(j)
    if len(picked) == 5:
        break
for j in picked:
    tv = grid[j] + L / 100
    print(f"video {tv:7.1f}s to {tv + 10:7.1f}s  mean |lean| {lean_abs[j]:.1f}°  speed {sp[j]:.0f}km/h  lean range {lean[j:j + win].min():.0f} to {lean[j:j + win].max():.0f}")
