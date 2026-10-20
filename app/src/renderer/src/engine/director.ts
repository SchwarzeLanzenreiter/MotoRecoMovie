// 画角の自動切り替え: 走行状態と注目ポイントから「ショット」を決め、編集できるキーフレームとして出力する。
//
//   1. 走行状態の区間と注目ポイントから、ショット（時間の範囲と視点）を作る
//   2. 各時刻で優先度のいちばん高いショットを選び、区切りのある並びにする（短すぎるショットは捨てる）
//   3. 区切りごとに「切り替え開始（前の視点）」「切り替え完了（新しい視点）」の2つのキーフレームを置く
//      （キーフレームの補間は ease-in-out なので、切り替えは滑らかなパンになる）
import type { RidingTrack, RidingState } from '../core/riding'
// project.ts とは互いに読み込み合うので、モジュールの初期化時には project.ts の値を使わない
// （viewAt は関数の中でだけ使う）
import { viewAt, type Keyframe } from './project'

type View = Omit<Keyframe, 't'>

export interface Marker {
  id: string
  t: number // 動画時刻 [s]
  yaw: number // 車体座標 [deg]
  pitch: number
  fov: number
  hold: number // 見せる長さ [s]
}

/**
 * 自動生成で切り替える視点の既定値（アプリの設定。このパソコンに覚え、設定メニューの「自動生成の視点」で変える）。
 * 向き（yaw）は車体の正面を 0°、右を正とした角度
 */
export interface ShotViews {
  /** 前方（基本の視点）。減速・加速・停止・巡航の景色は、これを元に少し変える */
  front: View
  /**
   * コーナー入口（① 内側を少し向く）: 前方の向きから、リーン角 × gain（最大 max°）だけ内側を向く。
   * 上下・画角・画面に残すリーンはこの値
   */
  corner: Omit<View, 'yaw'> & { gain: number; max: number }
  /** 側方（③ 真横・内側 / ④ 真横・外側）: yaw は横へ向ける角度（コーナーの内側・外側へ） */
  side: View
  /** 後方（② 自分を映す） */
  rear: View
}
export type ShotViewKind = keyof ShotViews
export const SHOT_VIEW_KINDS: ShotViewKind[] = ['front', 'corner', 'side', 'rear']

export const DEFAULT_SHOT_VIEWS: ShotViews = {
  front: { yaw: 0, pitch: 0, fov: 110, leanRatio: 1 },
  corner: { gain: 0.6, max: 35, pitch: 0, fov: 110, leanRatio: 1 },
  // 真横・後ろは広角・水平固定（画面は水平のまま、バイクが倒れて見える）
  side: { yaw: 90, pitch: 0, fov: 165, leanRatio: 0 },
  rear: { yaw: 180, pitch: 0, fov: 165, leanRatio: 0 }
}

/** 覚えていた値に、無い項目を既定値で補う（数でない値も既定値にする） */
export function mergeShotViews(saved: unknown): ShotViews {
  const d = structuredClone(DEFAULT_SHOT_VIEWS)
  const s = (saved ?? {}) as Partial<Record<ShotViewKind, Record<string, unknown>>>
  for (const k of SHOT_VIEW_KINDS) {
    const dst = d[k] as unknown as Record<string, number>
    for (const f of Object.keys(dst)) {
      const v = s[k]?.[f]
      if (typeof v === 'number' && Number.isFinite(v)) dst[f] = v
    }
  }
  return d
}

/**
 * 設定の画面で見せる視点（プレビュー）。コーナー入口と側方は、例としてリーン角 lean° の右コーナー（内側 = 右）で、
 * side = 'out' なら ④ 外側
 */
export function shotPreviewView(v: ShotViews, kind: ShotViewKind, lean = 30, side: 'in' | 'out' = 'in'): View {
  if (kind === 'corner') return cornerView(v, lean)
  if (kind === 'side') return { ...v.side, yaw: (side === 'in' ? 1 : -1) * Math.sign(lean || 1) * v.side.yaw }
  return { ...v[kind] }
}

/** コーナー入口（①）の視点: リーン角 pk°（右 = 正）から */
function cornerView(v: ShotViews, pk: number): View {
  const c = v.corner
  const yaw = Math.max(-c.max, Math.min(c.max, pk * c.gain))
  return { yaw: v.front.yaw + yaw, pitch: c.pitch, fov: c.fov, leanRatio: c.leanRatio }
}

