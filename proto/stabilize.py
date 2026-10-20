"""Gyro integration and attitude smoothing (follow-type stabilization without a horizon lock).

Idea:
  q(t)   : actual camera attitude, rig coordinates -> world coordinates (gyro integration)
  qs(t)  : q(t) smoothed with a Gaussian window. Including roll (vehicle lean),
           it follows slow motion and only fast components such as vibration are removed
  Output virtual camera attitude = qs(t) · R_user(t) (R_user is the view set by keyframes)
  Ray sampled in rig coordinates = q(t)⁻¹ · qs(t) · R_user(t) · ray_cam
"""
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from scipy.spatial.transform import Slerp

# IMU coordinates -> rig coordinates (+x right, +y down, +z front). Estimated by matching against the video (X6)
IMU_TO_RIG = np.array([[0, 0, -1], [1, 0, 0], [0, -1, 0]], dtype=np.float64)


def integrate(ts_us, gyro_dps, M=IMU_TO_RIG):
    """Integrate the gyro and return the attitude (rig -> world) at each sample time."""
    w = np.radians(gyro_dps) @ M.T
    dt = np.diff(ts_us, prepend=ts_us[0]) / 1e6
    # Midpoint rule: the angular velocity over the interval [i-1, i] is the mean of both ends
    wm = np.vstack([w[:1], (w[1:] + w[:-1]) / 2])
    steps = Rot.from_rotvec(wm * dt[:, None])
    # Multiply body-frame rotations from the right (cumulative quaternion product)
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
    """For each time in t_us, return the attitude averaged over the surrounding attitudes with a Gaussian window (no phase lag).

    sigma_s is a scalar, or seconds for (pitch, yaw, roll). When specified per axis,
    axes (columns = vehicle right, down, front expressed in rig coordinates, = R_mount) is required.
    Centered on the attitude at each time, Gaussian-average the relative rotation vectors to the surrounding attitudes per vehicle axis."""
    sig = np.broadcast_to(np.asarray(sigma_s, dtype=np.float64), (3,))
    if axes is None:
        axes = np.eye(3)
    smax = sig.max()
    half = int(np.ceil(3 * smax * 1e6 / step_us))
    grid = np.arange(t_us.min() - (half + 2) * step_us, t_us.max() + (half + 2) * step_us, step_us)
    gq = sample(ts_us, rots, grid)
    k = np.arange(-half, half + 1)
    dt = k * step_us / 1e6
    wk = np.exp(-0.5 * (dt[:, None] / np.maximum(sig[None, :], 1e-6)) ** 2)  # (window, 3 axes)
    wk /= wk.sum(0, keepdims=True)
    centers = sample(ts_us, rots, t_us)
    out = np.empty((len(t_us), 4))
    for s0 in range(0, len(t_us), 256):
        sl = slice(s0, min(s0 + 256, len(t_us)))
        c = np.rint((t_us[sl] - grid[0]) / step_us).astype(int)
        idx = np.clip(c[:, None] + k[None, :], 0, len(grid) - 1)  # (n, window)
        cen = centers[sl]
        n, m = idx.shape
        rel = (Rot.from_quat(np.repeat(cen.as_quat(), m, 0)).inv() * gq[idx.ravel()]).as_rotvec().reshape(n, m, 3)
        rel_b = rel @ axes  # components on the vehicle axes (pitch = right, yaw = down, roll = front)
        avg_b = (rel_b * wk[None, :, :]).sum(1)
        avg = avg_b @ axes.T
        out[sl] = (cen * Rot.from_rotvec(avg)).as_quat()
    return Rot.from_quat(out)
