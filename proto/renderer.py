"""リフレームのレンダラー（スタビライズ＋ローリングシャッター補正）。

時刻の扱い:
  フレーム時刻 tf（露出レコード 0x4 の ts）は読み出しの**中央**を指す（calib_rs.py で推定）。
  画素の行 r（0..1 の割合）は tf + (r - 0.5)·readout + gyro_offset に撮像されたとする。
  仮想カメラの姿勢はフレーム中央の時刻 tc = tf + gyro_offset で決める。

ローリングシャッター補正:
  出力画素の光線を、まずフレーム中央の姿勢で魚眼へ投影して行を求め、
  その行の時刻の姿勢で投影し直す（2回反復）。
"""
import subprocess
from dataclasses import dataclass

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial.transform import Rotation as Rot

from frames import LENS_TO_STREAM
from insv import Insv
from lens import make_rig
from mount import estimate_mount
from stabilize import integrate, sample, smooth


@dataclass
class Settings:
    out_w: int = 1920
    out_h: int = 1080
    in_size: int = 3840          # デコードする魚眼の解像度（調整中は1920で高速化）
    hfov: float = 110.0
    yaw: float = 0.0             # 車体座標。0=前
    pitch: float = 0.0
    sigma: float | tuple = 0.25  # 平滑化の強さ（秒）。(ピッチ, ヨー, ロール) で軸別。0で補正なし（リグ固定）
    readout_ms: float | None = None  # None=メタデータの値
    rs_axis: str = "row"         # 読み出し方向: row=画像の上→下, col=左→右
    rs_sign: int = 1             # -1 で逆向き
    rs_iters: int = 2            # 0でローリングシャッター補正なし
    gyro_offset_us: float | None = None  # フレーム時刻→ジャイロ時間軸の補正（読み出し中央基準）。None=メタデータ field 28
    blend_deg: float = 6.0
    grid: int = 4                # マップを計算する格子間隔[px]（マップは滑らかなので粗く計算して拡大）
    # 車両ログと融合したリーン角 (t_動画秒[100Hz], L[deg, 実際の角度], k)。指定すると平滑化で削れたロールを補完する
    lean: tuple | None = None
    lean_ratio: float = 1.0      # 画面に残すリーンの割合（1=車体と一緒に傾く, 0=水平固定）。lean が必要
    lean_scale: float = 1.0      # 水平補正に使うリーン角の倍率（ログの尺度の検証用）


