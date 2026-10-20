// MotoReco の生ログ（.dat）を、MotoRecoViewer と同じ変換規則（.ddf）でデコードする。
// 組み込みの規則の式と、表にするまでの手順（並べ替え・平滑化・積算・10ms の表）は MotoRecoViewer のソースの移植
// （DecodeRule.cs・Model/ChData.cs・Analysis/ChannelAnalyzer.cs・FormMain.Data.cs・FormMain.Export.cs）。
// 出力は MotoRecoViewer の CSV（"TO Custom v1"）と同じ列名・同じ 10ms 刻みの表で、そのまま BikeLog にできる。docs/motoreco-dat.md を参照

/** .dat の 1 レコード = 16 バイト: u32 秒, u16 ミリ秒, u16 CAN ID（すべてリトルエンディアン）, データ 8 バイト */
export const DAT_RECORD = 16

/** .ddf の 1 行: 名前, CAN ID（16進）, 規則, 色, 最小, 最大, 表示, …, 平滑化, カットオフ [Hz] */
export interface DdfChannel {
  name: string
  id: number
  rule: string
  /** 9 列目: 平滑化（前後両方向の 2 次バターワース）をかけるか */
  filter: boolean
  /** 10 列目: 平滑化のカットオフ周波数 [Hz] */
  cutoffHz: number
}

export function parseDdf(text: string): DdfChannel[] {
  const out: DdfChannel[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const f = line.split(',')
    if (f.length < 3) continue
    const id = parseInt(f[1].trim(), 16)
    if (!Number.isFinite(id)) continue
    const cutoff = parseFloat(f[9] ?? '')
    out.push({ name: f[0].trim(), id, rule: f[2].trim(), filter: (f[8] ?? '').trim().toLowerCase() === 'true', cutoffHz: Number.isFinite(cutoff) ? cutoff : 0 })
  }
  if (!out.length) throw new Error('.ddf にチャンネルがありません')
  return out
}

/** 8 バイトのデータ（d[o]〜d[o+7]）から値を求める関数 */
type Fn = (d: Uint8Array, o: number) => number

// ---- 式の規則（Data1〜8, LoData1〜8, HiData1〜8, 数, + - * / と括弧）----
export function compileFormula(src: string): Fn {
  const toks = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|[-+*/()]/gi) ?? []
  if (toks.join('') !== src.replace(/\s+/g, '')) throw new Error(`式を読めません: ${src}`)
  let p = 0
  const peek = (): string | undefined => toks[p]
  const expr = (): Fn => {
    let a = term()
    while (peek() === '+' || peek() === '-') {
      const op = toks[p++]
      const l = a
      const r = term()
      a = op === '+' ? (d, o) => l(d, o) + r(d, o) : (d, o) => l(d, o) - r(d, o)
    }
    return a
  }
  const term = (): Fn => {
    let a = unary()
    while (peek() === '*' || peek() === '/') {
      const op = toks[p++]
      const l = a
      const r = unary()
      a = op === '*' ? (d, o) => l(d, o) * r(d, o) : (d, o) => l(d, o) / r(d, o)
    }
    return a
  }
  const unary = (): Fn => {
    if (peek() === '-') {
      p++
      const a = unary()
      return (d, o) => -a(d, o)
    }
    if (peek() === '+') p++
    return atom()
  }
  const atom = (): Fn => {
    const tk = toks[p++]
    if (tk === undefined) throw new Error(`式を読めません: ${src}`)
    if (tk === '(') {
      const a = expr()
      if (toks[p++] !== ')') throw new Error(`式を読めません: ${src}`)
      return a
    }
    if (/^[\d.]/.test(tk)) {
      const v = parseFloat(tk)
      return () => v
    }
    const m = /^(lo|hi)?data([1-8])$/i.exec(tk)
    if (!m) throw new Error(`式を読めません: ${src}`)
    const i = Number(m[2]) - 1
    const part = m[1]?.toLowerCase()
    if (part === 'lo') return (d, o) => d[o + i] & 15
    if (part === 'hi') return (d, o) => d[o + i] >> 4
    return (d, o) => d[o + i]
  }
  const f = expr()
  if (p !== toks.length) throw new Error(`式を読めません: ${src}`)
  return f
}

