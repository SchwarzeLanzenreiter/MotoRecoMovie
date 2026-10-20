"""複数の設定を2×2に並べた比較動画を書き出す（入力の魚眼は1回だけデコードして共有）。

使い方: python compare_grid.py <insv> <開始秒> <秒数> <出力名> [smooth|lean]
  smooth: 平滑化の強さの比較 / lean: ログのリーン角を使ったロール補完と傾きの割合の比較
"""
import sys
import time
from dataclasses import replace

import cv2
import numpy as np

from renderer import Reframer, Settings, open_writer

path, t0, dur, name = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
TW, TH = 960, 540
base = Settings(out_w=TW, out_h=TH, in_size=3840, hfov=110.0)
mode = sys.argv[5] if len(sys.argv) > 5 else "smooth"
if mode == "smooth":
    configs = [
        ("補正なし", "raw", replace(base, sigma=0.0, rs_iters=0)),
        ("σ0.15s", "sigma 0.15s", replace(base, sigma=0.15)),
        ("σ0.25s", "sigma 0.25s", replace(base, sigma=0.25)),
        ("軸別 P0.6/Y0.3/R0.2", "pitch0.6 yaw0.3 roll0.2", replace(base, sigma=(0.6, 0.3, 0.2))),
    ]
else:
    f = np.load("out/lean_fused.npz")
    lean = (f["t"], f["L"], float(f["k"]))
    ax = replace(base, sigma=(0.6, 0.3, 0.2))
    configs = [
        ("軸別のみ", "axis-split only", ax),
        ("軸別+ロール補完", "+ lean log (follow 100%)", replace(ax, lean=lean)),
        ("傾き50%", "lean 50%", replace(ax, lean=lean, lean_ratio=0.5)),
        ("水平固定", "horizon level (0%)", replace(ax, lean=lean, lean_ratio=0.0)),
    ]
rfs = [Reframer(path, c, t0, dur) for _, _, c in configs]
w = open_writer(f"out/{name}.mp4", TW * 2, TH * 2, rfs[0].fps, audio_from=path, t0=rfs[0].f0 / rfs[0].fps, dur=dur)
t = time.time()
for i, imgs in rfs[0].frames():
    tiles = []
    for (_, label, _), rf in zip(configs, rfs):
        im = rf.render(i, imgs)
        cv2.putText(im, label, (12, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 4)
        cv2.putText(im, label, (12, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
        tiles.append(im)
    frame = np.vstack([np.hstack(tiles[:2]), np.hstack(tiles[2:])])
    w.stdin.write(frame.tobytes())
    if i == rfs[0].nf // 2:
        cv2.imwrite(f"out/{name}_mid.jpg", frame)
    if i % 100 == 0:
        print(f"{i}/{rfs[0].nf} {(time.time() - t) / (i + 1):.2f}s/frame", flush=True)
w.stdin.close()
w.wait()
print("完了", round(time.time() - t), "s")
