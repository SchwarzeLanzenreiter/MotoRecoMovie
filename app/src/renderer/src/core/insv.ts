// Insta360 .insv 末尾のトレーラー（メタデータ・IMU・フレーム時刻・レンズキャリブレーション）の読み込み。
// 構造は docs/insv-x6-format.md を参照。
import type { FileReader } from './mp4'

const MAGIC = '8db42d694ccc418790edff439fe026bf'

export type Proto = Map<number, (number | Uint8Array)[]>

/** スキーマなしで protobuf を {field番号: [値...]} に展開（入れ子は Uint8Array のまま） */
export function parseProtobuf(b: Uint8Array): Proto {
  const out: Proto = new Map()
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let i = 0
  const varint = (): number => {
    let r = 0
    let s = 1
    for (;;) {
      const c = b[i++]
      r += (c & 0x7f) * s
      s *= 128
      if (c < 0x80) return r
    }
  }
  while (i < b.length) {
    const k = varint()
    const fn = Math.floor(k / 8)
    const wt = k & 7
    let v: number | Uint8Array
    if (wt === 0) v = varint()
    else if (wt === 1) {
      v = dv.getFloat64(i, true)
      i += 8
    } else if (wt === 5) {
      v = dv.getFloat32(i, true)
      i += 4
    } else if (wt === 2) {
      const n = varint()
      v = b.subarray(i, i + n)
      i += n
    } else throw new Error(`未対応の wire type ${wt}`)
    if (!out.has(fn)) out.set(fn, [])
    out.get(fn)!.push(v)
  }
  return out
}

export interface LensCalib {
  xi: number
  fx: number
  fy: number
  cx: number
  cy: number
  yprDeg: [number, number, number]
  /** レンズの位置 [m]（キャリブレーション空間。継ぎ目の視差の補正に使う） */
  tM: [number, number, number]
  d: number[] // RadtanPro の13項
  width: number // 左右並びの全体幅
  height: number
  lensType: number
}

export interface Calibration {
  version: number
  mirrorLens0: boolean
  lenses: LensCalib[]
}

/** field 111 のキャリブレーション文字列（offset V6）を分解する */
export function parseCalibration(s: string): Calibration {
  const tok = s.split('_')
  const n = parseInt(tok[0])
  const tail = parseInt(tok[tok.length - 1])
  const version = tail >> 16
  const x = (tail >> 8) & 0xff
  if (version !== 6) throw new Error(`未対応のキャリブレーション形式 V${version}（V6のみ対応）`)
  const per = 27
  const lenses: LensCalib[] = []
  for (let i = 0; i < n; i++) {
    const v = tok.slice(1 + i * per, 1 + (i + 1) * per).map(Number)
    lenses.push({
      xi: v[0],
      fx: v[1],
      fy: v[2],
      cx: v[3],
      cy: v[4],
      yprDeg: [v[5], v[6], v[7]],
      tM: [v[8], v[9], v[10]],
      d: v.slice(11, 24),
      width: v[24],
      height: v[25],
      lensType: v[26]
    })
  }
  return { version, mirrorLens0: x === 5, lenses }
}

export interface Imu {
  ts: Float64Array // us
  acc: Float32Array // g, [x,y,z]×N（IMU座標）
  gyro: Float32Array // deg/s
}

export interface InsvMeta {
  model: string
  firmware: string
  fps: number
  frameCount: number
  firstFrameUs: number
  readoutMs: number // ローリングシャッターの読み出し時間
  gyroOffsetMs: number // field 28: フレーム時刻→ジャイロ時間軸の補正
  streamType: number // 4 = トラックがレンズの逆順
  accRangeG: number
  gyroRangeDps: number
  calibration: Calibration
}

export class InsvTrailer {
  records = new Map<number, { size: number; offset: number }>()
  trailerStart = 0
  meta!: InsvMeta
  raw!: Proto

  private constructor(private f: FileReader) {}

  static async open(f: FileReader): Promise<InsvTrailer> {
    const t = new InsvTrailer(f)
    await t.init()
    return t
  }

