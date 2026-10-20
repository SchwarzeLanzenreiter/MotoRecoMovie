// 自車の継ぎ目の型を、動画の区間ごとに作る（core/bodymap.ts）。
// キーフレームを専用のデコーダーで読み、両レンズの帯の画像を GPU で作って、AI の処理は bodymap.worker.ts に任せる。
// 作った型は動画の横の .motorecomovie-body.bin に保存し、次に開いたときはそれを読む
import { BAND_STEP, BAND_W, decodeBodyTrack, encodeBodyTrack, type BodyTrack } from '../core/bodymap'
import { TrackDecoder } from './decoder'
import { GlReframer } from '../render/gl-reframe'
import type { Session } from './session'
import type { BodyInitRequest, BodyWindowRequest, BodyWindowResult, InpaintKind } from './bodymap.worker'
import { t } from '../i18n'

/** 区間の長さ [s]。カメラの台がゆっくり回る動画（1 分に 1〜3°）でも、区間の中では止まっているとみなせる長さ */
export const BODY_WINDOW_SEC = 30

export const bodyPathFor = (insv: string): string => insv + '.motorecomovie-body.bin'

/** 型が今の動画・レンズの補正（継ぎ目の合わせ込み）のものかを確かめる鍵 */
export function bodyKey(session: Session): string {
  const L = session.rig[1]
  return [session.file.size, session.frameCount, BAND_W, BAND_STEP, Array.from(L.camFromRig, (v) => v.toFixed(5)).join(','), (L.edge ?? 0).toFixed(5)].join('|')
}

/** モデルのファイルを読む（アプリとして開いたとき = file: はファイルとして、開発用のサーバーからは fetch で） */
async function loadModel(name: string): Promise<Uint8Array> {
  const url = new URL(`./models/${name}`, document.baseURI)
  if (url.protocol === 'file:') {
    const path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')
    const { id, size } = await window.api.open(path, 'r')
    try {
      return await window.api.read(id, 0, size)
    } finally {
      await window.api.close(id)
    }
  }
  return new Uint8Array(await (await fetch(url)).arrayBuffer())
}

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { ok: (v: unknown) => void; ng: (e: Error) => void }>()
let initDone: Promise<string> | null = null
let initKind: InpaintKind | null = null

function call<T>(req: BodyInitRequest | BodyWindowRequest | { kind: 'reset' }, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./bodymap.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      if (e.data.ok) w.ok(e.data.result)
      else w.ng(new Error(e.data.error))
    }
  }
  const id = nextId++
  return new Promise<T>((ok, ng) => {
    waiting.set(id, { ok: ok as (v: unknown) => void, ng })
    worker!.postMessage({ id, req }, transfer)
  })
}

/** AI のモデルを読み込む（1 回だけ。補完のモデルを変えたら読み直す） */
function init(kind: InpaintKind): Promise<string> {
  if (initDone && initKind === kind) return initDone
  initKind = kind
  initDone = (async () => {
    const flow = await loadModel('neuflow_mixed.onnx')
    const inpaint = await loadModel(kind === 'migan' ? 'migan_pipeline_v2.onnx' : 'lama_fp32.onnx')
    const r = await call<{ provider: string }>({ kind: 'init', flow, inpaint, inpaintKind: kind }, [flow.buffer, inpaint.buffer])
    return r.provider
  })()
  initDone.catch(() => (initDone = null))
  return initDone
}

export interface BodyBuildOptions {
  /** 作る範囲 [s]（省略で動画全体） */
  from?: number
  to?: number
  windowSec?: number
  inpaint?: InpaintKind
  /** 確認用: この矩形（帯の画素）の自車の部分を穴にする */
  forceHole?: number[] | null
  /** 中止の合図 */
  signal?: { aborted: boolean }
}

/**
 * 区間ごとに自車の継ぎ目の型を作る。onProgress は 0〜1 の進み具合と表示の文
 */
