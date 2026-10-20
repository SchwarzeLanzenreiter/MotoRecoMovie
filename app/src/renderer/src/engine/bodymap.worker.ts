// 自車の継ぎ目の型を作る Web Worker（core/bodymap.ts）。重い処理（型の中央値・AI のオプティカルフロー・画像の補完）を
// 画面の操作と別のスレッドで行う。AI は onnxruntime-web で、使えれば GPU（WebGPU）、無ければ CPU（WebAssembly）
import * as ort from 'onnxruntime-web/webgpu'
import {
  BAND_H,
  BAND_W,
  bandStats,
  buildStitch,
  compactStitch,
  findHoles,
  FLOW_H,
  FLOW_W,
  flowInput,
  flowToBand,
  stitchedTemplate,
  type BandStats,
  type BodyMapC
} from '../core/bodymap'

export type InpaintKind = 'lama' | 'migan'

export interface BodyInitRequest {
  kind: 'init'
  flow: Uint8Array
  inpaint: Uint8Array | null
  inpaintKind: InpaintKind
}

export interface BodyWindowRequest {
  kind: 'window'
  /** 区間のキーフレームの帯の画像（RGBA、レンズ0 とレンズ1） */
  bands0: Uint8Array[]
  bands1: Uint8Array[]
  /** 確認用: この矩形 [x0, y0, x1, y1]（帯の画素）の自車の部分を穴にする */
  forceHole?: number[] | null
}

export interface BodyWindowResult {
  map: BodyMapC | null
  /** 前の区間と同じ型を使い回したか */
  reused: boolean
  holes: number
  ms: Record<string, number>
}

let flowSession: ort.InferenceSession | null = null
let inpaintSession: ort.InferenceSession | null = null
let inpaintKind: InpaintKind = 'lama'
let provider = ''
/** 前の区間（使い回しの判定用） */
let prev: { lum: Float32Array; m: Uint8Array; map: BodyMapC | null } | null = null

async function createSession(model: Uint8Array): Promise<ort.InferenceSession> {
  // GPU（WebGPU）が使えなければ CPU（1 スレッド。複数スレッドは SharedArrayBuffer が要る）
  ort.env.wasm.numThreads = 1
  const nav = navigator as Navigator & { gpu?: unknown }
  if (nav.gpu) {
    try {
      const s = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] })
      provider = 'webgpu'
      return s
    } catch (e) {
      console.warn('WebGPU で AI を動かせないので CPU で動かす', e)
    }
  }
  provider = 'wasm'
  return ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
}

async function runFlow(a: Float32Array, b: Float32Array): Promise<Float32Array> {
  const s = flowSession!
  const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', a, [1, 3, FLOW_H, FLOW_W]), [s.inputNames[1]]: new ort.Tensor('float32', b, [1, 3, FLOW_H, FLOW_W]) })
  return r[s.outputNames[0]].data as Float32Array
}

/** 自車の部分がある列を覆うフローのタイルの左端（FLOW_W 列ずつ、少し重ねる） */
function tilesFor(s0: BandStats, s1: BandStats): number[] {
  const col = new Uint8Array(BAND_W)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      if ((s0.valid[i] && s0.stat[i] > 0.5) || (s1.valid[i] && s1.stat[i] > 0.5)) col[x] = 1
    }
  // 自車の部分が無い列のいちばん長い並びを除いた弧を、タイルで覆う（端は 96 列ずつ余分に）
  let bestLen = 0
  let bestStart = 0
  for (let x = 0; x < BAND_W; x++) {
    if (col[x] || !col[(x - 1 + BAND_W) % BAND_W]) continue
    let n = 0
    while (n < BAND_W && !col[(x + n) % BAND_W]) n++
    if (n > bestLen) {
      bestLen = n
      bestStart = x
    }
  }
  if (!col.some((v) => v)) return []
  const arcStart = (bestStart + bestLen) % BAND_W
  const arcLen = BAND_W - bestLen + 192
  const step = FLOW_W - 96
  const n = Math.max(1, Math.ceil((arcLen - FLOW_W) / step) + 1)
  const out: number[] = []
  // 弧の真ん中にそろえる
  const span = (n - 1) * step + FLOW_W
  const start = arcStart - 96 - Math.floor((span - arcLen) / 2)
  for (let k = 0; k < n; k++) out.push((((start + k * step) % BAND_W) + BAND_W) % BAND_W)
  return out
}