class Reframer:
    def __init__(self, path, st: Settings, t_start, dur):
        self.path, self.st = path, st
        x = self.insv = Insv(path)
        self.fps = x.fps
        self.f0 = int(round(t_start * self.fps))
        self.nf = int(round(dur * self.fps))
        self.lenses = make_rig(x, picture_w=st.in_size)
        self.readout_us = (st.readout_ms if st.readout_ms is not None else x.meta[25][0]) * 1000
        # field 28 (gyro_timestamp, ms) がフレーム時刻とジャイロのずれ。映像との突き合わせで+1ms前後が最良だった
        self.offset_us = st.gyro_offset_us if st.gyro_offset_us is not None else x.meta[28][0] * 1000
        # 各レンズのフレーム時刻（レンズ1は約40us遅れ）
        self.ft = [x.frame_times(i)[self.f0:self.f0 + self.nf].astype(np.float64) for i in (0, 1)]

        ts, acc, gyro = x.imu()
        R_mount, _ = estimate_mount(acc, gyro)
        lo, hi = np.searchsorted(ts, [self.ft[0][0] - 3e6, self.ft[0][-1] + 3e6])
        self.ts = ts[lo:hi].astype(np.float64)
        self.q = integrate(self.ts, gyro[lo:hi])
        tc = self.ft[0] + self.offset_us
        R_user = Rot.from_matrix(R_mount) * Rot.from_euler("YX", [st.yaw, st.pitch], degrees=True)
        self.R_mount = R_mount
        self.q_c = q_c = sample(self.ts, self.q, tc)
        self.t_video = (tc - x.first_frame_us) / 1e6
        if np.max(st.sigma) > 0:
            qs = smooth(self.ts, self.q, tc, st.sigma, axes=R_mount)
            if st.lean is not None:
                # ロール補完: 平滑化で削れたリーンの動き Δ = L − G*L を、車体の前後軸まわりに足し戻す。
                # ジャイロ側の平滑化と同じ σ のガウスを L に掛けるので、低周波はジャイロ、
                # リーンの速い動きはログ（融合済み）が受け持つ相補フィルタになる
                t_l, L, k = st.lean
                sig_r = float(np.broadcast_to(np.asarray(st.sigma, dtype=float), (3,))[2])
                GL = gaussian_filter1d(L, sig_r * 100.0, truncate=3.0, mode="nearest")
                self.delta_deg = np.interp(self.t_video, t_l, L - GL)
                fwd = R_mount[:, 2]
                comp = Rot.from_rotvec(np.radians(self.delta_deg)[:, None] * fwd[None, :])
                qs = qs * comp
                if st.lean_ratio != 1.0:
                    # 水平補正: 車体の前後軸まわりに -(1 - ratio)·L 回して傾きを戻す
                    # （符号は validate_tilt.py で ratio=0 のとき画面の傾きが 0 になることを確認済み）
                    Lc = np.interp(self.t_video, t_l, L) * st.lean_scale
                    lev = Rot.from_rotvec(np.radians(-(1 - st.lean_ratio) * Lc)[:, None] * fwd[None, :])
                    qs = qs * lev
            # 世界座標での仮想カメラ姿勢（ジャイロ積分の原点基準）
            self.view_world = [qs[i] * R_user for i in range(self.nf)]
            self.corr_deg = np.degrees(np.linalg.norm((q_c.inv() * qs).as_rotvec(), axis=1))
        else:
            # 補正なし: 仮想カメラはリグに固定 → 世界姿勢は q(tc)·R_user
            self.view_world = [q_c[i] * R_user for i in range(self.nf)]
            self.corr_deg = np.zeros(self.nf)

        f = (st.out_w / 2) / np.tan(np.radians(st.hfov) / 2)
        # 粗い格子（両端の画素中心を含む）で光線を作り、出力画素へは双線形補間で拡大する
        nx = max(2, int(np.ceil((st.out_w - 1) / st.grid)) + 1)
        ny = max(2, int(np.ceil((st.out_h - 1) / st.grid)) + 1)
        gx = np.linspace(0.5, st.out_w - 0.5, nx)
        gy = np.linspace(0.5, st.out_h - 0.5, ny)
        uu, vv = np.meshgrid(gx, gy)
        self.cam_rays = np.stack([(uu - st.out_w / 2) / f, (vv - st.out_h / 2) / f, np.ones_like(uu)], -1)
        px, py = np.meshgrid(np.arange(st.out_w, dtype=np.float32), np.arange(st.out_h, dtype=np.float32))
        self.up_x = (px / (st.out_w - 1) * (nx - 1)).astype(np.float32)
        self.up_y = (py / (st.out_h - 1) * (ny - 1)).astype(np.float32)

    def _rs_fraction(self, u, v):
        n = self.st.in_size
        r = (v if self.st.rs_axis == "row" else u) / n
        return r if self.st.rs_sign > 0 else 1 - r

    def maps(self, i):
        """フレーム i の各レンズの remap マップとブレンドウェイトを返す。"""
        st = self.st
        W = self.view_world[i].as_matrix()
        rays_world = self.cam_rays @ W.T
        out = []
        for li, L in enumerate(self.lenses):
            tc = self.ft[li][i] + self.offset_us
            # 読み出し中の姿勢を K 点で求め、行ごとに線形補間する
            K = 17
            tk = tc + (np.linspace(0, 1, K) - 0.5) * self.readout_us
            qk = sample(self.ts, self.q, tk)
            q_c = sample(self.ts, self.q, np.array([tc]))[0]
            d_mid = rays_world @ q_c.as_matrix()  # = q_c⁻¹ · 光線（行列の転置で逆回転）
            u, v, th = L.project(d_mid)
            if st.rs_iters > 0:
                # Δ_k = q_c⁻¹ q(t_k)、リグ座標の光線は Δ(t)⁻¹ · d_mid
                rv = (q_c.inv() * qk).as_rotvec()  # (K,3)
                for _ in range(st.rs_iters):
                    fr = np.clip(self._rs_fraction(u, v), 0, 1) * (K - 1)
                    k0 = np.clip(fr.astype(np.int32), 0, K - 2)
                    a = (fr - k0)[..., None]
                    r = rv[k0] * (1 - a) + rv[k0 + 1] * a  # 画素ごとの回転ベクトル
                    # Δ⁻¹ を適用（ロドリゲスの公式, 角度 -|r|）
                    ang = np.linalg.norm(r, axis=-1, keepdims=True)
                    kx = r / np.maximum(ang, 1e-12)
                    c, s = np.cos(-ang), np.sin(-ang)
                    d = d_mid * c + np.cross(kx, d_mid) * s + kx * (kx * d_mid).sum(-1, keepdims=True) * (1 - c)
                    u, v, th = L.project(d)
            up = lambda a: cv2.remap(a.astype(np.float32), self.up_x, self.up_y, cv2.INTER_LINEAR)
            out.append((up(u), up(v), up(th)))
        diff = np.degrees(out[1][2] - out[0][2])
        w0 = np.clip(0.5 + diff / st.blend_deg, 0, 1).astype(np.float32)
        return out, w0

    def render(self, i, imgs):
        mp, w0 = self.maps(i)
        acc = np.zeros((self.st.out_h, self.st.out_w, 3), np.float32)
        for li in (0, 1):
            w = (w0 if li == 0 else 1 - w0)[..., None]
            s = cv2.remap(imgs[li], mp[li][0], mp[li][1], cv2.INTER_LINEAR)
            acc += s.astype(np.float32) * w
        return np.clip(acc, 0, 255).astype(np.uint8)

    # ---- 入出力 ----
    def readers(self):
        n = self.st.in_size
        procs = []
        for lens in (0, 1):
            cmd = ["ffmpeg", "-v", "error", "-hwaccel", "cuda", "-ss", f"{self.f0 / self.fps:.6f}", "-i", self.path,
                   "-map", f"0:{LENS_TO_STREAM[lens]}", "-frames:v", str(self.nf)]
            if n != 3840:
                cmd += ["-vf", f"scale={n}:{n}:flags=area"]
            cmd += ["-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
            procs.append(subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=n * n * 3))
        return procs

    def frames(self):
        n = self.st.in_size
        rd = self.readers()
        try:
            for i in range(self.nf):
                imgs = []
                for r in rd:
                    buf = r.stdout.read(n * n * 3)
                    if len(buf) < n * n * 3:
                        return
                    imgs.append(np.frombuffer(buf, np.uint8).reshape(n, n, 3))
                yield i, imgs
        finally:
            for r in rd:
                r.kill()


def open_writer(fn, w, h, fps, audio_from=None, t0=0.0, dur=None):
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-"]
    if audio_from:
        cmd += ["-ss", f"{t0:.6f}", "-t", f"{dur:.3f}", "-i", audio_from, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-shortest"]
    cmd += ["-c:v", "hevc_nvenc", "-preset", "p5", "-cq", "20", "-pix_fmt", "yuv420p", fn]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)