// ---- 組み込みの規則（MotoRecoViewer の DecodeRule.FixedFormula と同じ式）----
const D = (d: Uint8Array, o: number, n: number): number => d[o + n - 1]
const LO = (d: Uint8Array, o: number, n: number): number => d[o + n - 1] & 15
const HI = (d: Uint8Array, o: number, n: number): number => d[o + n - 1] >> 4
const U32 = (d: Uint8Array, o: number, n: number): number => d[o + n - 1] + d[o + n] * 256 + d[o + n + 1] * 65536 + d[o + n + 2] * 16777216
/** 角速度 [deg/s]（無効値は -125） */
const RATE: Fn = (d, o) => (D(d, o, 2) * 125) / 127 + D(d, o, 1) / 255 - 125
/** 加速度 [G] */
const ACCEL: Fn = (d, o) => (D(d, o, 6) + D(d, o, 5) / 255 - 128) / 32
const FR_SPEED1: Fn = (d, o) => (LO(d, o, 5) * 256 + D(d, o, 4)) / 8
const RR_SPEED: Fn = (d, o) => (LO(d, o, 2) * 256 + D(d, o, 1)) / 8
/** ギア: Data6 の上位 4 ビット → 段。それ以外は 0（ニュートラル・不明） */
const GEAR: Record<number, number> = { 1: 1, 4: 2, 7: 3, 8: 4, 11: 5, 13: 6 }
/** 積算・燃費などは後処理で求める（ここでは 0） */
const LATER: Fn = () => 0

