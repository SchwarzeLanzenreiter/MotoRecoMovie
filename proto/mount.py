"""カメラの取り付け姿勢（リグ座標での車体の上・前方向）をIMUだけから推定する。

- 上方向: 走行全体の加速度の平均。バイクはリーン中も合力が車体の鉛直方向を向くので、
          平均すると車体の上方向になる（前後の加減速は平均でほぼ相殺される）
- 前方向: 上方向に垂直な面へ射影し、低域通過したジャイロの主成分。リーン動作の
          ロール回転が最も大きいので、その軸が前後方向になる（符号は視点の向きに近い方を選ぶ）
"""
import numpy as np

from stabilize import IMU_TO_RIG


def estimate_mount(acc_g, gyro_dps, M=IMU_TO_RIG, forward_hint=(0, 0, -1)):
    a = acc_g @ M.T
    g = gyro_dps @ M.T
    up = a.mean(0)
    up /= np.linalg.norm(up)
    gp = g - np.outer(g @ up, up)
    # 生のジャイロはスティックの振動（主にピッチ）が支配的なので、
    # 0.5秒平均で振動を落とし、リーン動作（ゆっくりしたロール）だけを残す
    n = len(gp) // 500 * 500
    gp = gp[:n].reshape(-1, 500, 3).mean(1)
    C = gp.T @ gp
    w, V = np.linalg.eigh(C)
    fwd = V[:, -1]
    fwd -= up * (fwd @ up)
    fwd /= np.linalg.norm(fwd)
    if fwd @ np.asarray(forward_hint) < 0:
        fwd = -fwd
    right = np.cross(fwd, up)  # +x右, +y下, +z前 の右手系: right = fwd × up
    down = -up
    R_mount = np.stack([right, down, fwd], 1)  # 列 = 車体の右・下・前（リグ座標）
    ratio = w[-1] / max(w[-2], 1e-9)
    return R_mount, ratio


if __name__ == "__main__":
    import sys

    from insv import Insv

    x = Insv(sys.argv[1])
    ts, acc, gyro = x.imu()
    Rm, ratio = estimate_mount(acc, gyro)
    np.set_printoptions(precision=4, suppress=True)
    print("車体の右・下・前（リグ座標、列）:\n", Rm)
    print("det", np.linalg.det(Rm), " 主成分の固有値比（大きいほど前方向が明確）", round(ratio, 2))
    up = -Rm[:, 1]
    print("上方向とリグ-yのなす角", np.degrees(np.arccos(-up[1])).round(2), "°")
    np.save("out/mount.npy", Rm)
