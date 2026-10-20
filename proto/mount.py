"""Estimate the camera mount attitude (vehicle up and forward directions in rig coordinates) from the IMU alone.

- Up direction: the mean acceleration over the whole ride. A bike's resultant force points along the vehicle vertical even while leaning, so
          the mean gives the vehicle up direction (front-back acceleration and braking nearly cancel on average)
- Forward direction: the principal component of the lowpass-filtered gyro projected onto the plane perpendicular to the up direction. The roll rotation of
          leaning is the largest, so that axis is the front-back direction (choose the sign closer to the view direction)
"""
import numpy as np

from stabilize import IMU_TO_RIG


def estimate_mount(acc_g, gyro_dps, M=IMU_TO_RIG, forward_hint=(0, 0, -1)):
    a = acc_g @ M.T
    g = gyro_dps @ M.T
    up = a.mean(0)
    up /= np.linalg.norm(up)
    gp = g - np.outer(g @ up, up)
    # The raw gyro is dominated by stick vibration (mainly pitch), so
    # remove the vibration with a 0.5 s average and keep only the leaning motion (slow roll)
    n = len(gp) // 500 * 500
    gp = gp[:n].reshape(-1, 500, 3).mean(1)
    C = gp.T @ gp
    w, V = np.linalg.eigh(C)
    fwd = V[:, -1]
    fwd -= up * (fwd @ up)
    fwd /= np.linalg.norm(fwd)
    if fwd @ np.asarray(forward_hint) < 0:
        fwd = -fwd
    right = np.cross(fwd, up)  # right-handed system with +x right, +y down, +z front: right = fwd × up
    down = -up
    R_mount = np.stack([right, down, fwd], 1)  # columns = vehicle right, down, front (rig coordinates)
    ratio = w[-1] / max(w[-2], 1e-9)
    return R_mount, ratio


if __name__ == "__main__":
    import sys

    from insv import Insv

    x = Insv(sys.argv[1])
    ts, acc, gyro = x.imu()
    Rm, ratio = estimate_mount(acc, gyro)
    np.set_printoptions(precision=4, suppress=True)
    print("Vehicle right, down, front (rig coordinates, columns):\n", Rm)
    print("det", np.linalg.det(Rm), " principal component eigenvalue ratio (larger means a clearer forward direction)", round(ratio, 2))
    up = -Rm[:, 1]
    print("Angle between the up direction and rig -y", np.degrees(np.arccos(-up[1])).round(2), "°")
    np.save("out/mount.npy", Rm)
