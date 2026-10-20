"""MotoReco の車両ログ（CSV, "TO Custom v1"）の読み込みと、カメラ映像との時刻同期。

同期の方法:
  カメラのジャイロを車体のロール軸へ射影したロールレートと、ログの RollRate の相互相関を取る。
  1. 粗同期: 全区間をFFTで相互相関（記録開始が何分ずれていても見つかる）
  2. 精密化: 60秒窓ごとに 1ms 刻みでずれを求め、t_log = a·t_video + b を当てはめる
     （a はカメラとロガーの時計の速度差、b はずれ）
  求まるずれには車体IMUの処理遅れ・CAN伝送遅れも含まれる（=記録上の時刻として揃えたいもの）。
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.signal import butter, correlate, sosfiltfilt

INVALID = -124.9  # ロガーの無効値は -125


@dataclass
class BikeLog:
    t: np.ndarray            # 秒（ログ先頭から）
    lean: np.ndarray         # リーン角 [deg]（ログの符号のまま）
    lean_updated: np.ndarray  # その時刻に値が更新されたか（止まっている間は False）
    roll_rate: np.ndarray    # RollRate（ログ単位、無効は NaN）
    yaw_rate: np.ndarray
    speed: np.ndarray
    df: pd.DataFrame


def load(path):
    df = pd.read_csv(path, skiprows=1)
    df.columns = [c.strip() for c in df.columns]
    t = df["time (ms)"].to_numpy(np.float64) / 1000
    lean = df["LeanAngle"].to_numpy(np.float64)
    upd = np.r_[True, np.diff(lean) != 0]
    rr = df["RollRate"].to_numpy(np.float64).copy()
    yr = df["YawRate"].to_numpy(np.float64).copy()
    rr[rr <= INVALID] = np.nan
    yr[yr <= INVALID] = np.nan
    return BikeLog(t, lean, upd, rr, yr, df["Speed"].to_numpy(np.float64), df)


def camera_roll_rate(ts_us, gyro_dps, R_mount, M, t0_us, fs=100.0):
    """カメラのジャイロを車体ロール軸へ射影し、等間隔 fs[Hz] に（動画時刻, deg/s）で返す。"""
    w = gyro_dps @ M.T @ R_mount  # 車体の (ピッチ, ヨー, ロール) 成分
    n = int(1000 / fs)
    m = len(ts_us) // n * n
    t = (ts_us[:m].reshape(-1, n).mean(1) - t0_us) / 1e6
    r = w[:m, 2].reshape(-1, n).mean(1)
    return t, r


def _norm(x):
    x = np.nan_to_num(x - np.nanmean(x))
    return x / (x.std() + 1e-12)


def sync(log: BikeLog, cam_t, cam_roll, window_s=60.0, fs=100.0):
    """ログ時刻 = a·動画時刻 + b を推定する。戻り値: (a, b, 符号, 診断情報)。"""
    sos = butter(2, 3.0, fs=fs, output="sos")  # スティックの振動を落とす（3Hz以下）
    cr = sosfiltfilt(sos, cam_roll)
    grid = np.arange(0, log.t[-1], 1 / fs)
    rr = np.interp(grid, log.t, np.nan_to_num(log.roll_rate))
    valid = np.interp(grid, log.t, (~np.isnan(log.roll_rate)).astype(float)) > 0.99
    rr[~valid] = 0
    # ---- 1. 粗同期（FFT相互相関、全範囲）----
    a_, b_ = _norm(rr), _norm(cr)
    c = correlate(a_, b_, mode="full", method="fft") / min(len(a_), len(b_))
    lags = np.arange(-len(b_) + 1, len(a_))
    j = np.argmax(np.abs(c))
    sign = np.sign(c[j])
    # correlate: c[lag] = Σ log[n+lag]·cam[n] → ログ時刻 (n+lag)/fs と 動画時刻 cam_t[0]+n/fs が対応
    # → ログ時刻 = 動画時刻 + lag/fs - cam_t[0]
    coarse = lags[j] / fs - cam_t[0]
    c_sorted = np.sort(np.abs(c))
    diag = {"coarse_offset": coarse, "peak": float(abs(c[j]))}
    # 2番目のピーク（±2秒以外）との比 = 同期の信頼度
    far = np.abs(lags - lags[j]) > 2 * fs
    diag["peak_ratio"] = float(abs(c[j]) / np.abs(c[far]).max())

    # ---- 2. 窓ごとに精密化（1ms刻み）----
    pts = []
    for w0 in np.arange(cam_t[0], cam_t[-1] - window_s, window_s / 2):
        m = (cam_t >= w0) & (cam_t < w0 + window_s)
        if m.sum() < window_s * fs * 0.9:
            continue
        tc, rc = cam_t[m], cr[m]
        if rc.std() < 2.0:  # 直線ばかりの区間は手がかりがない
            continue
        best = None
        for off in np.arange(coarse - 0.3, coarse + 0.3, 0.001):
            lv = np.interp(tc + off, log.t, np.nan_to_num(log.roll_rate))
            ok = np.interp(tc + off, log.t, (~np.isnan(log.roll_rate)).astype(float)) > 0.99
            if ok.mean() < 0.9:
                continue
            cc = np.corrcoef(lv[ok], rc[ok])[0, 1] * sign
            if best is None or cc > best[0]:
                best = (cc, off)
        if best and best[0] > 0.5:
            pts.append((w0 + window_s / 2, best[1], best[0]))
    pts = np.array(pts)
    diag["windows"] = pts
    if len(pts) >= 3:
        # t_log = t_v + off(t_v),  off(t_v) = (a-1)·t_v + b をロバストに当てはめ
        A = np.c_[pts[:, 0], np.ones(len(pts))]
        coef, *_ = np.linalg.lstsq(A, pts[:, 1], rcond=None)
        for _ in range(2):
            r = pts[:, 1] - A @ coef
            keep = np.abs(r) < max(3 * np.median(np.abs(r)), 0.002)
            coef, *_ = np.linalg.lstsq(A[keep], pts[keep, 1], rcond=None)
        a, b = 1 + coef[0], coef[1]
        diag["residual_ms"] = float(np.std(pts[:, 1] - A @ coef) * 1000)
    else:
        a, b = 1.0, coarse
    return a, b, sign, diag


if __name__ == "__main__":
    import sys

    from insv import Insv
    from mount import estimate_mount
    from stabilize import IMU_TO_RIG

    x = Insv(sys.argv[1])
    log = load(sys.argv[2])
    ts, acc, gyro = x.imu()
    R_mount, _ = estimate_mount(acc, gyro)
    ct, cr = camera_roll_rate(ts, gyro, R_mount, IMU_TO_RIG, x.first_frame_us)
    a, b, sign, d = sync(log, ct, cr)
    print(f"粗同期: ログ時刻 = 動画時刻 {d['coarse_offset']:+.3f}s  ピーク {d['peak']:.3f}  第2ピーク比 {d['peak_ratio']:.2f}")
    print(f"精密: ログ時刻 = {a:.8f}·動画時刻 {b:+.4f}s  （時計の速度差 {(a - 1) * 1e6:+.1f}ppm, 窓の残差 {d.get('residual_ms', float('nan')):.1f}ms）")
    print(f"ログ RollRate とカメラのロールレートの符号: {'+' if sign > 0 else '-'}")
    for tv, off, cc in d["windows"]:
        print(f"  動画 {tv:7.1f}s: ずれ {off * 1000:+8.1f}ms  相関 {cc:.3f}")
