"""Fuse the camera gyro and the MotoReco lean angle to estimate the vehicle lean angle continuously.

State x = [lean angle L (deg), gyro bias b (deg/s)]
  Prediction: L <- L + (ω_roll − b)·dt   (ω_roll = camera gyro projected onto the vehicle roll axis, 3 Hz or lower)
  Observation: LeanAngle / k from the log only at the times it was "updated" (no observation while stopped)
Since this runs offline, estimate with a forward Kalman filter + backward RTS smoothing.

k = d(LeanAngle)/dt ÷ ω_roll (found by regression). In this log k=0.93, and the MotoReco LeanAngle
records the actual lean about 7% too small (confirmed by utility poles still leaning in horizon-locked video).
The gyro rotation amount is more accurate, so L is aligned to the gyro scale (the actual angle).
"""
import numpy as np
from scipy.signal import butter, sosfiltfilt

FS = 100.0


def fit_rate_gain(log_t_on_video, lean, cam_t, cam_rate):
    """Find k such that d(LeanAngle)/dt ≈ k·ω_roll."""
    sos = butter(2, 1.0, fs=FS, output="sos")
    grid = cam_t
    L = np.interp(grid, log_t_on_video, lean)
    dL = np.gradient(sosfiltfilt(sos, L), 1 / FS)
    w = sosfiltfilt(sos, cam_rate)
    m = np.isfinite(dL) & (np.abs(w) < 200)
    k = np.dot(w[m], dL[m]) / np.dot(w[m], w[m])
    r = np.corrcoef(w[m], dL[m])[0, 1]
    return k, r


def fuse(cam_t, cam_rate, k, meas_t, meas_v, meas_sigma=0.6, rate_sigma=3.0, bias_sigma=0.05):
    """Estimate the lean angle with RTS smoothing. Returns L and the standard deviation on cam_t (uniform 100 Hz, video time)."""
    sos = butter(2, 3.0, fs=FS, output="sos")
    u = sosfiltfilt(sos, cam_rate)  # deg/s (actual angle; the log side is scaled by 1/k to match)
    meas_v = meas_v / k
    n = len(cam_t)
    dt = 1 / FS
    F = np.array([[1, -dt], [0, 1]])
    Q = np.diag([(rate_sigma * dt) ** 2, (bias_sigma * dt) ** 2])
    H = np.array([1.0, 0.0])
    R = (meas_sigma / k) ** 2
    # Assign observations to the grid (nearest sample)
    idx = np.clip(np.rint((meas_t - cam_t[0]) * FS).astype(int), 0, n - 1)
    zmap = np.full(n, np.nan)
    zmap[idx] = meas_v
    xs = np.zeros((n, 2))
    Ps = np.zeros((n, 2, 2))
    xp_all = np.zeros((n, 2))
    Pp_all = np.zeros((n, 2, 2))
    first = np.flatnonzero(~np.isnan(zmap))[0]
    x = np.array([zmap[first], 0.0])
    P = np.diag([5.0 ** 2, 1.0 ** 2])
    for i in range(n):
        # Prediction
        x = F @ x + np.array([u[i] * dt, 0.0])
        P = F @ P @ F.T + Q
        xp_all[i], Pp_all[i] = x, P
        # Observation
        if not np.isnan(zmap[i]):
            S = H @ P @ H + R
            K = P @ H / S
            x = x + K * (zmap[i] - H @ x)
            P = P - np.outer(K, H @ P)
        xs[i], Ps[i] = x, P
    # RTS smoothing (backward)
    for i in range(n - 2, -1, -1):
        C = Ps[i] @ F.T @ np.linalg.inv(Pp_all[i + 1])
        xs[i] = xs[i] + C @ (xs[i + 1] - xp_all[i + 1])
        Ps[i] = Ps[i] + C @ (Ps[i + 1] - Pp_all[i + 1]) @ C.T
    return xs[:, 0], np.sqrt(Ps[:, 0, 0]), xs[:, 1]


def bike_lean(insv, log, R_mount, M, sync_ab):
    """Return the fused lean angle on a 100 Hz video-time grid: (t, L, σ, k, diagnostics)."""
    from motoreco import camera_roll_rate

    ts, acc, gyro = insv.imu()
    ct, cr = camera_roll_rate(ts, gyro, R_mount, M, insv.first_frame_us, FS)
    a, b = sync_ab
    log_on_video = (log.t - b) / a  # log time -> video time
    k, r = fit_rate_gain(log_on_video, log.lean, ct, cr)
    upd = log.lean_updated
    L, sd, bias = fuse(ct, cr, k, log_on_video[upd], log.lean[upd])
    return ct, L, sd, k, {"rate_corr": r, "bias": bias}


if __name__ == "__main__":
    import sys

    import motoreco as mr
    from insv import Insv
    from mount import estimate_mount
    from stabilize import IMU_TO_RIG

    x = Insv(sys.argv[1])
    log = mr.load(sys.argv[2])
    ts, acc, gyro = x.imu()
    Rm, _ = estimate_mount(acc, gyro)
    ct, cr = mr.camera_roll_rate(ts, gyro, Rm, IMU_TO_RIG, x.first_frame_us)
    a, b, s, d = mr.sync(log, ct, cr)
    t, L, sd, k, diag = bike_lean(x, log, Rm, IMU_TO_RIG, (a, b))
    print(f"Sync: log time = {a:.8f}·video time {b:+.4f}s")
    print(f"Conversion factor k = {k:.4f} (dLean/dt = k·camera roll rate, correlation {diag['rate_corr']:.3f})")
    log_v = (log.t - b) / a
    # Residuals at the observation points
    upd = log.lean_updated & (log_v > t[0]) & (log_v < t[-1])
    res = np.interp(log_v[upd], t, L) - log.lean[upd] / k
    print(f"Residual at update points (difference from log/k): RMS {np.sqrt(np.mean(res ** 2)):.2f}°  95% {np.percentile(np.abs(res), 95):.2f}°")
    print(f"Estimated standard deviation: median {np.median(sd):.2f}°  max {sd.max():.2f}°")
    print(f"Estimated gyro bias: {diag['bias'].min():.3f} to {diag['bias'].max():.3f} deg/s")
    np.savez("out/lean_fused.npz", t=t, L=L, sd=sd, k=k, a=a, b=b)
    # Example of a stopped interval: around 65 s of the video
    for tv in np.arange(64.5, 67.6, 0.25):
        lv = np.interp(tv, log_v, log.lean)
        print(f"  video {tv:6.2f}s  log/k {lv / k:6.1f}°  fused {np.interp(tv, t, L):6.1f}° (±{np.interp(tv, t, sd):.1f})")
