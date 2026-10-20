"""MotoRecoViewer の CSV（BMW.ddf で変換したもの）と .dat を突き合わせ、#BMW_* の変換式を確かめる。"""
import sys
import numpy as np
import pandas as pd
from motoreco_dat import read_dat

DAT = r'E:\R1200GSA\CAN Log\2026\20260919_143356.dat'
CSV = r'E:\R1200GSA\Movie\2026\0919宗谷丘陵\0919.csv'

r = read_dat(DAT)
tt = r['t'].astype(np.float64) + r['t2'] / 1000.0
df = pd.read_csv(CSV, skiprows=1)
df.columns = [c.strip() for c in df.columns]
tc = df['time (ms)'].values / 1000.0


def sel(cid):
    m = r['id'] == cid
    return tt[m], r['d'][m].astype(np.float64)


def hold(ts, v, grid):
    """grid の各時刻で、直前の値（サンプル＆ホールド）"""
    i = np.searchsorted(ts, grid, side='right') - 1
    out = np.full(len(grid), np.nan)
    ok = i >= 0
    out[ok] = v[i[ok]]
    return out


# ---- 1. CSV の開始時刻（dat の時刻）: RPM で探す ----
t10c, d10c = sel(0x10C)
lo = lambda b: b.astype(np.int64) & 0x0F
rpm = (lo(d10c[:, 3]) * 256 + d10c[:, 2]) * 4  # Data4 の下位 4 ビット *256 + Data3、*4（候補）
csv_rpm = df['RPM'].values
best = None
for off in np.arange(-5, 60, 0.5):
    g = hold(t10c, rpm, tc[::50] + off)
    e = np.nanmean(np.abs(g - csv_rpm[::50]))
    if best is None or e < best[1]:
        best = (off, e)
off0 = best[0]
for off in np.arange(off0 - 1, off0 + 1, 0.005):
    g = hold(t10c, rpm, tc[::10] + off)
    e = np.nanmean(np.abs(g - csv_rpm[::10]))
    if e < best[1]:
        best = (off, e)
OFF = best[0]
print(f'CSV の t=0 は dat の {OFF:.3f} 秒（RPM の平均差 {best[1]:.2f}）')

if __name__ == '__main__':
    np.save('motoreco_off.npy', np.array([OFF]))