const BUILTIN: Record<string, Fn> = {
  BMW_RPM: (d, o) => (LO(d, o, 4) * 256 + D(d, o, 3)) * 5,
  BMW_ThrottelValvePosition: (d, o) => (D(d, o, 6) / 255) * 100,
  BMW_ThrottelPosition: (d, o) => (D(d, o, 8) / 255) * 100,
  BMW_ThrottelGripPosition: (d, o) => (D(d, o, 6) / 255) * 100,
  BMW_FrBrake1: (d, o) => D(d, o, 3) / 4,
  BMW_FrBrake2: (d, o) => D(d, o, 5) / 4,
  BMW_RrBrake1: (d, o) => D(d, o, 4) / 2,
  BMW_RrBrake2: (d, o) => D(d, o, 6) / 2,
  BMW_FrStroke: (d, o) => (LO(d, o, 7) * 256 + D(d, o, 6)) / 5,
  BMW_RrStroke: (d, o) => (D(d, o, 8) * 16 + HI(d, o, 7)) / 3,
  BMW_LeanAngle: (d, o) => (D(d, o, 5) * 90) / 127 - 90,
  BMW_RrSpeed: RR_SPEED,
  BMW_FrSpeed2: (d, o) => (D(d, o, 3) * 16 + HI(d, o, 2)) / 8,
  BMW_FrSpeed1: FR_SPEED1,
  BMW_DistFrSpeed1: LATER,
  BMW_SlipRate: (d, o) => {
    const fr = FR_SPEED1(d, o)
    return fr === 0 ? 0 : (RR_SPEED(d, o) / fr) * 100 - 100
  },
  BMW_Gear: (d, o) => GEAR[HI(d, o, 6)] ?? 0,
  BMW_YawRate: RATE,
  BMW_YAxisG: ACCEL,
  BMW_RollRate: RATE,
  BMW_XAxisG: ACCEL,
  BMW_ZAxisG: ACCEL,
  BMW_AirTemp: (d, o) => D(d, o, 1) * 0.75 - 48,
  BMW_OilTemp: (d, o) => D(d, o, 2) - 25,
  BMW_WaterTemp: (d, o) => D(d, o, 3) * 0.76 - 25,
  BMW_DistCountFr: (d, o) => LO(d, o, 5) * 253 + D(d, o, 4),
  BMW_AccumulatedDistCountFr: LATER,
  BMW_DistCountRr: (d, o) => D(d, o, 3),
  BMW_AccumulatedDistCountRr: LATER,
  BMW_FuelCount: (d, o) => D(d, o, 5) * 256 + D(d, o, 4),
  BMW_AccumulatedFuelCount: LATER,
  BMW_FuelLevel: (d, o) => ((D(d, o, 2) * 256 + D(d, o, 1)) / 562) * 100,
  BMW_OdMeter: (d, o) => D(d, o, 4) * 65536 + D(d, o, 3) * 256 + D(d, o, 2),
  BMW_FuelConsumption: LATER,
  BMW_Range: LATER,
  GPS_Latitude: (d, o) => (U32(d, o, 5) - 90000000) / 1000000,
  GPS_Longitude: (d, o) => (U32(d, o, 1) - 180000000) / 1000000,
  // 単位は m/s の 10⁶ 倍 → km/h
  GPS_Speed: (d, o) => ((U32(d, o, 5) / 1000000) * 3600) / 1000,
  // ロガーは 標高·10000 + 10000000 で記録する（旧仕様の 標高·10⁶ + 10⁹ で記録した .dat は正しく読めない）
  GPS_Altitude: (d, o) => (U32(d, o, 1) - 10000000) / 10000,
  GPS_Distance: LATER
}
// #Data1〜#Data8・#HiData1〜・#LoData1〜（どの ID でも使える）
for (let n = 1; n <= 8; n++) {
  BUILTIN[`Data${n}`] = (d, o) => D(d, o, n)
  BUILTIN[`HiData${n}`] = (d, o) => HI(d, o, n)
  BUILTIN[`LoData${n}`] = (d, o) => LO(d, o, n)
}

/** 組み込みの規則の列の、BMW.ddf での列名（アプリはこの名前で読む） */
const COLUMN: Record<string, string> = {
  BMW_RPM: 'RPM',
  BMW_ThrottelValvePosition: 'ThrottelValvePosition',
  BMW_ThrottelPosition: 'ThrottelPosition',
  BMW_ThrottelGripPosition: 'Throttel Grip Position',
  BMW_FrBrake1: 'FrBrakeDown',
  BMW_FrBrake2: 'FrBrakeUp',
  BMW_RrBrake1: 'RrBrake1',
  BMW_RrBrake2: 'RrBrake2',
  BMW_FrStroke: 'FrStroke',
  BMW_RrStroke: 'RrStroke',
  BMW_LeanAngle: 'LeanAngle',
  BMW_FrSpeed1: 'FrSpeed1',
  BMW_FrSpeed2: 'FrSpeed2',
  BMW_RrSpeed: 'RrSpeed',
  BMW_DistFrSpeed1: 'DistFrSpeed1',
  BMW_SlipRate: 'SlipRate',
  BMW_Gear: 'Gear',
  BMW_XAxisG: 'X_Axis_G',
  BMW_YAxisG: 'Y_Axis_G',
  BMW_ZAxisG: 'Z_Axis_G',
  BMW_RollRate: 'RollRate',
  BMW_YawRate: 'YawRate',
  BMW_AirTemp: 'AirTemp',
  BMW_WaterTemp: 'WaterTemp',
  BMW_OilTemp: 'OilTemp',
  BMW_DistCountFr: 'DistCountFr',
  BMW_AccumulatedDistCountFr: 'AccumulatedDistCountFr',
  BMW_DistCountRr: 'DistCountRr',
  BMW_AccumulatedDistCountRr: 'AccumulatedDistCountRr',
  BMW_FuelCount: 'FuelCounter',
  BMW_AccumulatedFuelCount: 'AccumulatedFuelCounter',
  BMW_FuelLevel: 'FuelLevel',
  BMW_OdMeter: 'OdMeter',
  BMW_FuelConsumption: 'FuelConsumption',
  BMW_Range: 'Range',
  GPS_Latitude: 'lat (deg)',
  GPS_Longitude: 'lon (deg)',
  GPS_Speed: 'Speed',
  GPS_Altitude: 'alt (m)',
  GPS_Distance: 'Distance'
}

