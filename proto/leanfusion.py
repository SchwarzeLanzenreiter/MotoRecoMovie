"""カメラのジャイロとMotoRecoのリーン角を融合して、車体のリーン角を連続的に推定する。

状態 x = [リーン角 L (deg), ジャイロのバイアス b (deg/s)]
  予測: L ← L + (ω_roll − b)·dt   （ω_roll = カメラのジャイロを車体ロール軸へ射影, 3Hz以下）
  観測: ログの LeanAngle / k が「更新された時刻」だけ（止まっている間は観測なし）
オフラインなので前向きのカルマンフィルタ＋後ろ向きのRTS平滑化で推定する。

k = d(LeanAngle)/dt ÷ ω_roll（回帰で求める）。このログでは k=0.93 で、MotoReco の LeanAngle は
実際の傾きを約7%小さく記録している（水平固定した映像で電柱の傾きが残ることで確認）。
ジャイロの回転量の方が正確なので、L はジャイロの尺度（実際の角度）にそろえる。
"""
import numpy as np
from scipy.signal import butter, sosfiltfilt

FS = 100.0


def fit_rate_gain(log_t_on_video, lean, cam_t, cam_rate):
    """d(LeanAngle)/dt ≈ k·ω_roll となる k を求める。"""
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
    """RTS平滑化でリーン角を推定。cam_t（等間隔100Hz, 動画時刻）上の L と標準偏差を返す。"""
    sos = butter(2, 3.0, fs=FS, output="sos")
    u = sosfiltfilt(sos, cam_rate)  # deg/s（実際の角度。ログ側を 1/k 倍してそろえる）
    meas_v = meas_v / k
    n = len(cam_t)
    dt = 1 / FS
    F = np.array([[1, -dt], [0, 1]])
    Q = np.diag([(rate_sigma * dt) ** 2, (bias_sigma * dt) ** 2])
    H = np.array([1.0, 0.0])
    R = (meas_sigma / k) ** 2
    # 観測をグリッドに割り当てる（最も近いサンプル）
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
        # 予測
        x = F @ x + np.array([u[i] * dt, 0.0])
        P = F @ P @ F.T + Q
        xp_all[i], Pp_all[i] = x, P
        # 観測
        if not np.isnan(zmap[i]):
            S = H @ P @ H + R
            K = P @ H / S
            x = x + K * (zmap[i] - H @ x)
            P = P - np.outer(K, H @ P)
        xs[i], Ps[i] = x, P
    # RTS平滑化（後ろ向き）
    for i in range(n - 2, -1, -1):
        C = Ps[i] @ F.T @ np.linalg.inv(Pp_all[i + 1])
        xs[i] = xs[i] + C @ (xs[i + 1] - xp_all[i + 1])
        Ps[i] = Ps[i] + C @ (Ps[i + 1] - Pp_all[i + 1]) @ C.T
    return xs[:, 0], np.sqrt(Ps[:, 0, 0]), xs[:, 1]


def bike_lean(insv, log, R_mount, M, sync_ab):
    """動画時刻 100Hz のグリッド上で融合したリーン角を返す: (t, L, σ, k, 診断)。"""
    from motoreco import camera_roll_rate

    ts, acc, gyro = insv.imu()
    ct, cr = camera_roll_rate(ts, gyro, R_mount, M, insv.first_frame_us, FS)
    a, b = sync_ab
    log_on_video = (log.t - b) / a  # ログ時刻 → 動画時刻
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
    print(f"同期: ログ時刻 = {a:.8f}·動画時刻 {b:+.4f}s")
    print(f"換算係数 k = {k:.4f}（dLean/dt = k·カメラのロールレート, 相関 {diag['rate_corr']:.3f}）")
    log_v = (log.t - b) / a
    # 観測点での残差
    upd = log.lean_updated & (log_v > t[0]) & (log_v < t[-1])
    res = np.interp(log_v[upd], t, L) - log.lean[upd] / k
    print(f"更新点での残差（ログ/k との差）: RMS {np.sqrt(np.mean(res ** 2)):.2f}°  95% {np.percentile(np.abs(res), 95):.2f}°")
    print(f"推定の標準偏差: 中央 {np.median(sd):.2f}°  最大 {sd.max():.2f}°")
    print(f"ジャイロバイアス推定: {diag['bias'].min():.3f}〜{diag['bias'].max():.3f} deg/s")
    np.savez("out/lean_fused.npz", t=t, L=L, sd=sd, k=k, a=a, b=b)
    # 止まっていた区間の例: 動画65秒付近
    for tv in np.arange(64.5, 67.6, 0.25):
        lv = np.interp(tv, log_v, log.lean)
        print(f"  動画 {tv:6.2f}s  ログ/k {lv / k:6.1f}°  融合 {np.interp(tv, t, L):6.1f}° (±{np.interp(tv, t, sd):.1f})")