export async function buildBodyTrack(session: Session, opts: BodyBuildOptions = {}, onProgress?: (frac: number, msg: string) => void): Promise<BodyTrack> {
  const provider = await init(opts.inpaint ?? 'lama')
  await call({ kind: 'reset' })
  const win = opts.windowSec ?? BODY_WINDOW_SEC
  const dur = session.frameCount / session.fps
  const from = Math.max(0, opts.from ?? 0)
  const to = Math.min(dur, opts.to ?? dur)
  const track = session.decoders[0].track
  const gl = new GlReframer(new OffscreenCanvas(16, 16))
  gl.setLenses(session.rig)
  const decs = session.decoders.map((d) => new TrackDecoder(session.file, d.track))
  const out: BodyTrack = { windows: [], maps: [] }
  const n = Math.max(1, Math.ceil((to - from) / win))
  try {
    for (let k = 0; k < n; k++) {
      if (opts.signal?.aborted) throw new Error(t('中止しました'))
      const t0 = from + k * win
      const t1 = Math.min(to, t0 + win)
      onProgress?.(k / n, t('自車の継ぎ目を作っています（{k}/{n}、AI: {p}）', { k: k + 1, n, p: provider === 'webgpu' ? 'GPU' : 'CPU' }))
      // 区間のキーフレーム（多すぎれば間引く）
      const i0 = Math.max(0, Math.floor(t0 * session.fps))
      const i1 = Math.min(session.frameCount, Math.ceil(t1 * session.fps))
      let keys: number[] = []
      for (let i = i0; i < i1; i++) if (track.keyframes[i]) keys.push(i)
      if (keys.length > 9) keys = keys.filter((_, j) => j % Math.ceil(keys.length / 9) === 0)
      if (keys.length < 2) {
        out.windows.push({ t0, t1, map: -1 })
        continue
      }
      const bands0: Uint8Array[] = []
      const bands1: Uint8Array[] = []
      for (const i of keys) {
        const [f0, f1] = await Promise.all([decs[0].get(i), decs[1].get(i)])
        gl.upload([f0, f1])
        f0.close()
        f1.close()
        bands0.push(gl.renderBand(0))
        bands1.push(gl.renderBand(1))
      }
      const r = await call<BodyWindowResult>({ kind: 'window', bands0, bands1, forceHole: opts.forceHole ?? null }, [...bands0, ...bands1].map((b) => b.buffer))
      let idx = -1
      if (r.map) {
        if (r.reused && out.maps.length) idx = out.maps.length - 1
        else {
          out.maps.push(r.map)
          idx = out.maps.length - 1
        }
      }
      out.windows.push({ t0, t1, map: idx })
      console.log(`自車の継ぎ目 ${t0.toFixed(0)}〜${t1.toFixed(0)} 秒: キーフレーム ${keys.length} 枚、${r.reused ? '前の区間と同じ' : r.map ? `型 ${r.map.w} 列` : '自車の部分なし'}、穴 ${r.holes} 画素`, JSON.stringify(r.ms))
    }
  } finally {
    for (const d of decs) d.close()
  }
  onProgress?.(1, '')
  return out
}

/** 保存した型を読む（無い・古い・ほかの動画のものなら null） */
export async function loadBodyTrack(session: Session): Promise<BodyTrack | null> {
  const p = bodyPathFor(session.path)
  if (!(await window.api.exists(p))) return null
  try {
    const { id, size } = await window.api.open(p, 'r')
    let gz: Uint8Array
    try {
      gz = await window.api.read(id, 0, size)
    } finally {
      await window.api.close(id)
    }
    const raw = new Uint8Array(await new Response(new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    return decodeBodyTrack(raw, bodyKey(session))
  } catch (e) {
    console.warn('自車の継ぎ目の型を読めない', e)
    return null
  }
}

/** 型を動画の横に保存する（gzip） */
export async function saveBodyTrack(session: Session, track: BodyTrack): Promise<void> {
  const raw = encodeBodyTrack(track, bodyKey(session))
  const gz = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  await window.api.writeBinary(bodyPathFor(session.path), gz)
}