/** 同期とリーン角に必ず使うので、.ddf に無くても読むチャンネル */
const REQUIRED: DdfChannel[] = [
  { name: 'LeanAngle', id: 0x10c, rule: '#BMW_LeanAngle', filter: false, cutoffHz: 0 },
  { name: 'RollRate', id: 0x178, rule: '#BMW_RollRate', filter: false, cutoffHz: 0 }
]

/**
 * 組み込みの規則の名前（# の後ろ）。#K51_* は #BMW_* と同じに扱う（古い .ddf の書き方。今の MotoRecoViewer では 0 になる）。
 * 組み込みでない（式）なら undefined、知らない名前なら null
 */
function builtinKey(rule: string): string | null | undefined {
  if (!rule.startsWith('#')) return undefined
  const name = rule.slice(1).replace(/^K51_/i, 'BMW_')
  const key = Object.keys(BUILTIN).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ?? null
}

// ---- レコードの読み出し ----

/** ID ごとのレコード（時刻順）。MotoRecoViewer と同じく、同じ時刻はファイルの順のまま並べる */
interface IdIndex {
  /** 時刻 [s] = 秒 + ミリ秒/1000 */
  time: Float64Array
  /** データ 8 バイトの位置 */
  off: Uint32Array
}
function indexById(buf: Uint8Array, want?: Set<number>): { byId: Map<number, IdIndex>; start: number; end: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const n = Math.floor(buf.byteLength / DAT_RECORD)
  const timeAt = (o: number): number => v.getUint32(o, true) + v.getUint16(o + 4, true) / 1000
  const count = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const id = v.getUint16(i * DAT_RECORD + 6, true)
    if (want && !want.has(id)) continue
    count.set(id, (count.get(id) ?? 0) + 1)
  }
  const byId = new Map<number, IdIndex & { k: number; sorted: boolean }>()
  for (const [id, c] of count) byId.set(id, { time: new Float64Array(c), off: new Uint32Array(c), k: 0, sorted: true })
  for (let i = 0; i < n; i++) {
    const o = i * DAT_RECORD
    const e = byId.get(v.getUint16(o + 6, true))
    if (!e) continue
    const t = timeAt(o)
    if (e.k > 0 && t < e.time[e.k - 1]) e.sorted = false
    e.time[e.k] = t
    e.off[e.k] = o + 8
    e.k++
  }
  // GPS のレコードは少し遅れて書き込まれ、時刻が前後する。安定な並べ替え（同じ時刻はファイルの順）
  for (const e of byId.values()) {
    if (e.sorted) continue
    const order = Array.from(e.time.keys()).sort((a, b) => e.time[a] - e.time[b])
    const time = Float64Array.from(order, (i) => e.time[i])
    const off = Uint32Array.from(order, (i) => e.off[i])
    e.time = time
    e.off = off
  }
  // 表の範囲は、ファイルの最初と最後のレコードの時刻（MotoRecoViewer の startTime・endTime）
  return { byId, start: n ? timeAt(0) : 0, end: n ? timeAt((n - 1) * DAT_RECORD) : 0 }
}

