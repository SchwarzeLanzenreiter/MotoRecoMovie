"""Export RTMDet-Ins tiny (mmdetection, COCO 80 classes) to ONNX for the app (onnxruntime-web).

The graph holds only the network (backbone, neck, head): its outputs are the raw head outputs per level
(class logits, box distances, mask kernels) and the mask feature. Box decoding, NMS and the per-instance dynamic
convolution that makes the masks are done by the app (app/src/renderer/src/core/segment.ts). That keeps the graph
to standard operators that run on WebGPU and avoids the 100 x 640 x 640 mask tensor of the mmdeploy export.

Needs: torch (CPU), mmengine, mmcv-lite 2.1 (no compiled ops), mmdet 3.3.
Usage:
  python export_rtmdet_ins.py <rtmdet-ins_tiny .pth> <out.onnx>
  python export_rtmdet_ins.py <rtmdet-ins_tiny .pth> <out.onnx> --check <image.png> <result.png>
      also runs the ONNX on an image with onnxruntime, decodes it with the reference decoder below, compares the result
      with mmdetection's own post-processing and draws the instances
"""
import sys
import types

import numpy as np
import torch

SIZE = 640
STRIDES = [8, 16, 32]


def stub_mmcv_ops():
    """mmcv-lite has no compiled ops. The network does not use them; only mmdet's post-processing calls batched_nms,
    which is given a plain torch implementation here. Every other name becomes an empty stand-in class"""
    ops = types.ModuleType('mmcv.ops')

    def nms_keep(boxes, scores, iou):
        order = scores.argsort(descending=True)
        keep = []
        while order.numel():
            i = order[0]
            keep.append(int(i))
            if order.numel() == 1:
                break
            rest = order[1:]
            x1 = torch.maximum(boxes[i, 0], boxes[rest, 0])
            y1 = torch.maximum(boxes[i, 1], boxes[rest, 1])
            x2 = torch.minimum(boxes[i, 2], boxes[rest, 2])
            y2 = torch.minimum(boxes[i, 3], boxes[rest, 3])
            inter = (x2 - x1).clamp(min=0) * (y2 - y1).clamp(min=0)
            area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
            o = inter / (area(boxes[i]) + area(boxes[rest]) - inter)
            order = rest[o <= iou]
        return torch.tensor(keep, dtype=torch.long)

    def batched_nms(boxes, scores, idxs, nms_cfg, class_agnostic=False):
        off = boxes.max() + 1 if boxes.numel() else 0
        b = boxes if class_agnostic else boxes + (idxs.to(boxes) * off)[:, None]
        keep = nms_keep(b, scores, nms_cfg.get('iou_threshold', 0.5))
        keep = keep[scores[keep].argsort(descending=True)]
        mx = nms_cfg.get('max_num', -1)
        if mx > 0:
            keep = keep[:mx]
        return torch.cat([boxes[keep], scores[keep][:, None]], -1), keep

    ops.batched_nms = batched_nms

    def missing(name):
        if name.startswith('__'):
            raise AttributeError(name)
        return type(name, (torch.nn.Module,), {})

    ops.__getattr__ = missing
    ops.__path__ = []
    sys.modules['mmcv.ops'] = ops

    # Submodules (from mmcv.ops.roi_align import roi_align, ...) are stand-ins of the same kind
    import importlib.abc
    import importlib.machinery

    class Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
        def find_spec(self, name, path, target=None):
            return importlib.machinery.ModuleSpec(name, self) if name.startswith('mmcv.ops.') else None

        def create_module(self, spec):
            m = types.ModuleType(spec.name)
            m.__getattr__ = missing
            m.batched_nms = batched_nms
            return m

        def exec_module(self, module):
            pass

    sys.meta_path.insert(0, Finder())


