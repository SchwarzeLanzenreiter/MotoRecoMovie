"""ffmpeg で .insv の各レンズストリームからフレームを読み出す。"""
import subprocess

import numpy as np

# X6 はトラック順が逆（ストリーム1がレンズ0）。継ぎ目誤差の比較で確認済み。
LENS_TO_STREAM = {0: 1, 1: 0}


def read_frames(path, lens, start_frame, count, size, fps=50, every=1, gray=False):
    """lens の start_frame から count 枚（every 枚おき）を size×size の BGR（gray=True ならグレー）uint8 で返す。"""
    ch = 1 if gray else 3
    vf = f"scale={size}:{size}:flags=area"
    if every > 1:
        vf = f"select='not(mod(n\\,{every}))'," + vf
    cmd = [
        "ffmpeg", "-v", "error", "-hwaccel", "cuda",
        "-ss", f"{start_frame / fps:.6f}", "-i", path,
        "-map", f"0:{LENS_TO_STREAM[lens]}", "-vf", vf, "-fps_mode", "passthrough",
        "-frames:v", str(count), "-f", "rawvideo", "-pix_fmt", "gray" if gray else "bgr24", "-",
    ]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (size * size * ch)
    a = np.frombuffer(raw, np.uint8)[: n * size * size * ch]
    return a.reshape(n, size, size) if gray else a.reshape(n, size, size, 3)
