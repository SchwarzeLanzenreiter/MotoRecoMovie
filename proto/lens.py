"""Insta360 lens model (Mei unified sphere + RadtanPro 13-term distortion) and stitching.

Reference: telemetry-parser (MIT/Apache-2.0) src/insta360/rig.rs and
the definition of MeiDistortion::RadtanPro in the video-types crate.

Coordinate system (rig coordinates): +x right, +y down, +z front (optical axis direction of lens 0).
"""
import numpy as np
from scipy.spatial.transform import Rotation as Rot


def _rx(a):
    return Rot.from_rotvec([a, 0, 0]).as_matrix()


def _ry(a):
    return Rot.from_rotvec([0, a, 0]).as_matrix()


def _rz(a):
    return Rot.from_rotvec([0, 0, a]).as_matrix()


def vendor_rotation(ypr_deg, lens_index, num_lenses=2):
    """Manufacturer-defined world -> camera rotation matrix."""
    yaw, pitch, roll = np.radians(ypr_deg)
    r = _ry(pitch + np.pi / 2) @ _rz(yaw) @ _rx(roll)
    if lens_index == 0 and num_lenses == 2:
        r = r @ _rz(np.pi)
    return r


class Lens:
    def __init__(self, calib, index, num_lenses, picture_w):
        self.xi = calib["fov_rad"]  # the first value of the string is xi
        self.fx, self.fy = calib["fx"], calib["fy"]
        frame_w = calib["img_w"] / num_lenses
        # The principal point of lens 1 is shifted right by one image width in the side-by-side space
        self.cx = calib["cx"] - frame_w * index
        self.cy = calib["cy"]
        self.d = np.array(calib["k"], dtype=np.float64)  # d0..d12
        self.scale = picture_w / frame_w  # uniform scale from the calibration space to the actual video (3840)
        base = vendor_rotation([0.0, 0.0, 90.0], 0, num_lenses)
        # ray in rig coordinates -> ray in camera coordinates
        self.R_cam_from_rig = vendor_rotation(calib["rot_deg"], index, num_lenses) @ base.T

    def project(self, rays_rig):
        """Rays in rig coordinates (N,3) -> pixel coordinates (u, v) on the video and the angle θ from the optical axis."""
        c = rays_rig @ self.R_cam_from_rig.T
        c = c / np.linalg.norm(c, axis=-1, keepdims=True)
        x, y, z = c[..., 0], c[..., 1], c[..., 2]
        den = z + self.xi
        mx, my = x / den, y / den
        d = self.d
        r2 = mx * mx + my * my
        r4 = r2 * r2
        R = 1 + d[0] * r2 + d[1] * r4 + d[2] * r4 * r2 + d[3] * r4 * r4 + d[4] * r4 * r4 * r2
        a = d[5] + d[7] * r2
        b = d[6] + d[8] * r2
        xd = mx * R + (r2 + 2 * mx * mx) * a + 2 * mx * my * b + d[9] * r2 + d[11] * r4
        yd = my * R + (r2 + 2 * my * my) * b + 2 * mx * my * a + d[10] * r2 + d[12] * r4
        u = (self.fx * xd + self.cx) * self.scale
        v = (self.fy * yd + self.cy) * self.scale
        theta = np.arccos(np.clip(z, -1, 1))
        return u, v, theta

    def _distort(self, mx, my):
        d = self.d
        r2 = mx * mx + my * my
        r4 = r2 * r2
        R = 1 + d[0] * r2 + d[1] * r4 + d[2] * r4 * r2 + d[3] * r4 * r4 + d[4] * r4 * r4 * r2
        a = d[5] + d[7] * r2
        b = d[6] + d[8] * r2
        xd = mx * R + (r2 + 2 * mx * mx) * a + 2 * mx * my * b + d[9] * r2 + d[11] * r4
        yd = my * R + (r2 + 2 * my * my) * b + 2 * mx * my * a + d[10] * r2 + d[12] * r4
        return xd, yd

    def unproject_cam(self, u, v, iters=8):
        """Video pixels -> unit rays in camera coordinates (distortion inverted with Newton's method)."""
        xd = (u / self.scale - self.cx) / self.fx
        yd = (v / self.scale - self.cy) / self.fy
        mx, my = xd.copy(), yd.copy()
        # Initial value: roughly solve only the radial polynomial in one dimension
        for _ in range(iters):
            fx_, fy_ = self._distort(mx, my)
            e = 1e-6
            ax, ay = self._distort(mx + e, my)
            bx, by = self._distort(mx, my + e)
            j11, j21 = (ax - fx_) / e, (ay - fy_) / e
            j12, j22 = (bx - fx_) / e, (by - fy_) / e
            rx, ry = xd - fx_, yd - fy_
            det = j11 * j22 - j12 * j21
            mx = mx + (j22 * rx - j12 * ry) / det
            my = my + (-j21 * rx + j11 * ry) / det
        rho2 = mx * mx + my * my
        alpha = (self.xi + np.sqrt(np.maximum(1 + (1 - self.xi ** 2) * rho2, 0))) / (rho2 + 1)
        c = np.stack([mx * alpha, my * alpha, alpha - self.xi], -1)
        return c / np.linalg.norm(c, axis=-1, keepdims=True)

    def project_cam(self, c):
        """Rays in camera coordinates -> video pixels."""
        c = c / np.linalg.norm(c, axis=-1, keepdims=True)
        den = c[..., 2] + self.xi
        xd, yd = self._distort(c[..., 0] / den, c[..., 1] / den)
        return (self.fx * xd + self.cx) * self.scale, (self.fy * yd + self.cy) * self.scale


def make_rig(insv, picture_w=3840):
    cal = insv.calibration()
    return [Lens(c, i, len(cal), picture_w) for i, c in enumerate(cal)]


def equirect_rays(w, h):
    """Rays in rig coordinates for each pixel of the equirectangular image. Center = front (+z), up = -y."""
    lon = (np.arange(w) + 0.5) / w * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(h) + 0.5) / h * np.pi
    lon, lat = np.meshgrid(lon, lat)
    return np.stack([np.cos(lat) * np.sin(lon), -np.sin(lat), np.cos(lat) * np.cos(lon)], -1)


def stitch_maps(lenses, rays, blend_deg=6.0):
    """Return the remap maps and blend weights for each lens."""
    maps = []
    thetas = []
    for L in lenses:
        u, v, th = L.project(rays)
        maps.append((u.astype(np.float32), v.astype(np.float32)))
        thetas.append(th)
    # Crossfade near the seam by the difference of the angle from the optical axis
    diff = np.degrees(thetas[1] - thetas[0])  # positive means the lens 0 side
    w0 = np.clip(0.5 + diff / blend_deg, 0, 1).astype(np.float32)
    return maps, w0


def render(images, maps, w0):
    import cv2
    out = None
    for i, (img, (mu, mv)) in enumerate(zip(images, maps)):
        s = cv2.remap(img, mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        w = w0 if i == 0 else 1 - w0
        if s.ndim == 3:
            w = w[..., None]
        out = s * w if out is None else out + s * w
    return out