export interface DirectorSettings {
  transition: number // 切り替えにかける時間 [s]
  minShot: number // これより短いショットは捨てる [s]
  /**
   * コーナー進入の視点。通常は ① 内側を少し向く（リーン角 × gain、最大 max°）。
   * 長いコーナー（special.minDur 秒以上）の special.every 本ごとに、② ライダー（水平固定・広角）、
   * ③ 真横・内側、④ 真横・外側（コーナーの入口と通過後を1画面に）を順に挟む
   */
  corner: {
    on: boolean
    /** side = ③ 真横・内側、sideOut = ④ 真横・外側（視点は ShotViews） */
    special: { rider: boolean; side: boolean; sideOut: boolean; every: number; minDur: number; maxDur: number }
  }
  brake: { on: boolean; minDur: number; pitch: number; fovDelta: number }
  /** 加速: 前方を少しズームイン（画角を fovDelta だけ狭める） */
  accel: { on: boolean; minDur: number; maxDur: number; fovDelta: number }
  cruise: { on: boolean; interval: number; duration: number; yaw: number; fov: number }
  stop: { on: boolean; minDur: number; pitch: number; fov: number }
  /**
   * 追い越し: センターラインをまたいで車を追い越す間（core/overtake.ts）、路面が映らない視点にする
   * （既定は上の空と景色を向く・水平固定）。追い越しの場面は動画を調べて見つける（Session.scanOvertakes）
   */
  overtake: {
    on: boolean
    yaw: number
    pitch: number
    fov: number
    /** これより遅い追い越し（区間の平均の車速 [km/h]）では切り替えない。0 = いつも切り替える。車速が分からなければ切り替える */
    minSpeed: number
  }
}

export const DEFAULT_DIRECTOR: DirectorSettings = {
  transition: 0.8,
  minShot: 1.2,
  corner: { on: true, special: { rider: true, side: true, sideOut: true, every: 2, minDur: 2.5, maxDur: 5 } },
  brake: { on: true, minDur: 1.0, pitch: 8, fovDelta: -12 },
  accel: { on: true, minDur: 1.5, maxDur: 6, fovDelta: -15 },
  cruise: { on: true, interval: 20, duration: 4, yaw: 75, fov: 100 },
  stop: { on: true, minDur: 3, pitch: -12, fov: 130 },
  overtake: { on: false, yaw: 0, pitch: 40, fov: 80, minSpeed: 40 }
}

/** 保存されていた設定に、後から増えた項目を既定値で補う */
export function mergeDirector(saved: Partial<DirectorSettings> | undefined): DirectorSettings {
  const d = structuredClone(DEFAULT_DIRECTOR)
  if (!saved) return d
  // 以前は視点（基本の視点・コーナーの内側への量・真横とライダーの画角）もここに持っていた。今はアプリの設定（ShotViews）なので捨てる
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { base: _base, ...rest } = saved as Partial<DirectorSettings> & { base?: unknown }
  const sp = { ...saved.corner?.special } as Record<string, unknown>
  delete sp.riderFov
  delete sp.sideFov
  return {
    ...d,
    ...rest,
    corner: {
      on: saved.corner?.on ?? d.corner.on,
      special: { ...d.corner.special, ...(sp as Partial<DirectorSettings['corner']['special']>) }
    },
    brake: { ...d.brake, ...saved.brake },
    accel: { on: saved.accel?.on ?? d.accel.on, minDur: d.accel.minDur, maxDur: d.accel.maxDur, fovDelta: saved.accel?.fovDelta ?? d.accel.fovDelta },
    cruise: { ...d.cruise, ...saved.cruise },
    stop: { ...d.stop, ...saved.stop },
    overtake: { ...d.overtake, ...saved.overtake }
  }
}

/** ショットの種類と優先度（大きいほど優先） */
export const SHOT_PRIORITY = { overtake: 7, marker: 6, brake: 5, accel: 4, cornerRider: 3, cornerSide: 3, cornerSideOut: 3, corner: 3, stop: 2, cruise: 1, base: 0 } as const
export type ShotKind = keyof typeof SHOT_PRIORITY