def build(ckpt):
    stub_mmcv_ops()
    import os
    import mmdet
    from mmengine.config import Config
    from mmengine.runner import load_checkpoint
    from mmdet.registry import MODELS
    from mmdet.utils import register_all_modules
    register_all_modules()
    cfg = Config.fromfile(os.path.join(os.path.dirname(mmdet.__file__), '.mim', 'configs', 'rtmdet', 'rtmdet-ins_tiny_8xb32-300e_coco.py'))
    model = MODELS.build(cfg.model)
    load_checkpoint(model, ckpt, map_location='cpu')
    model.eval()
    return model


class Raw(torch.nn.Module):
    """Network only: outputs cls0..2 [1,80,h,w], box0..2 [1,4,h,w] (distances l, t, r, b in pixels), kernel0..2 [1,169,h,w], mask_feat [1,8,80,80]"""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        cls, box, ker, feat = self.m.bbox_head(self.m.extract_feat(x))
        return (*cls, *box, *ker, feat)


OUTPUTS = ['cls8', 'cls16', 'cls32', 'box8', 'box16', 'box32', 'kernel8', 'kernel16', 'kernel32', 'mask_feat']


def letterbox(img):
    """RGB image -> model input (BGR, mmdet mean/std, keep-ratio resize to SIZE and pad 114 at the right/bottom); returns the scale"""
    from PIL import Image
    h, w = img.shape[:2]
    s = min(SIZE / w, SIZE / h)
    im = np.asarray(Image.fromarray(img).resize((round(w * s), round(h * s)), Image.BILINEAR)).astype(np.float32)
    pad = np.full((SIZE, SIZE, 3), 114, np.float32)
    pad[: im.shape[0], : im.shape[1]] = im
    bgr = pad[..., ::-1]
    x = (bgr - np.array([103.53, 116.28, 123.675], np.float32)) / np.array([57.375, 57.12, 58.395], np.float32)
    return x.transpose(2, 0, 1)[None].copy(), s


def decode(outs, score_thr=0.3, iou=0.6, max_det=100, nms_pre=1000):
    """Reference decoder (the app's core/segment.ts does the same): boxes [n,4] in input pixels, scores, labels, masks [n,160,160] (stride 4)"""
    cands = []
    for li, st in enumerate(STRIDES):
        cls = 1 / (1 + np.exp(-outs[li][0]))  # 80,h,w
        box = outs[3 + li][0]
        ker = outs[6 + li][0]
        h, w = cls.shape[1:]
        sc = cls.reshape(80, -1).T  # (h*w, 80)
        idx = np.argwhere(sc > score_thr)
        if len(idx) > nms_pre:
            idx = idx[np.argsort(-sc[idx[:, 0], idx[:, 1]])[:nms_pre]]
        for p, c in idx:
            y, x = divmod(p, w)
            px, py = x * st, y * st
            l, t, r, b = box[:, y, x]
            cands.append((sc[p, c], c, [px - l, py - t, px + r, py + b], ker[:, y, x], px, py, st))
    cands.sort(key=lambda z: -z[0])
    kept = []
    for cd in cands:
        ok = True
        for k in kept:
            if k[1] != cd[1]:
                continue
            a, bb = cd[2], k[2]
            ix = max(0, min(a[2], bb[2]) - max(a[0], bb[0])) * max(0, min(a[3], bb[3]) - max(a[1], bb[1]))
            ua = (a[2] - a[0]) * (a[3] - a[1]) + (bb[2] - bb[0]) * (bb[3] - bb[1]) - ix
            if ix / ua > iou:
                ok = False
                break
        if ok:
            kept.append(cd)
            if len(kept) >= max_det:
                break
    feat = outs[9][0]  # 8,80,80
    fh, fw = feat.shape[1:]
    gy, gx = np.mgrid[0:fh, 0:fw]
    masks = []
    for sc_, c, bx, k, px, py, st in kept:
        # Relative coordinates of the mask grid (stride 8) to the instance's point, in units of 8 x its stride
        rel = np.stack([(px - gx * 8) / (st * 8), (py - gy * 8) / (st * 8)])
        x = np.concatenate([rel, feat], 0).reshape(10, -1)
        w0, w1, w2 = k[:80].reshape(8, 10), k[80:144].reshape(8, 8), k[144:152].reshape(1, 8)
        b0, b1, b2 = k[152:160], k[160:168], k[168:169]
        x = np.maximum(w0 @ x + b0[:, None], 0)
        x = np.maximum(w1 @ x + b1[:, None], 0)
        x = (w2 @ x + b2[:, None]).reshape(fh, fw)
        masks.append(1 / (1 + np.exp(-x)))
    return kept, masks


