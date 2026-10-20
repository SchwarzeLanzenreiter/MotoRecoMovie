// Entry point for the analysis Web Worker
import type { AnalyzeLogRequest, AnalyzeLogResult, ScoreDatRequest, ScoreDatResult, ImuTelemetryRequest } from './analysis.worker'
import type { ImuTelemetry } from '../core/imu-telemetry'
import type { LensModel } from '../core/lens'
import type { SeamFitResult, SeamFrame } from '../core/seamfit'
import { t } from '../i18n'

// Convert errors from the analysis thread and core (both thrown in English) to the UI language.
// For templates with placeholders, extract the {name} parts and pass them to t()
const CORE_ERRORS = [
  'Insta360 trailer not found (this may not be an .insv file)',
  'Unsupported wire type {wt}',
  'Unsupported calibration format V{version} (only V6 is supported)',
  'Record 0x{id} is missing',
  'moov box not found',
  'Not a MotoReco CSV (no time column)',
  'Column {name} is missing',
  'The .ddf has no channels',
  'Cannot read the formula: {src}',
  'Not a MotoReco .dat (size is not a multiple of 16 bytes)'
]
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const CORE_ERROR_RE = CORE_ERRORS.map((tpl) => {
  const names = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  const re = new RegExp('^' + tpl.split(/\{\w+\}/).map(escapeRe).join('(.+?)') + '$')
  return { tpl, names, re }
})

/** Convert core / analysis thread error messages to the UI language (unknown ones are returned as is) */
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
    for (const p of pending.values()) p.reject(new Error(t('Error in analysis thread: {msg}', { msg: e.message })))
    pending.clear()
    worker = null
  }
  return worker
}

export function analyzeLog(req: AnalyzeLogRequest, onProgress?: (m: string) => void): Promise<AnalyzeLogResult> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, progress: onProgress })
    // The IMU is still used on the main thread, so it is copied rather than transferred (the contents of the .dat are transferred)
    getWorker().postMessage({ id, type: 'analyzeLog', req }, req.dat ? [req.dat.buf.buffer] : [])
  })
}

/** Estimate without a vehicle log (from the video IMU) on the analysis thread */
export function imuTelemetryInWorker(req: ImuTelemetryRequest): Promise<ImuTelemetry> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, type: 'imuTelemetry', req })
  })
}

/** Check on the analysis thread whether the .dat is from the same ride as the video (the contents of the .dat are transferred by ownership) */
export function scoreDatInWorker(req: ScoreDatRequest): Promise<ScoreDatResult> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, type: 'scoreDat', req }, [req.buf.buffer])
  })
}

/** Estimate lens seam fitting on the analysis thread (frame pixels are transferred by ownership) */
export function seamFitInWorker(rig: LensModel[], frames: SeamFrame[]): Promise<SeamFitResult> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, type: 'seamFit', req: { rig, frames } }, frames.flatMap((f) => [f.img[0].buffer, f.img[1].buffer]))
  })
}
