"""ジャイロ積分と姿勢の平滑化（ホライズンロックなしの追従型スタビライズ）。

考え方:
  q(t)   : リグ座標→世界座標の実際のカメラ姿勢（ジャイロ積分）
  qs(t)  : q(t) をガウス窓で平滑化した姿勢。ロール（車体の傾き）も含めて
           ゆっくりした動きには追従し、振動などの速い成分だけが落ちる
  出力の仮想カメラ姿勢 = qs(t) · R_user(t)（R_user はキーフレームで決める視点）
  リグ座標でサンプリングする光線 = q(t)⁻¹ · qs(t) · R_user(t) · 光線_cam
"""
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from scipy.spatial.transform import Slerp

# IMU座標 → リグ座標（+x右, +y下, +z前）。映像との突き合わせで推定（X6）
IMU_TO_RIG = np.array([[0, 0, -1], [1, 0, 0], [0, -1, 0]], dtype=np.float64)


def integrate(ts_us, gyro_dps, M=IMU_TO_RIG):
    """ジャイロを積分して各サンプル時刻の姿勢（リグ→世界）を返す。"""
    w = np.radians(gyro_dps) @ M.T
    dt = np.diff(ts_us, prepend=ts_us[0]) / 1e6
    # 中点則: 区間 [i-1, i] の角速度は両端の平均
    wm = np.vstack([w[:1], (w[1:] + w[:-1]) / 2])
    steps = Rot.from_rotvec(wm * dt[:, None])
    # 体座標系での回転を右から掛けていく（クォータニオン積の累積）
    out = np.empty((len(ts_us), 4))
    cur = Rot.identity()
    sq = steps.as_quat()
    for s0 in range(0, len(sq), 4096):
        blk = Rot.from_quat(sq[s0:s0 + 4096])
        for j in range(len(blk)):
            cur = cur * blk[j]
            out[s0 + j] = cur.as_quat()
    return Rot.from_quat(out)


def sample(ts_us, rots, t_us):
    return Slerp(ts_us, rots)(np.clip(t_us, ts_us[0], ts_us[-1]))


def smooth(ts_us, rots, t_us, sigma_s, step_us=5000, axes=None):
    """t_us の各時刻について、周囲の姿勢をガウス窓で平均した姿勢を返す（位相遅れなし）。

    sigma_s はスカラー、または (ピッチ, ヨー, ロール) の秒。軸ごとに指定する場合は
    axes（列 = 車体の右・下・前をリグ座標で表したもの、= R_mount）が必要。
    各時刻の姿勢を中心に、周囲の姿勢との相対回転ベクトルを車体の軸ごとにガウス平均する。"""
    sig = np.broadcast_to(np.asarray(sigma_s, dtype=np.float64), (3,))
    if axes is None:
        axes = np.eye(3)
    smax = sig.max()
    half = int(np.ceil(3 * smax * 1e6 / step_us))
    grid = np.arange(t_us.min() - (half + 2) * step_us, t_us.max() + (half + 2) * step_us, step_us)
    gq = sample(ts_us, rots, grid)
    k = np.arange(-half, half + 1)
    dt = k * step_us / 1e6
    wk = np.exp(-0.5 * (dt[:, None] / np.maximum(sig[None, :], 1e-6)) ** 2)  # (窓, 3軸)
    wk /= wk.sum(0, keepdims=True)
    centers = sample(ts_us, rots, t_us)
    out = np.empty((len(t_us), 4))
    for s0 in range(0, len(t_us), 256):
        sl = slice(s0, min(s0 + 256, len(t_us)))
        c = np.rint((t_us[sl] - grid[0]) / step_us).astype(int)
        idx = np.clip(c[:, None] + k[None, :], 0, len(grid) - 1)  # (n, 窓)
        cen = centers[sl]
        n, m = idx.shape
        rel = (Rot.from_quat(np.repeat(cen.as_quat(), m, 0)).inv() * gq[idx.ravel()]).as_rotvec().reshape(n, m, 3)
        rel_b = rel @ axes  # 車体の軸（ピッチ=右, ヨー=下, ロール=前）成分
        avg_b = (rel_b * wk[None, :, :]).sum(1)
        avg = avg_b @ axes.T
        out[sl] = (cen * Rot.from_rotvec(avg)).as_quat()
    return Rot.from_quat(out)
