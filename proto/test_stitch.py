"""1フレームを正距円筒にステッチして確認する。トラックの順番は両方試す。"""
import sys

import cv2
import numpy as np

from insv import Insv
from lens import equirect_rays, make_rig, render, stitch_maps

x = Insv(sys.argv[1])
prefix = sys.argv[2]  # 例: out/f1400
imgs = [cv2.imread(f"{prefix}_lens{i}.png", cv2.IMREAD_UNCHANGED).astype(np.float32) / 65535 for i in (0, 1)]
lenses = make_rig(x)
for L in lenses:
    print("xi", L.xi, "f", L.fx, "c", L.cx, L.cy, "scale", L.scale)
    print("  R_cam_from_rig\n", np.round(L.R_cam_from_rig, 3))
W, H = 3840, 1920
rays = equirect_rays(W, H)
maps, w0 = stitch_maps(lenses, rays)
for name, order in [("normal", (0, 1)), ("reversed", (1, 0))]:
    eq = render([imgs[order[0]], imgs[order[1]]], maps, w0)
    cv2.imwrite(f"{prefix}_eq_{name}.jpg", np.clip(eq * 255, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
    # 継ぎ目（レンズ0側の境界）を拡大して確認できるよう、境界付近を切り出す
print("done")
