"""Insta360 X6 .insv のトレーラー（メタデータ・IMU・フレーム時刻）を読むモジュール。

構造の詳細は docs/insv-x6-format.md を参照。
"""
import os
import struct

import numpy as np

MAGIC = b"8db42d694ccc418790edff439fe026bf"


def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            return r, i


def parse_protobuf(b):
    """スキーマなしで protobuf を {field番号: [値,...]} に展開する（入れ子は bytes のまま）。"""
    out = {}
    i = 0
    while i < len(b):
        k, i = _varint(b, i)
        fn, wt = k >> 3, k & 7
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 1:
            v = struct.unpack("<d", b[i:i + 8])[0]
            i += 8
        elif wt == 5:
            v = struct.unpack("<f", b[i:i + 4])[0]
            i += 4
        elif wt == 2:
            n, i = _varint(b, i)
            v = b[i:i + n]
            i += n
        else:
            raise ValueError(f"未対応の wire type {wt}")
        out.setdefault(fn, []).append(v)
    return out


class Insv:
    def __init__(self, path):
        self.path = path
        self.size = os.path.getsize(path)
        self.f = open(path, "rb")
        self.f.seek(self.size - 72)
        tail = self.f.read(72)
        if tail[40:] != MAGIC:
            raise ValueError("Insta360 のトレーラーが見つかりません")
        trailer_size, self.version = struct.unpack("<II", tail[32:40])
        self.trailer_start = self.size - trailer_size
        # 末尾直前の id=0 レコードが目次（u16 id | u32 size | u32 offset の10バイト×N）
        self.f.seek(self.size - 72 - 6)
        h = self.f.read(6)
        idx_size = struct.unpack("<I", h[2:6])[0]
        self.f.seek(self.size - 72 - 6 - idx_size)
        idx = self.f.read(idx_size)
        self.records = {}
        for i in range(0, idx_size - 9, 10):
            rid, size, off = struct.unpack("<HII", idx[i:i + 10])
            if size:
                self.records[rid] = (size, off)
        self.meta = parse_protobuf(self.read_record(0x101))

    def read_record(self, rid):
        size, off = self.records[rid]
        self.f.seek(self.trailer_start + off)
        return self.f.read(size)

    # ---- メタデータ ----
    @property
    def model(self):
        return self.meta[2][0].decode()

    @property
    def fps(self):
        return self.meta[20][0]

    @property
    def first_frame_us(self):
        """field 24: 先頭フレームの時刻（IMUと同じ時間軸、us）と推定。"""
        return self.meta[24][0]

    @property
    def imu_range(self):
        r = parse_protobuf(self.meta[65][0])
        return r[1][0], r[2][0]  # (acc g, gyro dps)

    def calibration(self):
        """field 111 のレンズキャリブレーション文字列を分解する。"""
        vals = self.meta[111][0].decode().split("_")
        n = int(vals[0])
        per = (len(vals) - 2) // n
        lenses = []
        for k in range(n):
            v = [float(x) for x in vals[1 + k * per: 1 + (k + 1) * per]]
            lenses.append({
                "raw": v,
                "fov_rad": v[0],
                "fx": v[1], "fy": v[2], "cx": v[3], "cy": v[4],
                "rot_deg": v[5:8],
                "t": v[8:11],
                "k": v[11:24],
                "img_w": v[24], "img_h": v[25], "r_lim": v[26],
            })
        return lenses

    # ---- IMU ----
    def imu(self):
        """IMU を返す: (ts_us[N], acc_g[N,3], gyro_dps[N,3])。軸は生のまま。"""
        raw = self.read_record(0x3)
        dt = np.dtype([("ts", "<u8"), ("v", "<u2", 6)])
        a = np.frombuffer(raw, dtype=dt)
        v = a["v"].astype(np.float64) - 0x8000
        acc_g, gyro_dps = self.imu_range
        acc = v[:, 0:3] * (acc_g / 32768.0)
        gyro = v[:, 3:6] * (gyro_dps / 32768.0)
        return a["ts"].astype(np.int64), acc, gyro

    def frame_times(self, lens=0):
        """各フレームの時刻（us）。露出レコード（0x4=レンズ1, 0xc=レンズ2）のtsを使う。"""
        return self.exposure(0x4 if lens == 0 else 0xC)[0]

    def exposure(self, rid=0x4):
        raw = self.read_record(rid)
        a = np.frombuffer(raw, dtype=[("ts", "<u8"), ("v", "<f8")])
        return a["ts"].astype(np.int64), a["v"]


if __name__ == "__main__":
    import sys
    x = Insv(sys.argv[1])
    print(x.model, x.fps, "fps", "IMUレンジ", x.imu_range)
    for rid, (s, o) in sorted(x.records.items()):
        print(f"  id=0x{rid:x} size={s}")
    ts, acc, gyro = x.imu()
    print("IMU", len(ts), "samples", "dt中央値", np.median(np.diff(ts)), "us")
    print("acc ノルム中央値", np.median(np.linalg.norm(acc, axis=1)))
    for lens in (0, 1):
        ft = x.frame_times(lens)
        print(f"frame lens{lens}", len(ft), ft[:3], "dt", np.median(np.diff(ft)))
    for rid in (0x4, 0xC):
        et, ev = x.exposure(rid)
        print(f"exposure 0x{rid:x}", et[:3], ev[:3])
    print("first_frame_us", x.first_frame_us, "IMU先頭", ts[0])
