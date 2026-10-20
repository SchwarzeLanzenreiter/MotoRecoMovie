"""Make a still image of one frame at the given time, with different settings side by side (for visually checking the horizon).

Usage: python snapshot.py <insv> <output name> <time 1> [time 2 ...]
"""
import sys
from dataclasses import replace

import cv2
import numpy as np

from renderer import Reframer, Settings

path, name, times = sys.argv[1], sys.argv[2], [float(t) for t in sys.argv[3:]]
f = np.load("out/lean_fused.npz")
lean = (f["t"], f["L"], float(f["k"]))
base = Settings(out_w=960, out_h=540, hfov=100.0, sigma=(0.6, 0.3, 0.2), lean=lean)
configs = [("follow (ratio 1.0)", replace(base, lean_ratio=1.0)),
           ("level (ratio 0)", replace(base, lean_ratio=0.0)),
           ("level (ratio 0.5)", replace(base, lean_ratio=0.5))]
rows = []
for t in times:
    tiles = []
    for label, st in configs:
        rf = Reframer(path, st, t, 0.02)
        for i, imgs in rf.frames():
            im = rf.render(i, imgs)
        Lv = np.interp(rf.t_video[0], lean[0], lean[1])
        # Draw three thin vertical lines to check verticality
        for x in (240, 480, 720):
            cv2.line(im, (x, 0), (x, 539), (0, 255, 255), 1)
        txt = f"{label}  t={t:.1f}s lean={Lv:+.1f}"
        cv2.putText(im, txt, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 4)
        cv2.putText(im, txt, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
        tiles.append(im)
    rows.append(np.hstack(tiles))
cv2.imwrite(f"out/{name}.jpg", np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])
print("Saved", f"out/{name}.jpg")