/** ショットの種類 → キーフレームの印（前方・コーナー入口・側方・後方・追い越し。注目ポイントは手で置いたものと同じ扱い） */
export const SHOT_TAG: Record<ShotKind, Keyframe['tag']> = {
  overtake: 'overtake',
  marker: undefined,
  brake: 'front',
  accel: 'front',
  stop: 'front',
  base: 'front',
  corner: 'corner',
  cornerRider: 'rear',
  cornerSide: 'side',
  cornerSideOut: 'side',
  cruise: 'side'
}

export const SHOT_NAMES: Record<ShotKind, string> = {
  overtake: '追い越し', // i18n-ignore
  marker: '注目ポイント', // i18n-ignore
  brake: '減速', // i18n-ignore
  accel: '加速（前方ズーム）', // i18n-ignore
  corner: 'コーナー①内側', // i18n-ignore
  cornerRider: 'コーナー②ライダー', // i18n-ignore
  cornerSide: 'コーナー③真横（内側）', // i18n-ignore
  cornerSideOut: 'コーナー④真横（外側）', // i18n-ignore
  stop: '停止（景色）', // i18n-ignore
  cruise: '巡航（左右の景色）', // i18n-ignore
  base: '前方' // i18n-ignore
}

export interface Shot {
  kind: ShotKind
  start: number
  end: number
  view: View
  /** 時刻によって変わる視点（名所を追いかける）。あれば view は開始時の視点 */
  track?: (t: number) => View
}

/** 時刻 t のリーン角（コーナーの最大リーン角を使う） */
function peakLeanIn(r: RidingTrack, start: number, end: number): number {
  let pk = 0
  const a = Math.max(0, Math.round(start * r.rate))
  const b = Math.min(r.peakLean.length - 1, Math.round(end * r.rate))
  for (let i = a; i <= b; i++) if (Math.abs(r.peakLean[i]) > Math.abs(pk)) pk = r.peakLean[i]
  return pk
}

/** 追い越しの区間（自分の車線にいた最後の時刻〜戻ったのを確かめた時刻） */
export interface OvertakeSpan {
  start: number
  end: number
  /** 区間の平均の車速 [km/h]（車両ログ、無ければ動画の動きからの推定。分からなければ省く） */
  speed?: number
}

