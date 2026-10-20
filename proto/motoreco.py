"""Loading of the MotoReco vehicle log (CSV, "TO Custom v1") and time synchronization with the camera video.

Synchronization method:
  Cross-correlate the roll rate (camera gyro projected onto the vehicle roll axis) with the RollRate in the log.
  1. Coarse sync: cross-correlate the whole range with FFT (found however many minutes the recording starts differ)
  2. Refinement: find the offset in 1 ms steps for each 60 s window and fit t_log = a·t_video + b
     (a is the clock rate difference between camera and logger, b is the offset)
  The offset found also includes the vehicle IMU processing delay and CAN transmission delay (= what we want to align as the recorded time).
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.signal import butter, correlate, sosfiltfilt

INVALID = -124.9  # the logger's invalid value is -125


@dataclass
class BikeLog:
    t: np.ndarray            # seconds (from the start of the log)
    lean: np.ndarray         # lean angle [deg] (sign as in the log)
    lean_updated: np.ndarray  # whether the value was updated at that time (False while stopped)
    roll_rate: np.ndarray    # RollRate (log units, NaN if invalid)
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
    """Project the camera gyro onto the vehicle roll axis and return (video time, deg/s) at uniform fs [Hz]."""
    w = gyro_dps @ M.T @ R_mount  # vehicle (pitch, yaw, roll) components
    n = int(1000 / fs)
    m = len(ts_us) // n * n
    t = (ts_us[:m].reshape(-1, n).mean(1) - t0_us) / 1e6
    r = w[:m, 2].reshape(-1, n).mean(1)
    return t, r


def _norm(x):
    x = np.nan_to_num(x - np.nanmean(x))
    return x / (x.std() + 1e-12)


def sync(log: BikeLog, cam_t, cam_roll, window_s=60.0, fs=100.0):
    """Estimate log time = a·video time + b. Returns: (a, b, sign, diagnostics)."""
    sos = butter(2, 3.0, fs=fs, output="sos")  # remove the vibration of the stick (3 Hz or lower)
    cr = sosfiltfilt(sos, cam_roll)
    grid = np.arange(0, log.t[-1], 1 / fs)
    rr = np.interp(grid, log.t, np.nan_to_num(log.roll_rate))
    valid = np.interp(grid, log.t, (~np.isnan(log.roll_rate)).astype(float)) > 0.99
    rr[~valid] = 0
    # ---- 1. Coarse sync (FFT cross-correlation, full range) ----
    a_, b_ = _norm(rr), _norm(cr)
    c = correlate(a_, b_, mode="full", method="fft") / min(len(a_), len(b_))
    lags = np.arange(-len(b_) + 1, len(a_))
    j = np.argmax(np.abs(c))
    sign = np.sign(c[j])
    # correlate: c[lag] = Σ log[n+lag]·cam[n] -> log time (n+lag)/fs corresponds to video time cam_t[0]+n/fs
    # -> log time = video time + lag/fs - cam_t[0]
    coarse = lags[j] / fs - cam_t[0]
    c_sorted = np.sort(np.abs(c))
    diag = {"coarse_offset": coarse, "peak": float(abs(c[j]))}
    # Ratio to the second peak (outside ±2 s) = sync confidence
    far = np.abs(lags - lags[j]) > 2 * fs
    diag["peak_ratio"] = float(abs(c[j]) / np.abs(c[far]).max())

    # ---- 2. Refinement per window (1 ms steps) ----
    pts = []
    for w0 in np.arange(cam_t[0], cam_t[-1] - window_s, window_s / 2):
        m = (cam_t >= w0) & (cam_t < w0 + window_s)
        if m.sum() < window_s * fs * 0.9:
            continue
        tc, rc = cam_t[m], cr[m]
        if rc.std() < 2.0:  # a section of only straight lines gives no clue
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
        # t_log = t_v + off(t_v),  off(t_v) = (a-1)·t_v + b fitted robustly
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
    print(f"Coarse sync: log time = video time {d['coarse_offset']:+.3f}s  peak {d['peak']:.3f}  second peak ratio {d['peak_ratio']:.2f}")
    print(f"Refined: log time = {a:.8f}·video time {b:+.4f}s  (clock rate difference {(a - 1) * 1e6:+.1f}ppm, window residual {d.get('residual_ms', float('nan')):.1f}ms)")
    print(f"Sign between log RollRate and camera roll rate: {'+' if sign > 0 else '-'}")
    for tv, off, cc in d["windows"]:
        print(f"  video {tv:7.1f}s: offset {off * 1000:+8.1f}ms  correlation {cc:.3f}")