  private async init(): Promise<void> {
    const f = this.f
    const tail = await f.read(f.size - 72, 72)
    const magic = new TextDecoder().decode(tail.subarray(40))
    if (magic !== MAGIC) throw new Error('Insta360 のトレーラーが見つかりません（.insv ではない可能性があります）')
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    const trailerSize = dv.getUint32(32, true)
    this.trailerStart = f.size - trailerSize
    const h = await f.read(f.size - 72 - 6, 6)
    const idxSize = new DataView(h.buffer, h.byteOffset).getUint32(2, true)
    const idx = await f.read(f.size - 72 - 6 - idxSize, idxSize)
    const iv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength)
    for (let i = 0; i + 10 <= idxSize; i += 10) {
      const id = iv.getUint16(i, true)
      const size = iv.getUint32(i + 2, true)
      const offset = iv.getUint32(i + 6, true)
      if (size) this.records.set(id, { size, offset })
    }
    const m = parseProtobuf(await this.record(0x101))
    this.raw = m
    const str = (k: number): string => new TextDecoder().decode(m.get(k)?.[0] as Uint8Array)
    const num = (k: number, def = 0): number => (m.get(k)?.[0] as number) ?? def
    const range = parseProtobuf(m.get(65)![0] as Uint8Array)
    this.meta = {
      model: str(2),
      firmware: str(3),
      fps: num(20, 50),
      frameCount: num(40),
      firstFrameUs: num(24),
      readoutMs: num(25),
      gyroOffsetMs: num(29) ? num(28) : 0,
      streamType: num(131),
      accRangeG: range.get(1)![0] as number,
      gyroRangeDps: range.get(2)![0] as number,
      calibration: parseCalibration(str(111))
    }
  }

  async record(id: number): Promise<Uint8Array> {
    const r = this.records.get(id)
    if (!r) throw new Error(`レコード 0x${id.toString(16)} がありません`)
    return await this.f.read(this.trailerStart + r.offset, r.size)
  }

  /** IMU（20B/サンプル: u64 ts_us + u16×6 オフセットバイナリ） */
  async imu(): Promise<Imu> {
    const raw = await this.record(0x3)
    const n = Math.floor(raw.length / 20)
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    const ts = new Float64Array(n)
    const acc = new Float32Array(n * 3)
    const gyro = new Float32Array(n * 3)
    const as = this.meta.accRangeG / 32768
    const gs = this.meta.gyroRangeDps / 32768
    for (let i = 0; i < n; i++) {
      const p = i * 20
      ts[i] = Number(dv.getBigUint64(p, true))
      for (let k = 0; k < 3; k++) {
        acc[i * 3 + k] = (dv.getUint16(p + 8 + k * 2, true) - 0x8000) * as
        gyro[i * 3 + k] = (dv.getUint16(p + 14 + k * 2, true) - 0x8000) * gs
      }
    }
    return { ts, acc, gyro }
  }

  /** 各フレームの時刻（us、読み出し中央）。lens 0 → 0x4, lens 1 → 0xc */
  async frameTimes(lens: 0 | 1): Promise<Float64Array> {
    const raw = await this.record(lens === 0 ? 0x4 : 0xc)
    const n = Math.floor(raw.length / 16)
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    const out = new Float64Array(n)
    for (let i = 0; i < n; i++) out[i] = Number(dv.getBigUint64(i * 16, true))
    return out
  }

  /**
   * フレームの時刻をジャイロの時間軸で（us）。最初のフレームを firstFrameUs（field 24）に置き、あとはフレームの時刻の記録（0x4 / 0xc）の間隔のまま。
   * X6 の普通の動画では記録の最初の時刻がそのまま firstFrameUs だが、X5 は記録が 767.5ms（ときに 166.8ms）早く、
   * 分割された 2 本目以降の動画（_002 など）は X5・X6 とも 7〜18 秒ずれている。記録の時刻のままジャイロを引くと、
   * その分だけ前の揺れで補正してしまい、スタビライズで手振れがかえってひどくなっていた（docs/insv-x6-format.md）
   */
  async gyroFrameTimes(lens: 0 | 1): Promise<Float64Array> {
    const out = await this.frameTimes(lens)
    const d = out.length ? this.meta.firstFrameUs - out[0] : 0
    if (d) for (let i = 0; i < out.length; i++) out[i] += d
    return out
  }
}
