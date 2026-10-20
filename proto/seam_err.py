"""Measure the pixel difference between both lenses in the seam overlap band to determine the track order."""
import sys
import cv2
import numpy as np
from insv import Insv
from lens import equirect_rays, make_rig

x = Insv(sys.argv[1]); prefix = sys.argv[2]
imgs = [cv2.imread(f"{prefix}_lens{i}.png", cv2.IMREAD_UNCHANGED).astype(np.float32) / 65535 for i in (0, 1)]
lenses = make_rig(x)
rays = equirect_rays(1920, 960)
proj = [L.project(rays) for L in lenses]
band = (np.abs(np.degrees(proj[0][2]) - 90) < 3)
for name, order in [("normal", (0, 1)), ("reversed", (1, 0))]:
    s = [cv2.remap(imgs[order[i]], proj[i][0].astype(np.float32), proj[i][1].astype(np.float32), cv2.INTER_LINEAR) for i in (0, 1)]
    g = [cv2.GaussianBlur(cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), (0, 0), 1.5) for a in s]
    err = np.abs(g[0] - g[1])[band]
    print(f"{name}: mean difference in the overlap band {err.mean():.4f}  median {np.median(err):.4f}")