def main():
    ckpt, out = sys.argv[1], sys.argv[2]
    model = build(ckpt)
    raw = Raw(model)
    x = torch.zeros(1, 3, SIZE, SIZE)
    with torch.no_grad():
        torch.onnx.export(raw, x, out, input_names=['input'], output_names=OUTPUTS, opset_version=17, dynamo=False)
    import onnx
    m = onnx.load(out)
    print('exported', out, 'ops:', sorted({n.op_type for n in m.graph.node}))
    if '--check' in sys.argv:
        check(model, out, sys.argv[sys.argv.index('--check') + 1], sys.argv[sys.argv.index('--check') + 2])


def check(model, onnx_path, image, result):
    import onnxruntime as ort
    from PIL import Image, ImageDraw
    img = np.asarray(Image.open(image).convert('RGB'))
    x, s = letterbox(img)
    sess = ort.InferenceSession(onnx_path)
    outs = sess.run(None, {'input': x})
    # The network in PyTorch, built afresh (the export leaves the model in another state)
    with torch.no_grad():
        fresh = Raw(build(sys.argv[1]))(torch.from_numpy(x))
    print('max |onnx - torch| per output:', [round(float(np.abs(a - b.numpy()).max()), 4) for a, b in zip(outs, fresh)])
    ref = [torch.from_numpy(o) for o in outs]
    kept, masks = decode(outs)
    # mmdetection's own post-processing on the same network outputs
    from mmengine.config import ConfigDict
    head = model.bbox_head
    cfg = ConfigDict(nms_pre=1000, min_bbox_size=0, score_thr=0.3, nms=dict(type='nms', iou_threshold=0.6), max_per_img=100, mask_thr_binary=0.5)
    with torch.no_grad():
        res = head.predict_by_feat(*[list(ref[0:3]), list(ref[3:6]), list(ref[6:9])], ref[9], batch_img_metas=[dict(img_shape=(SIZE, SIZE), ori_shape=(SIZE, SIZE), scale_factor=(1.0, 1.0), pad_shape=(SIZE, SIZE))], cfg=cfg, rescale=False)[0]
    print('reference decoder:', len(kept), 'instances; mmdet:', len(res.scores))
    for (sc_, c, bx, *_), m in zip(kept[:10], masks[:10]):
        print(f'  class {c} score {sc_:.3f} box {np.round(bx, 1).tolist()}')
    for i in range(min(10, len(res.scores))):
        print(f'  mmdet class {int(res.labels[i])} score {float(res.scores[i]):.3f} box {np.round(res.bboxes[i].numpy(), 1).tolist()}')
    # Draw: masks upsampled to the input size, then cut back to the image
    over = np.asarray(Image.fromarray((x[0].transpose(1, 2, 0)[..., ::-1] * [58.395, 57.12, 57.375] + [123.675, 116.28, 103.53]).clip(0, 255).astype(np.uint8))).copy()
    rng = np.random.default_rng(0)
    for (sc_, c, bx, *_), m in zip(kept, masks):
        mm = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((SIZE, SIZE), Image.BILINEAR)) > 127
        col = rng.integers(64, 255, 3)
        over[mm] = (over[mm] * 0.4 + col * 0.6).astype(np.uint8)
    im = Image.fromarray(over)
    d = ImageDraw.Draw(im)
    for sc_, c, bx, *_ in kept:
        d.rectangle(bx, outline=(255, 255, 0))
        d.text((bx[0] + 2, bx[1] + 2), f'{c}:{sc_:.2f}', fill=(255, 255, 0))
    im.crop((0, 0, round(img.shape[1] * s), round(img.shape[0] * s))).save(result)
    print('saved', result)


if __name__ == '__main__':
    main()
