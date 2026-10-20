"""区間ごとのラグを推定して、カメラとバイクログの時計のずれ（ドリフト）を確認する。"""
import sys
import numpy as np, pandas as pd
from insv import Insv
x = Insv(sys.argv[1]); ts, acc, gyro = x.imu()
n = len(ts)//10*10
g100 = gyro[:n].reshape(-1,10,3).mean(1); t100 = (ts[:n].reshape(-1,10).mean(1)-x.first_frame_us)/1e6
df = pd.read_csv(sys.argv[2], skiprows=1); df.columns=[c.strip() for c in df.columns]
tc = df["time (ms)"].to_numpy()/1000; grid = np.arange(0, tc[-1], 0.01)
yaw = np.interp(grid, tc, df["YawRate"].to_numpy().astype(float))
roll = np.interp(grid, tc, df["RollRate"].to_numpy().astype(float))
up = np.array([-0.972, 0.193, -0.141])  # 重力方向 ≒ ヨー軸
gy = g100 @ up
for w0 in range(0, int(grid[-1])-120, 120):
    seg = slice(w0*100, (w0+120)*100)
    ref = yaw[seg]
    if (ref < -120).any() or ref.std() < 1: continue
    best=(0.0,0.0)
    for L in np.arange(5.0, 8.0, 0.01):
        v = np.interp(grid[seg]+L, t100, gy)
        c = np.corrcoef(ref, v)[0,1]
        if abs(c) > abs(best[0]): best=(c,L)
    print(f"{w0:5d}s: lag {best[1]:.2f}s  corr {best[0]:+.3f}")
