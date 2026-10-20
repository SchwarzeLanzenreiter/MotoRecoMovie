// 解析用 Web Worker の呼び出し口
import type { AnalyzeLogRequest, AnalyzeLogResult, ScoreDatRequest, ScoreDatResult, ImuTelemetryRequest } from './analysis.worker'
import type { ImuTelemetry } from '../core/imu-telemetry'
import type { LensModel } from '../core/lens'
import type { SeamFitResult, SeamFrame } from '../core/seamfit'
import { t } from '../i18n'

// 解析スレッドと core のエラー（どちらも日本語のまま投げる）を画面の言語に直す。
// 差し込みのあるものは、型の {名前} の部分を取り出して t() に渡す
const CORE_ERRORS = [
  'Insta360 のトレーラーが見つかりません（.insv ではない可能性があります）',
  '未対応の wire type {wt}',
  '未対応のキャリブレーション形式 V{version}（V6のみ対応）',
  'レコード 0x{id} がありません',
  'moov ボックスが見つかりません',
  'MotoReco の CSV ではありません（time 列が見つかりません）',
  '列 {name} がありません',
  '.ddf にチャンネルがありません',
  '式を読めません: {src}',
  'MotoReco の .dat ではありません（大きさが 16 バイト単位ではありません）'
]
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const CORE_ERROR_RE = CORE_ERRORS.map((tpl) => {
  const names = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  const re = new RegExp('^' + tpl.split(/\{\w+\}/).map(escapeRe).join('(.+?)') + '$')
  return { tpl, names, re }
})

/** core・解析スレッドのエラーメッセージを画面の言語にする（知らないものはそのまま） */
export function localizeError(msg: string): string {
  for (const { tpl, names, re } of CORE_ERROR_RE) {
    const m = re.exec(msg)
    if (m) return t(tpl, Object.fromEntries(names.map((k, i) => [k, m[i + 1]])))
  }
  return t(msg)
}

let worker: Worker | null = null
let nextId = 1
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; progress?: (m: string) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; progress?: string }>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    if (e.data.progress) {
      p.progress?.(t(e.data.progress))
      return
    }
    pending.delete(e.data.id)
    if (e.data.error) p.reject(new Error(localizeError(e.data.error)))
    else p.resolve(e.data.result!)
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(t('解析スレッドでエラー: {msg}', { msg: e.message })))
    pending.clear()
    worker = null
  }
  return worker
}

export function analyzeLog(req: AnalyzeLogRequest, onProgress?: (m: string) => void): Promise<AnalyzeLogResult> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, progress: onProgress })
    // IMU はメインスレッドでも使い続けるので、所有権は渡さずコピーする（.dat の中身は渡す）
    getWorker().postMessage({ id, type: 'analyzeLog', req }, req.dat ? [req.dat.buf.buffer] : [])
  })
}

/** 車両ログが無いときの推定（動画の IMU から）を解析スレッドで求める */
export function imuTelemetryInWorker(req: ImuTelemetryRequest): Promise<ImuTelemetry> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, type: 'imuTelemetry', req })
  })
}

/** .dat が映像と同じ走行のものかを解析スレッドで調べる（.dat の中身は所有権ごと渡す） */
export function scoreDatInWorker(req: ScoreDatRequest): Promise<ScoreDatResult> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, type: 'scoreDat', req }, [req.buf.buffer])
  })
}

/** レンズの継ぎ目の合わせ込みを解析スレッドで推定する（フレームの画素は所有権ごと渡す） */
export function seamFitInWorker(rig: LensModel[], frames: SeamFrame[]): Promise<SeamFitResult> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, type: 'seamFit', req: { rig, frames } }, frames.flatMap((f) => [f.img[0].buffer, f.img[1].buffer]))
  })
}