/** 穴を AI で埋める（512 四方ずつ。帯の 288 行は上下の端の行を複製して 512 行にする） */
async function inpaint(img: Uint8Array, holes: Uint8Array): Promise<Uint8Array> {
  const out = img.slice()
  const s = inpaintSession
  if (!s) return out
  const S = 512
  const pad = (S - BAND_H) >> 1
  // 穴のある列を 400 列ずつのまとまりにして、真ん中に 512 列の窓を置く
  const col = new Uint8Array(BAND_W)
  for (let y = 0; y < BAND_H; y++) for (let x = 0; x < BAND_W; x++) if (holes[y * BAND_W + x]) col[x] = 1
  const centers: number[] = []
  for (let x = 0; x < BAND_W; ) {
    if (!col[x]) {
      x++
      continue
    }
    let e = x
    while (e < BAND_W && col[e] && e - x < 400) e++
    centers.push((x + e) >> 1)
    x = e
  }
  for (const cx of centers) {
    const x0 = cx - S / 2
    const rgb = new Uint8Array(3 * S * S)
    const keep = new Uint8Array(S * S)
    for (let y = 0; y < S; y++) {
      const by = Math.min(BAND_H - 1, Math.max(0, y - pad))
      for (let x = 0; x < S; x++) {
        const bx = (((x0 + x) % BAND_W) + BAND_W) % BAND_W
        const i = by * BAND_W + bx
        for (let c = 0; c < 3; c++) rgb[c * S * S + y * S + x] = out[i * 3 + c]
        keep[y * S + x] = holes[i] && y - pad === by ? 0 : 1
      }
    }
    let res: Uint8Array
    if (inpaintKind === 'migan') {
      // MI-GAN（前処理・後処理込み）: uint8 の画像と、255 = 残す / 0 = 埋めるのマスク
      const r = await s.run({ image: new ort.Tensor('uint8', rgb, [1, 3, S, S]), mask: new ort.Tensor('uint8', keep.map((v) => v * 255), [1, 1, S, S]) })
      res = r[s.outputNames[0]].data as Uint8Array
    } else {
      // LaMa: 0〜1 の画像と、1 = 埋めるのマスク。出力は 0〜255
      const fimg = new Float32Array(rgb.length)
      for (let i = 0; i < rgb.length; i++) fimg[i] = rgb[i] / 255
      const fm = new Float32Array(S * S)
      for (let i = 0; i < fm.length; i++) fm[i] = keep[i] ? 0 : 1
      const r = await s.run({ image: new ort.Tensor('float32', fimg, [1, 3, S, S]), mask: new ort.Tensor('float32', fm, [1, 1, S, S]) })
      const d = r[s.outputNames[0]].data as Float32Array
      res = new Uint8Array(d.length)
      for (let i = 0; i < d.length; i++) res[i] = Math.max(0, Math.min(255, Math.round(d[i])))
    }
    for (let y = pad; y < pad + BAND_H; y++)
      for (let x = 0; x < S; x++) {
        const bx = (((x0 + x) % BAND_W) + BAND_W) % BAND_W
        const i = (y - pad) * BAND_W + bx
        if (!holes[i]) continue
        for (let c = 0; c < 3; c++) out[i * 3 + c] = res[c * S * S + y * S + x]
      }
  }
  return out
}

/** 前の区間と同じ型を使えるか: 前の区間の自車の部分で、レンズ0 の型の明るさがほぼ同じ（カメラの台が回っていない） */
function sameAsPrev(lum: Float32Array): boolean {
  if (!prev) return false
  let s = 0
  let n = 0
  for (let i = 0; i < lum.length; i++) {
    if (prev.m[i] < 128) continue
    s += Math.abs(lum[i] - prev.lum[i])
    n++
  }
  return n > 1000 && s / n < 0.025
}

async function handleWindow(req: BodyWindowRequest): Promise<BodyWindowResult> {
  const ms: Record<string, number> = {}
  let t = performance.now()
  const lap = (k: string): void => {
    const n = performance.now()
    ms[k] = Math.round(n - t)
    t = n
  }
  const s0 = bandStats(req.bands0)
  const s1 = bandStats(req.bands1)
  lap('型')
  const N = BAND_W * BAND_H
  const lum = new Float32Array(N)
  for (let i = 0; i < N; i++) lum[i] = (s0.med[i * 3] + s0.med[i * 3 + 1] + s0.med[i * 3 + 2]) / (3 * 255)
  if (!req.forceHole && sameAsPrev(lum)) return { map: prev!.map, reused: true, holes: 0, ms }
  const tiles = tilesFor(s0, s1)
  const acc = () => ({ fx: new Float32Array(N), fy: new Float32Array(N), w: new Float32Array(N) })
  const fwd = acc()
  const bwd = acc()
  for (const x0 of tiles) {
    const a = flowInput(s0.med, x0)
    const b = flowInput(s1.med, x0)
    flowToBand(await runFlow(a, b), x0, fwd.fx, fwd.fy, fwd.w)
    flowToBand(await runFlow(b, a), x0, bwd.fx, bwd.fy, bwd.w)
  }
  for (const f of [fwd, bwd])
    for (let i = 0; i < N; i++)
      if (f.w[i] > 0) {
        f.fx[i] /= f.w[i]
        f.fy[i] /= f.w[i]
      }
  lap(`フロー（${tiles.length} 枚、${provider}）`)
  const st = buildStitch(s0, s1, fwd, bwd)
  lap('つなぎ目')
  const holes = findHoles(s0, s1, st, req.forceHole ?? null)
  let nh = 0
  for (let i = 0; i < N; i++) nh += holes[i]
  let fill: Uint8Array | null = null
  if (nh > 0) {
    fill = await inpaint(stitchedTemplate(s0, s1, st), holes)
    lap(`補完（${inpaintKind}）`)
  }
  const map = compactStitch(st, holes, fill)
  const m = new Uint8Array(N)
  for (let i = 0; i < N; i++) m[i] = Math.round(st.m[i] * 255)
  prev = { lum, m, map }
  return { map, reused: false, holes: nh, ms }
}

self.onmessage = async (e: MessageEvent<{ id: number; req: BodyInitRequest | BodyWindowRequest | { kind: 'reset' } }>) => {
  const { id, req } = e.data
  try {
    if (req.kind === 'init') {
      flowSession = await createSession(req.flow)
      inpaintKind = req.inpaintKind
      inpaintSession = req.inpaint ? await createSession(req.inpaint) : null
      self.postMessage({ id, ok: true, result: { provider } })
    } else if (req.kind === 'reset') {
      prev = null
      self.postMessage({ id, ok: true, result: null })
    } else {
      const r = await handleWindow(req)
      self.postMessage({ id, ok: true, result: r })
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