/** 走行状態と注目ポイント（と追い越しの区間）からショットの一覧を作る */
export function makeShots(
  r: RidingTrack | null,
  markers: Marker[],
  s: DirectorSettings,
  t0: number,
  t1: number,
  overtakes: OvertakeSpan[] = [],
  v: ShotViews = DEFAULT_SHOT_VIEWS
): Shot[] {
  const shots: Shot[] = []
  const B = v.front
  if (s.overtake.on) {
    // 車線をまたぎ始める前に切り替えが終わるよう、切り替え時間の分だけ早く始める。戻った後も少し保つ
    const o = s.overtake
    for (const x of overtakes) {
      if (x.end < t0 || x.start > t1) continue
      // 低速の追い越し（渋滞の中・市街地など）では切り替えない
      if (o.minSpeed > 0 && x.speed !== undefined && x.speed < o.minSpeed) continue
      shots.push({ kind: 'overtake', start: Math.max(t0, x.start - s.transition), end: x.end + 0.5, view: { yaw: B.yaw + o.yaw, pitch: o.pitch, fov: o.fov, leanRatio: 0 } })
    }
  }
  const seg = (st: RidingState): RidingTrack['segments'] => (r ? r.segments.filter((x) => x.state === st && x.end > t0 && x.start < t1) : [])
  if (s.corner.on) {
    const sp = s.corner.special
    const specials: ShotKind[] = [
      ...(sp.rider ? ['cornerRider' as const] : []),
      ...(sp.side ? ['cornerSide' as const] : []),
      ...(sp.sideOut ? ['cornerSideOut' as const] : [])
    ]
    let longCount = 0
    let specialCount = 0
    for (const x of seg('corner')) {
      const pk = peakLeanIn(r!, x.start, x.end)
      const dir = Math.sign(pk) || 1 // コーナーの内側（右リーン = 右）
      const long = x.end - x.start >= sp.minDur
      if (long) longCount++
      // 長いコーナーの every 本ごとに、②〜④ を順に挟む
      if (long && specials.length && sp.every > 0 && longCount % sp.every === 0) {
        const kind = specials[specialCount++ % specials.length]
        const end = Math.min(x.end, x.start + sp.maxDur)
        if (kind === 'cornerRider') {
          // 自分を映す（後方。既定は後ろ向き・広角・水平固定で、画面は水平のまま、バイクが倒れて見える）
          shots.push({ kind, start: x.start, end, view: { ...v.rear } })
        } else {
          // 真横（側方。③ 内側 / ④ 外側）・広角: コーナーの入口と通過した後を1画面に収める。
          // 横を向くと画面に残す傾きは自然に 0 になる（motion-model.ts）が、既定は切り替えの途中も傾かないよう水平固定
          const side = kind === 'cornerSide' ? dir : -dir
          shots.push({ kind, start: x.start, end, view: { ...v.side, yaw: side * v.side.yaw } })
        }
        continue
      }
      const cv = cornerView(v, pk)
      // 内側を向く量が小さく、上下・画角・傾きも前方と同じなら、前方のまま
      const differs = Math.abs(cv.pitch - B.pitch) >= 0.5 || Math.abs(cv.fov - B.fov) >= 0.5 || Math.abs(cv.leanRatio - B.leanRatio) >= 0.01
      if (Math.abs(cv.yaw - B.yaw) >= 3 || differs) shots.push({ kind: 'corner', start: x.start, end: x.end, view: cv })
    }
  }
  if (s.brake.on) {
    for (const x of seg('brake')) {
      if (x.end - x.start < s.brake.minDur) continue
      shots.push({ kind: 'brake', start: x.start, end: x.end, view: { ...B, pitch: B.pitch + s.brake.pitch, fov: B.fov + s.brake.fovDelta } })
    }
  }
  if (s.accel.on) {
    for (const x of seg('accel')) {
      if (x.end - x.start < s.accel.minDur) continue
      // 自分は映さず、前方の景色を少しズームイン
      shots.push({ kind: 'accel', start: x.start, end: Math.min(x.end, x.start + s.accel.maxDur), view: { ...B, fov: B.fov + s.accel.fovDelta } })
    }
  }
  if (s.stop.on) {
    for (const x of seg('stop')) {
      if (x.end - x.start < s.stop.minDur) continue
      shots.push({ kind: 'stop', start: x.start, end: x.end, view: { ...B, pitch: s.stop.pitch, fov: s.stop.fov } })
    }
  }
  if (s.cruise.on) {
    // 巡航が続く間、interval ごとに左右の景色を交互に挟む
    let side = 1
    for (const x of seg('cruise')) {
      const len = x.end - x.start
      if (len < s.cruise.interval) continue
      for (let a = x.start + s.cruise.interval / 2; a + s.cruise.duration + s.transition <= x.end; a += s.cruise.interval) {
        shots.push({ kind: 'cruise', start: a, end: a + s.cruise.duration, view: { ...B, yaw: B.yaw + side * s.cruise.yaw, fov: s.cruise.fov } })
        side = -side
      }
    }
  }
  for (const m of markers) {
    if (m.t + m.hold < t0 || m.t > t1) continue
    shots.push({ kind: 'marker', start: m.t, end: m.t + m.hold, view: { yaw: m.yaw, pitch: m.pitch, fov: m.fov, leanRatio: B.leanRatio } })
  }
  return shots
}

/** 各時刻で優先度のいちばん高いショットを選び、区切りの並び（start, shot）にする */
export function resolveShots(shots: Shot[], s: DirectorSettings, t0: number, t1: number, v: ShotViews = DEFAULT_SHOT_VIEWS, dt = 0.05): { start: number; shot: Shot }[] {
  const base: Shot = { kind: 'base', start: t0, end: t1, view: v.front }
  const n = Math.max(1, Math.ceil((t1 - t0) / dt))
  const pick: Shot[] = new Array(n).fill(base)
  for (const sh of shots) {
    const a = Math.max(0, Math.floor((sh.start - t0) / dt))
    const b = Math.min(n, Math.ceil((sh.end - t0) / dt))
    for (let i = a; i < b; i++) if (SHOT_PRIORITY[sh.kind] > SHOT_PRIORITY[pick[i].kind]) pick[i] = sh
  }
  // 区切りの並び
  let runs: { start: number; end: number; shot: Shot }[] = []
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1]
    if (last && last.shot === pick[i]) last.end = t0 + (i + 1) * dt
    else runs.push({ start: t0 + i * dt, end: t0 + (i + 1) * dt, shot: pick[i] })
  }
  // 短すぎるショットは捨てる（注目ポイントは残す）。同じ視点が続くものはまとめる
  for (let pass = 0; pass < 3; pass++) {
    const out: typeof runs = []
    for (const r of runs) {
      // 一瞬だけ前方に戻る（例: 特別ショットの後に 0.3 秒だけ前方を挟んで減速へ）のもちらつきなので、前方も対象にする
      const short = r.end - r.start < s.minShot && r.shot.kind !== 'marker'
      const prev = out[out.length - 1]
      if (short && prev) prev.end = r.end
      else if (prev && !prev.shot.track && !r.shot.track && sameView(prev.shot.view, r.shot.view)) prev.end = r.end
      else if (short) out.push({ ...r, shot: base })
      else out.push({ ...r })
    }
    runs = out
  }
  return runs.map((r) => ({ start: r.start, shot: r.shot }))
}