/** 時刻 x の左側（x 以下で最も新しい）レコードの番号。MotoRecoViewer の ChData.FindLeftIndex と同じ（範囲の外の扱いも） */
function findLeftIndex(time: Float64Array, x: number): number {
  const n = time.length
  if (n < 3) return 0
  let first = 0
  let last = n - 1
  let mid = 0
  do {
    mid = first + Math.floor((last - first) / 2)
    if (mid === n - 1) return mid
    if (time[mid] <= x && x < time[mid + 1]) return mid
    if (x > time[mid]) first = mid + 1
    else last = mid - 1
  } while (first <= last)
  return mid
}

/**
 * 2 次バターワースの前後両方向の平滑化。MotoRecoViewer の ChData.Butterworth の移植
 * （両端は 2 点ずつ端の値で延ばす。最後の 1 点は平滑化しない）。dt はサンプルの間隔 [s]
 */
export function butterworthFiltfilt(x: Float64Array, dt: number, cutoffHz: number): Float64Array {
  const out = x.slice()
  if (cutoffHz === 0 || x.length === 0) return out
  const fs = 1 / dt
  const dF2 = x.length - 1
  const dat2 = new Float64Array(dF2 + 4)
  for (let r = 0; r < dF2; r++) dat2[2 + r] = x[r]
  dat2[1] = dat2[0] = x[0]
  dat2[dF2 + 3] = dat2[dF2 + 2] = x[dF2]
  const pi = 3.14159265358979
  const wc = Math.tan((cutoffHz * pi) / fs)
  const k1 = 1.414213562 * wc
  const k2 = wc * wc
  const a = k2 / (1 + k1 + k2)
  const b = 2 * a
  const c = a
  const k3 = b / k2
  const d = -2 * a + k3
  const e = 1 - 2 * a - k3
  const y = new Float64Array(dF2 + 4)
  y[1] = y[0] = x[0]
  for (let s = 2; s < dF2 + 2; s++) y[s] = a * dat2[s] + b * dat2[s - 1] + c * dat2[s - 2] + d * y[s - 1] + e * y[s - 2]
  y[dF2 + 3] = y[dF2 + 2] = y[dF2 + 1]
  const z = new Float64Array(dF2 + 2)
  z[dF2] = y[dF2 + 2]
  z[dF2 + 1] = y[dF2 + 3]
  for (let t = -dF2 + 1; t <= 0; t++) z[-t] = a * y[-t + 2] + b * y[-t + 3] + c * y[-t + 4] + d * z[-t + 1] + e * z[-t + 2]
  for (let p = 0; p < dF2; p++) out[p] = z[p]
  return out
}

/** サンプルの間隔 [s]: 先頭 100 個の平均（MotoRecoViewer の ChData.FilterData と同じ） */
function sampleInterval(time: Float64Array): number {
  const j = Math.min(time.length, 100)
  let sum = 0
  let i = 0
  for (; i < j - 1; i++) sum += time[i + 1] - time[i]
  return sum / i
}

/** 1 チャンネルのレコードの列（時刻順） */
interface Channel {
  def: DdfChannel
  key: string | null | undefined
  time: Float64Array
  value: Float64Array
}

