"""#BMW_* の変換式の候補を、CSV（MotoRecoViewer の出力）と 1 行ずつ突き合わせて確かめる。
一致率（誤差がほぼ 0 の行の割合）が 100% 近ければ、その式で正しい。"""
import sys
import numpy as np
import pandas as pd
from motoreco_dat import read_dat

DAT = sys.argv[1] if len(sys.argv) > 1 else r'E:\R1200GSA\CAN Log\2026\20260919_143356.dat'
CSV = sys.argv[2] if len(sys.argv) > 2 else r'E:\R1200GSA\Movie\2026\0919宗谷丘陵\0919.csv'
r = read_dat(DAT)
tt = r['t'].astype(np.float64) + r['t2'] / 1000.0
df = pd.read_csv(CSV, skiprows=1)
df.columns = [c.strip() for c in df.columns]
tc = df['time (ms)'].values / 1000.0
T0 = 0.0


def rows(cid):
    m = r['id'] == cid
    return tt[m], r['d'][m].astype(np.int64)


def check(name, cid, f, tol=None, show=0):
    ts, d = rows(cid)
    v = f(d).astype(np.float64)
    y = df[name].values.astype(np.float64)
    best = None
    for off in np.arange(-0.02, 0.021, 0.001):
        i = np.searchsorted(ts, tc + T0 + off, side='right') - 1
        ok = i >= 0
        e = np.abs(v[i[ok]] - y[ok])
        t_ = tol if tol is not None else 1e-6 * max(1.0, np.nanmax(np.abs(y)))
        rate = np.mean(e <= t_)
        if best is None or rate > best[0]:
            best = (rate, off, np.sqrt(np.mean(e ** 2)), i, ok)
    rate, off, rmse, i, ok = best
    print(f'{name:24s} 一致 {rate*100:6.2f}%  RMSE {rmse:.4g}  ずれ {off*1000:+.0f}ms')
    if show:
        bad = np.flatnonzero(ok)[np.abs(v[i[ok]] - y[ok]) > 1e-6 * max(1.0, np.nanmax(np.abs(y)))][:show]
        for k in bad:
            print(f'    行 {k}: csv {y[k]:.6g} 予想 {v[i[k]]:.6g}  d=' + ' '.join(f'{b:02X}' for b in d[i[k]]))
    return rate


D = lambda d, n: d[:, n - 1]
LE = lambda d, a: d[:, a - 1] + d[:, a] * 256
LO = lambda d, n: d[:, n - 1] & 15
HI = lambda d, n: d[:, n - 1] >> 4

if __name__ == '__main__':
    check('RPM', 0x10C, lambda d: (D(d, 3) + LO(d, 4) * 256) * 5)
    check('ThrottelPosition', 0x10C, lambda d: D(d, 8) / 255 * 100)
    check('ThrottelValvePosition', 0x10C, lambda d: D(d, 6) / 255 * 100, show=3)
    check('Throttel Grip Position', 0x110, lambda d: D(d, 6) / 255 * 100)
    check('YawRate', 0x174, lambda d: LE(d, 1) * 125 / 32768 - 125, show=3)
    check('RollRate', 0x178, lambda d: LE(d, 1) * 125 / 32768 - 125, show=3)
    check('Y_Axis_G', 0x174, lambda d: (LE(d, 5) - 32768) / 7680, show=3)
    check('X_Axis_G', 0x178, lambda d: (LE(d, 5) - 32768) / 7680, show=3)
    check('Z_Axis_G', 0x17C, lambda d: (LE(d, 5) - 32768) / 7680, show=3)
    check('Speed', 0x7FE, lambda d: (D(d, 5) + D(d, 6) * 256 + D(d, 7) * 65536 + D(d, 8) * 16777216) / 1e6 * 3.6, show=3)
    check('alt (m)', 0x7FE, lambda d: (D(d, 1) + D(d, 2) * 256 + D(d, 3) * 65536 + D(d, 4) * 16777216) / 1e4 - 1000, show=3)