function sameView(a: View, b: View): boolean {
  return Math.abs(a.yaw - b.yaw) < 0.5 && Math.abs(a.pitch - b.pitch) < 0.5 && Math.abs(a.fov - b.fov) < 0.5 && Math.abs(a.leanRatio - b.leanRatio) < 0.01
}

/**
 * キーフレームを生成し、既存のキーフレームの [t0, t1] の部分を置き換える。
 * 範囲の外のキーフレームは残し、範囲の両端で元の視点とつながるようにする。
 */
export function generateKeyframes(
  existing: Keyframe[],
  r: RidingTrack | null,
  markers: Marker[],
  s: DirectorSettings,
  t0: number,
  t1: number,
  overtakes: OvertakeSpan[] = [],
  views: ShotViews = DEFAULT_SHOT_VIEWS
): { keyframes: Keyframe[]; shots: { start: number; shot: Shot }[] } {
  const runs = resolveShots(makeShots(r, markers, s, t0, t1, overtakes, views), s, t0, t1, views)
  const keys: Keyframe[] = []
  const add = (t: number, v: View, linear = false, tag?: Keyframe['tag']): void => {
    if (t < t0 - 1e-6 || t > t1 + 1e-6) return
    const k: Keyframe = { t, ...v, ...(linear && { linear: true }), ...(tag && { tag }) }
    // 同じ時刻のキーフレームは後のもので上書き
    const i = keys.findIndex((x) => Math.abs(x.t - t) < 0.01)
    if (i >= 0) keys[i] = k
    else keys.push(k)
  }
  const viewOf = (run: (typeof runs)[number], t: number): View => (run.shot.track ? run.shot.track(t) : run.shot.view)
  // キーフレームにショットの種類の印を付ける（タイムラインで色分けする）
  const tagOf = (run: (typeof runs)[number]): Keyframe['tag'] => SHOT_TAG[run.shot.kind]
  add(t0, viewOf(runs[0], t0), false, tagOf(runs[0]))
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]
    const cur = runs[i]
    const next = runs[i + 1]
    const end = next ? next.start : t1
    const room = end - cur.start
    const T = Math.min(s.transition, room / 2, (cur.start - prev.start) / 2)
    add(cur.start, viewOf(prev, cur.start), false, tagOf(prev)) // 切り替え開始（直前の視点を保つ）
    if (cur.shot.track) {
      // 名所を追いかける: 0.4 秒ごとのキーフレームを等速でつなぐ
      for (let t = cur.start + T; t < end - 0.2; t += 0.4) add(t, cur.shot.track(t), true)
    } else add(cur.start + T, cur.shot.view, false, tagOf(cur)) // 切り替え完了
  }
  add(t1, viewOf(runs[runs.length - 1], t1), false, tagOf(runs[runs.length - 1]))
  // 範囲外の既存キーフレームを残す。範囲の外側の境目は、既存の視点から生成した視点へつながる
  const outside = existing.filter((k) => k.t < t0 - 0.01 || k.t > t1 + 0.01)
  const before = existing.length ? viewAt(existing, t0) : null
  const merged = [...outside, ...keys].sort((a, b) => a.t - b.t)
  if (before && outside.some((k) => k.t < t0)) {
    // 範囲の直前は元の視点のまま、範囲の先頭で生成した視点へ
    merged.splice(merged.findIndex((k) => k.t >= t0 - 0.01), 0, { t: Math.max(0, t0 - 0.02), ...before })
  }
  return { keyframes: merged, shots: runs }
}