// ---- 積算・燃費・走行可能距離（MotoRecoViewer の ChannelAnalyzer と同じ。デコードした値から後で求める）----
function calcDerived(chs: Channel[]): void {
  // 規則で引く（同じ規則が複数あれば最初のもの）
  const by = (key: string): Channel | undefined => chs.find((c) => c.key === key)
  /** 速度 [km/h] を、レコードごとに「その速度 × 前のレコードからの時間」で積分 [km] */
  const integrate = (speedKey: string, distKey: string): void => {
    const s = by(speedKey)
    const dist = by(distKey)
    if (!s || !dist) return
    const n = Math.min(s.value.length, dist.value.length)
    dist.value[0] = 0
    for (let i = 1; i < n; i++) dist.value[i] = dist.value[i - 1] + (s.value[i] / 3600) * (s.time[i] - s.time[i - 1])
  }
  /** カウンタの増分を積算する。1 周したとき（増分が wrapBelow 未満）だけ wrap を足し、それ以外の減少（エンジン停止など）は 0 */
  const accumulate = (countKey: string, accKey: string, wrapBelow: number, wrap: number, scale: number): void => {
    const cnt = by(countKey)
    const acc = by(accKey)
    if (!cnt || !acc) return
    const n = Math.min(cnt.value.length, acc.value.length)
    let total = 0
    acc.value[0] = 0
    for (let i = 1; i < n; i++) {
      let d = cnt.value[i] - cnt.value[i - 1]
      if (d < 0) d = d < wrapBelow ? d + wrap : 0
      total += d
      acc.value[i] = total * scale
    }
  }
  integrate('GPS_Speed', 'GPS_Distance')
  integrate('BMW_FrSpeed1', 'BMW_DistFrSpeed1')
  // 前輪の距離カウンタは最大 3951、×0.000255 で前輪速の積分と同じ距離 [km] になる
  accumulate('BMW_DistCountFr', 'BMW_AccumulatedDistCountFr', -3900, 3951, 0.000255)
  // 後輪の距離カウンタは最大 255、×0.004 でおおよその距離 [km]（加速中は後輪が滑るので少し長くなる）
  accumulate('BMW_DistCountRr', 'BMW_AccumulatedDistCountRr', -250, 255, 0.004)
  // 燃料カウンタは 16 ビット、÷10⁶ で消費燃料 [L]
  accumulate('BMW_FuelCount', 'BMW_AccumulatedFuelCount', -65000, 65536, 1 / 1000000)
  // 燃費 [km/L] = 積算距離（前輪のカウンタ）/ 消費燃料。燃料カウンタのレコードの時刻ごと
  const fuel = by('BMW_AccumulatedFuelCount')
  const dist = by('BMW_AccumulatedDistCountFr')
  const cons = by('BMW_FuelConsumption')
  if (fuel && dist && cons) {
    const n = Math.min(cons.value.length, fuel.value.length)
    for (let i = 0; i < n; i++) {
      const f = fuel.value[i]
      const km = dist.value[findLeftIndex(dist.time, fuel.time[i])]
      cons.value[i] = f !== 0 ? km / f : 0
    }
  }
  // 走行可能距離 [km] = タンク容量 30L × 燃料残量 [%] × 燃費
  const level = by('BMW_FuelLevel')
  const range = by('BMW_Range')
  if (cons && level && range) {
    const n = Math.min(range.value.length, cons.value.length)
    for (let i = 0; i < n; i++) {
      const fc = cons.value[i]
      const lv = level.value[findLeftIndex(level.time, cons.time[i])]
      range.value[i] = fc !== 0 ? 30 * (lv / 100) * fc : 0
    }
  }
}

export interface DatTable {
  /** 秒（10ms 刻み。ログの最初のレコードの時刻から） */
  t: Float64Array
  columns: Map<string, Float64Array>
  /** .ddf にあったが、知らない組み込みの規則（列を作らない） */
  unsupported: string[]
}

/**
 * .dat を .ddf の規則でデコードし、MotoRecoViewer の CSV 書き出しと同じ表にする。
 * 手順も MotoRecoViewer と同じ: レコードごとに値を求める → ID ごとに時刻順に並べる → 平滑化（レコードの列に）→
 * 積算などの後処理 → 最初のレコードの時刻から 0.01 秒ずつ足した時刻ごとに、その時刻以下で最新のレコードの値
 */
