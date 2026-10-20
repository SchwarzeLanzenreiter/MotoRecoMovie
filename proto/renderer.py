"""Reframing renderer (stabilization + rolling shutter correction).

Handling of time:
  The frame time tf (ts of exposure record 0x4) points to the **center** of the readout (estimated by calib_rs.py).
  Pixel row r (a fraction from 0 to 1) is assumed to be captured at tf + (r - 0.5)·readout + gyro_offset.
  The virtual camera attitude is determined at the frame-center time tc = tf + gyro_offset.

Rolling shutter correction:
  Project the ray of each output pixel onto the fisheye with the frame-center attitude to get the row,
  then project again with the attitude at that row's time (2 iterations).
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
    in_size: int = 3840          # resolution of the fisheye to decode (1920 is faster while tuning)
    hfov: float = 110.0
    yaw: float = 0.0             # vehicle coordinates. 0 = front
    pitch: float = 0.0
    sigma: float | tuple = 0.25  # smoothing strength (seconds). Per axis as (pitch, yaw, roll). 0 means no correction (rig-fixed)
    readout_ms: float | None = None  # None = value from the metadata
    rs_axis: str = "row"         # readout direction: row = image top -> bottom, col = left -> right
    rs_sign: int = 1             # -1 for the reverse direction
    rs_iters: int = 2            # 0 means no rolling shutter correction
    gyro_offset_us: float | None = None  # correction from frame time to the gyro time axis (relative to the readout center). None = metadata field 28
    blend_deg: float = 6.0
    grid: int = 4                # grid spacing [px] for computing the maps (maps are smooth, so compute coarsely and upscale)
    # lean angle fused with the vehicle log (t_video seconds [100Hz], L [deg, actual angle], k). If given, inpaints the roll removed by smoothing
    lean: tuple | None = None
    lean_ratio: float = 1.0      # fraction of lean kept on screen (1 = tilts with the vehicle, 0 = horizon locked). Requires lean
    lean_scale: float = 1.0      # scale factor of the lean angle used for horizon correction (for verifying the log scale)


class Reframer:
    def __init__(self, path, st: Settings, t_start, dur):
        self.path, self.st = path, st
        x = self.insv = Insv(path)
        self.fps = x.fps
        self.f0 = int(round(t_start * self.fps))
        self.nf = int(round(dur * self.fps))
        self.lenses = make_rig(x, picture_w=st.in_size)
        self.readout_us = (st.readout_ms if st.readout_ms is not None else x.meta[25][0]) * 1000
        # field 28 (gyro_timestamp, ms) is the offset between frame time and gyro. Matching against the video, around +1 ms was best
        self.offset_us = st.gyro_offset_us if st.gyro_offset_us is not None else x.meta[28][0] * 1000
        # frame time of each lens (lens 1 lags by about 40 us)
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
                # Roll inpainting: add the lean motion removed by smoothing, Δ = L − G*L, back around the vehicle front-back axis.
                # A Gaussian with the same σ as the gyro-side smoothing is applied to L, so this becomes a complementary filter where the gyro handles low frequencies
                # and the log (fused) handles fast lean motion
                t_l, L, k = st.lean
                sig_r = float(np.broadcast_to(np.asarray(st.sigma, dtype=float), (3,))[2])
                GL = gaussian_filter1d(L, sig_r * 100.0, truncate=3.0, mode="nearest")
                self.delta_deg = np.interp(self.t_video, t_l, L - GL)
                fwd = R_mount[:, 2]
                comp = Rot.from_rotvec(np.radians(self.delta_deg)[:, None] * fwd[None, :])
                qs = qs * comp
                if st.lean_ratio != 1.0:
                    # Horizon correction: rotate by -(1 - ratio)·L around the vehicle front-back axis to undo the tilt
                    # (the sign was confirmed with validate_tilt.py: the screen tilt becomes 0 when ratio=0)
                    Lc = np.interp(self.t_video, t_l, L) * st.lean_scale
                    lev = Rot.from_rotvec(np.radians(-(1 - st.lean_ratio) * Lc)[:, None] * fwd[None, :])
                    qs = qs * lev
            # Virtual camera attitude in world coordinates (relative to the origin of gyro integration)
            self.view_world = [qs[i] * R_user for i in range(self.nf)]
            self.corr_deg = np.degrees(np.linalg.norm((q_c.inv() * qs).as_rotvec(), axis=1))
        else:
            # No correction: the virtual camera is fixed to the rig -> world attitude is q(tc)·R_user
            self.view_world = [q_c[i] * R_user for i in range(self.nf)]
            self.corr_deg = np.zeros(self.nf)

        f = (st.out_w / 2) / np.tan(np.radians(st.hfov) / 2)
        # Build rays on a coarse grid (including the pixel centers at both ends) and upscale to the output pixels with bilinear interpolation
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
        """Return the remap maps and blend weights of each lens for frame i."""
        st = self.st
        W = self.view_world[i].as_matrix()
        rays_world = self.cam_rays @ W.T
        out = []
        for li, L in enumerate(self.lenses):
            tc = self.ft[li][i] + self.offset_us
            # Compute the attitude during readout at K points and interpolate linearly per row
            K = 17
            tk = tc + (np.linspace(0, 1, K) - 0.5) * self.readout_us
            qk = sample(self.ts, self.q, tk)
            q_c = sample(self.ts, self.q, np.array([tc]))[0]
            d_mid = rays_world @ q_c.as_matrix()  # = q_c⁻¹ · ray (inverse rotation via matrix transpose)
            u, v, th = L.project(d_mid)
            if st.rs_iters > 0:
                # Δ_k = q_c⁻¹ q(t_k), ray in rig coordinates is Δ(t)⁻¹ · d_mid
                rv = (q_c.inv() * qk).as_rotvec()  # (K,3)
                for _ in range(st.rs_iters):
                    fr = np.clip(self._rs_fraction(u, v), 0, 1) * (K - 1)
                    k0 = np.clip(fr.astype(np.int32), 0, K - 2)
                    a = (fr - k0)[..., None]
                    r = rv[k0] * (1 - a) + rv[k0 + 1] * a  # per-pixel rotation vector
                    # Apply Δ⁻¹ (Rodrigues' formula, angle -|r|)
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

    # ---- Input / output ----
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
