"""Match the MotoRecoViewer CSV (converted with BMW.ddf) against the .dat to check the #BMW_* conversion formulas."""
import sys
import numpy as np
import pandas as pd
from motoreco_dat import read_dat

DAT = r'E:\R1200GSA\CAN Log\2026\20260919_143356.dat'
CSV = r'E:\R1200GSA\Movie\2026\0919宗谷丘陵\0919.csv'  # i18n-ignore

r = read_dat(DAT)
tt = r['t'].astype(np.float64) + r['t2'] / 1000.0
df = pd.read_csv(CSV, skiprows=1)
df.columns = [c.strip() for c in df.columns]
tc = df['time (ms)'].values / 1000.0


def sel(cid):
    m = r['id'] == cid
    return tt[m], r['d'][m].astype(np.float64)


def hold(ts, v, grid):
    """At each time of grid, the preceding value (sample and hold)"""
    i = np.searchsorted(ts, grid, side='right') - 1
    out = np.full(len(grid), np.nan)
    ok = i >= 0
    out[ok] = v[i[ok]]
    return out


# ---- 1. Start time of the CSV (time in the dat): find it with RPM ----
t10c, d10c = sel(0x10C)
lo = lambda b: b.astype(np.int64) & 0x0F
rpm = (lo(d10c[:, 3]) * 256 + d10c[:, 2]) * 4  # lower 4 bits of Data4 *256 + Data3, *4 (candidate)
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
print(f't=0 of the CSV is {OFF:.3f} s in the dat (mean RPM difference {best[1]:.2f})')

if __name__ == '__main__':
    np.save('motoreco_off.npy', np.array([OFF]))
