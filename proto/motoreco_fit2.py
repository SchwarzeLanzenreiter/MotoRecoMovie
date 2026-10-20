"""Search, for each column of the CSV, for the linear expression a·x + b of a combination of bytes of the corresponding CAN ID
(1 byte, 4 bits, 12/16 bits, signed or unsigned) that represents it best (derive the #BMW_* conversion formulas from real data)."""
import numpy as np
import pandas as pd
from motoreco_dat import read_dat

DAT = r'E:\R1200GSA\CAN Log\2026\20260919_143356.dat'
CSV = r'E:\R1200GSA\Movie\2026\0919宗谷丘陵\0919.csv'  # i18n-ignore
DDF = r'E:\R1200GSA\CAN Log\BMW.ddf'

r = read_dat(DAT)
tt = r['t'].astype(np.float64) + r['t2'] / 1000.0
df = pd.read_csv(CSV, skiprows=1)
df.columns = [c.strip() for c in df.columns]
tc = df['time (ms)'].values / 1000.0
ddf = [l.strip().split(',') for l in open(DDF, encoding='utf-8-sig') if l.strip()]

def feats(d):
    d = d.astype(np.int64)
    f = {}
    for i in range(8):
        f[f'D{i+1}'] = d[:, i]
        f[f'Lo{i+1}'] = d[:, i] & 15
        f[f'Hi{i+1}'] = d[:, i] >> 4
        f[f'S{i+1}'] = np.where(d[:, i] > 127, d[:, i] - 256, d[:, i])
    for i in range(7):
        a, b = d[:, i], d[:, i + 1]
        f[f'LE{i+1}{i+2}'] = a + b * 256
        f[f'BE{i+1}{i+2}'] = a * 256 + b
        f[f'LE{i+1}{i+2}s'] = np.where(a + b * 256 > 32767, a + b * 256 - 65536, a + b * 256)
        f[f'L12_{i+1}{i+2}'] = a + (b & 15) * 256          # Data_i + Lo(Data_i+1)*256
        f[f'H12_{i+1}{i+2}'] = (a >> 4) + b * 16            # Hi(Data_i) + Data_i+1*16
        f[f'B12_{i+1}{i+2}'] = (a & 15) * 256 + b
    for i in range(6):
        a, b, c = d[:, i], d[:, i + 1], d[:, i + 2]
        f[f'LE24_{i+1}'] = a + b * 256 + c * 65536
    return f

rows = []
for name, cid, rule, *_ in ddf:
    if name not in df.columns:
        continue
    cid = int(cid, 16)
    m = r['id'] == cid
    if not m.any():
        print(f'{name:24s} ID {cid:03X}: not in the dat')
        continue
    ts = tt[m]
    idx = np.searchsorted(ts, tc, side='right') - 1
    ok = idx >= 0
    y = df[name].values.astype(np.float64)
    ok &= np.isfinite(y)
    sub = np.flatnonzero(ok)[::7]
    F = feats(r['d'][m])
    best = None
    for k, x in F.items():
        xx = x[idx[sub]].astype(np.float64)
        yy = y[sub]
        if np.std(xx) == 0:
            continue
        A = np.vstack([xx, np.ones_like(xx)]).T
        coef, *_ = np.linalg.lstsq(A, yy, rcond=None)
        res = yy - A @ coef
        err = np.sqrt(np.mean(res ** 2))
        if best is None or err < best[1]:
            best = (k, err, coef)
    sd = np.std(y[sub])
    if best:
        print(f'{name:24s} ID {cid:03X} {rule:30s} best {best[0]:10s} a={best[2][0]:.6g} b={best[2][1]:.6g}  error {best[1]:.4g} (spread {sd:.4g})')