function decodeTable(buf: Uint8Array, ddf: DdfChannel[], addRequired: boolean): DatTable {
  if (buf.byteLength < DAT_RECORD || buf.byteLength % DAT_RECORD !== 0) throw new Error('MotoReco の .dat ではありません（大きさが 16 バイト単位ではありません）')
  const defs = [...ddf]
  if (addRequired) for (const req of REQUIRED) if (!defs.some((c) => c.name === req.name || builtinKey(c.rule) === builtinKey(req.rule))) defs.push(req)
  const unsupported: string[] = []
  const { byId, start, end } = indexById(buf, new Set(defs.map((c) => c.id)))
  const chs: Channel[] = []
  for (const def of defs) {
    const key = builtinKey(def.rule)
    if (key === null) {
      unsupported.push(`${def.name}（${def.rule}）`)
      continue
    }
    const idx = byId.get(def.id)
    if (!idx) continue // データの来ない ID の列は作らない（MotoRecoViewer と同じ）
    const fn = key ? BUILTIN[key] : compileFormula(def.rule)
    const value = new Float64Array(idx.time.length)
    for (let i = 0; i < value.length; i++) value[i] = fn(buf, idx.off[i])
    chs.push({ def, key, time: idx.time, value })
  }
  calcDerived(chs)
  // 10ms ごとの表。時刻は 0.01 を足し続ける（浮動小数の誤差も含めて MotoRecoViewer と同じ行・同じ値になる）
  const stamps: number[] = []
  for (let ts = start; ts < end; ts += 0.01) stamps.push(ts)
  const columns = new Map<string, Float64Array>()
  const canonical = new Map<string, Float64Array>()
  for (const c of chs) {
    // 平滑化はレコードの列にかける（積算の列は積算した後の値に）
    const v = c.def.filter ? butterworthFiltfilt(c.value, sampleInterval(c.time), c.def.cutoffHz) : c.value
    const col = new Float64Array(stamps.length)
    for (let r = 0; r < stamps.length; r++) col[r] = v[findLeftIndex(c.time, stamps[r])]
    let name = c.def.name
    for (let k = 2; columns.has(name); k++) name = `${c.def.name} (${k})`
    columns.set(name, col)
    const cn = c.key ? COLUMN[c.key] : undefined
    if (cn && !canonical.has(cn)) canonical.set(cn, col)
  }
  // 組み込みの規則の列は、.ddf での名前が違っても BMW.ddf の列名で引けるようにする
  for (const [name, v] of canonical) if (!columns.has(name)) columns.set(name, v)
  // CSV の time (ms) は「時刻×1000 の整数」なので、秒もそれにそろえる
  const t = Float64Array.from(stamps, (s) => Math.round(s * 1000) / 1000)
  return { t, columns, unsupported }
}

/** .dat を .ddf の規則でデコードし、CSV と同じ表にする（同期に使う LeanAngle・RollRate は .ddf に無くても読む） */
export function decodeDat(buf: Uint8Array, ddf: DdfChannel[]): DatTable {
  return decodeTable(buf, ddf, true)
}

/** ファイル名（YYYYMMDD_HHMMSS.dat）から記録開始の時刻（ローカル時刻の ms）。読めなければ null */
export function datStartFromName(name: string): number | null {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

/** ファイルの末尾のレコード（数件）から、記録の長さ [s] */
export function datDurationFromTail(tail: Uint8Array): number {
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let s = 0
  for (let o = tail.byteLength - DAT_RECORD; o >= 0; o -= DAT_RECORD) s = Math.max(s, v.getUint32(o, true) + v.getUint16(o + 4, true) / 1000)
  return s
}

/** 映像との照合用に、ロールレートだけを 10ms 刻みで取り出す（無効値は NaN） */
export function datRollRate(buf: Uint8Array, ddf: DdfChannel[] | null): { t: Float64Array; rollRate: Float64Array } {
  const def = ddf?.find((x) => builtinKey(x.rule) === 'BMW_RollRate') ?? REQUIRED[1]
  const table = decodeTable(buf, [{ ...def, name: 'RollRate', filter: false }], false)
  const v = table.columns.get('RollRate') ?? new Float64Array(table.t.length).fill(-125)
  return { t: table.t, rollRate: v.map((x) => (x <= -124.9 ? NaN : x)) }
}
