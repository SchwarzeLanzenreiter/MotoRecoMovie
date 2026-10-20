"""カメラIMUとバイクの車両ログ(CSV)の相互相関から、IMUの軸対応と時間オフセットを調べる。"""
import sys

import numpy as np
import pandas as pd

from insv import Insv

insv_path, csv_path = sys.argv[1], sys.argv[2]
x = Insv(insv_path)
ts, acc, gyro = x.imu()
t0 = x.first_frame_us
# IMUを100Hzへ（10サンプル平均）
n = len(ts) // 10 * 10
g100 = gyro[:n].reshape(-1, 10, 3).mean(1)
a100 = acc[:n].reshape(-1, 10, 3).mean(1)
t100 = (ts[:n].reshape(-1, 10).mean(1) - t0) / 1e6  # 動画先頭からの秒

df = pd.read_csv(csv_path, skiprows=1)
df.columns = [c.strip() for c in df.columns]
tc = df["time (ms)"].to_numpy() / 1000.0
print("CSV列:", list(df.columns))
for c in ["RollRate", "YawRate", "LeanAngle", "Speed"]:
    v = df[c].to_numpy()
    print(f"{c}: min {v.min():.2f} max {v.max():.2f} mean {v.mean():.2f}")

# CSVを等間隔100Hzに補間
grid = np.arange(0, tc[-1], 0.01)


def on_grid(name):
    return np.interp(grid, tc, df[name].to_numpy().astype(float))


def xcorr(a, b, max_lag):
    """a(t) と b(t+lag) の正規化相関を lag ごとに返す（サンプル単位）。"""
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


# IMUをCSVの時間グリッドに載せる（オフセット0と仮定し、lagで探索）
gi = np.stack([np.interp(grid, t100, g100[:, k]) for k in range(3)], 1)
for name in ["RollRate", "YawRate"]:
    ref = on_grid(name)
    for k in range(3):
        lags, c = xcorr(ref, gi[:, k], 6000)  # ±60秒
        j = np.argmax(np.abs(c))
        print(f"{name} vs gyro[{k}]: 最大相関 {c[j]:+.3f} @ lag {lags[j] / 100:+.2f}s")

# ---- 無効値(-125)を除外して、ラグを細かく再探索し、線形写像を最小二乗で求める ----
roll, yaw = on_grid("RollRate"), on_grid("YawRate")
valid = (roll > -120) & (yaw > -120)
best = None
for L in range(600, 700):  # 6.0〜7.0秒を0.01秒刻み
    gg = np.stack([np.interp(grid + L / 100, t100, g100[:, k]) for k in range(3)], 1)
    A = gg[valid]
    Y = np.stack([roll, yaw], 1)[valid]
    W, res, *_ = np.linalg.lstsq(A, Y, rcond=None)
    pred = A @ W
    r2 = 1 - ((Y - pred) ** 2).sum(0) / ((Y - Y.mean(0)) ** 2).sum(0)
    if best is None or r2.mean() > best[0]:
        best = (r2.mean(), L, W, r2)
r2m, L, W, r2 = best
print(f"最適ラグ {L / 100:.2f}s（バイクログ時刻 = 動画時刻 - ラグ）  R2 roll {r2[0]:.3f} yaw {r2[1]:.3f}")
print("gyro→[roll,yaw] 写像:\n", np.round(W, 3))
print("列ノルム", np.round(np.linalg.norm(W, axis=0), 3))
# 単位ベクトル化したときの軸方向（カメラ座標でのバイクのロール軸・ヨー軸）
for i, nm in enumerate(["ロール軸", "ヨー軸"]):
    v = W[:, i] / np.linalg.norm(W[:, i])
    print(nm, np.round(v, 3))
print("ロール軸とヨー軸のなす角", np.degrees(np.arccos(np.dot(W[:, 0], W[:, 1]) / np.linalg.norm(W[:, 0]) / np.linalg.norm(W[:, 1]))))
# 重力方向（低速・直立時のacc平均）
sp = on_grid("Speed"); lean = on_grid("LeanAngle")
ai = np.stack([np.interp(grid + L / 100, t100, a100[:, k]) for k in range(3)], 1)
m = (sp > 30) & (np.abs(lean) < 2)
gdir = ai[m].mean(0)
print("直立走行時の加速度平均(g)", np.round(gdir, 3), "ノルム", np.round(np.linalg.norm(gdir), 3))
# 傾きの大きい区間（動画時刻）
win = 1000  # 10秒
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
    print(f"動画 {tv:7.1f}s〜{tv + 10:7.1f}s  平均|lean| {lean_abs[j]:.1f}°  速度 {sp[j]:.0f}km/h  lean範囲 {lean[j:j + win].min():.0f}〜{lean[j:j + win].max():.0f}")
