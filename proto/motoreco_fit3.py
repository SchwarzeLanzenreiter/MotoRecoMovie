"""Examine the remaining columns (angular velocity, acceleration, GPS speed and altitude, gear) with multiple regression per 4 bits.
Where the coefficients line up in exact factors of 16 is the bit arrangement that produces the value."""
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

def nib(cid, name):
    m = r['id'] == cid
    ts = tt[m]
    d = r['d'][m].astype(np.int64)
    idx = np.searchsorted(ts, tc, side='right') - 1
    y = df[name].values.astype(np.float64)
    ok = (idx >= 0) & np.isfinite(y)
    # Use only rows right after the value changed (rows where the CSV was updated with a new CAN value) to reduce the effect of timing offset
    sub = np.flatnonzero(ok)
    sub = sub[np.r_[True, idx[sub][1:] != idx[sub][:-1]]][::3]
    X = []
    labels = []
    for i in range(8):
        X.append(d[idx[sub], i] & 15); labels.append(f'Lo{i+1}')
        X.append(d[idx[sub], i] >> 4); labels.append(f'Hi{i+1}')
    X = np.vstack(X + [np.ones(len(sub))]).T.astype(np.float64)
    keep = [k for k in range(X.shape[1] - 1) if np.std(X[:, k]) > 0] + [X.shape[1] - 1]
    coef, *_ = np.linalg.lstsq(X[:, keep], y[sub], rcond=None)
    res = y[sub] - X[:, keep] @ coef
    print(f'--- {name} (ID {cid:03X})  residual {np.sqrt(np.mean(res**2)):.4g}  spread {np.std(y[sub]):.4g}')
    for k, c in zip(keep, coef):
        if abs(c) > 1e-9:
            print(f'    {labels[k] if k < len(labels) else "const":6s} {c: .6g}')

for cid, name in [(0x178, 'RollRate'), (0x174, 'YawRate'), (0x178, 'X_Axis_G'), (0x174, 'Y_Axis_G'), (0x17C, 'Z_Axis_G'), (0x7FE, 'Speed'), (0x7FE, 'alt (m)'), (0x10C, 'ThrottelValvePosition')]:
    nib(cid, name)
# Gear: CSV value for each 4-bit value
m = r['id'] == 0x2BC
ts = tt[m]; d = r['d'][m].astype(np.int64)
idx = np.searchsorted(ts, tc, side='right') - 1
g = df['Gear'].values
for byte in range(8):
    for part, f in [('Lo', lambda x: x & 15), ('Hi', lambda x: x >> 4)]:
        v = f(d[idx[idx >= 0], byte]); gg = g[idx >= 0]
        tab = {}
        for a, b in zip(v[::50], gg[::50]):
            tab.setdefault(int(a), set()).add(float(b))
        if all(len(s) == 1 for s in tab.values()) and len(tab) > 2:
            print(f'Gear = table({part}{byte+1}):', {k: list(s)[0] for k, s in sorted(tab.items())})
