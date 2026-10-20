// 画角の自動切り替えの確認。実行: npx tsx test/director.test.ts [<insv> <csv>]
import assert from 'node:assert/strict'
import { DEFAULT_DIRECTOR, DEFAULT_SHOT_VIEWS, mergeDirector, mergeShotViews, generateKeyframes, resolveShots, makeShots, shotPreviewView, SHOT_NAMES, type Marker } from '../src/renderer/src/engine/director'
import { viewAt } from '../src/renderer/src/engine/project'
import type { RidingTrack } from '../src/renderer/src/core/riding'

// ---- 合成データ: 0-10 巡航, 10-14 減速, 14-20 右コーナー(最大30°), 20-23 加速, 23-60 巡航 ----
const rate = 100
const n = 60 * rate
const peak = new Float32Array(n)
for (let i = 14 * rate; i < 20 * rate; i++) peak[i] = Math.min(30, (i - 14 * rate) / 10)
const r: RidingTrack = {
  rate,
  state: new Uint8Array(n),
  weights: [],
  peakLean: peak,
  segments: [
    { state: 'cruise', start: 0, end: 10 },
    { state: 'brake', start: 10, end: 14 },
    { state: 'corner', start: 14, end: 20 },
    { state: 'accel', start: 20, end: 23 },
    { state: 'cruise', start: 23, end: 60 }
  ]
}
const S = DEFAULT_DIRECTOR
const marker: Marker = { id: 'm', t: 40, yaw: -100, pitch: -5, fov: 90, hold: 3 }
const { keyframes } = generateKeyframes([{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }], r, [marker], S, 0, 60)
const at = (t: number) => viewAt(keyframes, t)
assert.equal(at(5).yaw, 0) // 巡航（最初の景色は interval/2=10 秒後なので、10 秒未満の巡航には入らない）
assert.equal(at(12).pitch, 8) // 減速: 少し下を向く
assert.equal(at(12).fov, 98)
assert.equal(at(18).yaw, 18) // 右コーナー: 最大リーン 30° × 0.6
assert.equal(at(21.5).yaw, 0) // 加速: 自分は映さず前方をズームイン
assert.equal(at(21.5).fov, 95)
assert.equal(at(41).yaw, -100) // 注目ポイント
assert.equal(at(35).yaw, 75) // 長い巡航（23秒〜）: 23+10=33 秒から右の景色
assert.equal(at(55).yaw, -75) // 次の景色（53秒〜）は左右交互で左
assert.equal(at(59).yaw, 0) // 景色が終わったら前方へ
// 切り替えは 0.8 秒かけたパン（途中は中間の値）
const mid = at(14.4).yaw
assert.ok(mid > 0 && mid < 18, `切り替え途中のはず: ${mid}`)
// 範囲指定: 範囲外のキーフレームは残る
const existing = [{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }, { t: 50, yaw: 90, pitch: 0, fov: 110, leanRatio: 1 }]
const part = generateKeyframes(existing, r, [], S, 10, 30).keyframes
assert.ok(part.some((k) => k.t === 50 && k.yaw === 90))
assert.equal(viewAt(part, 12).pitch, 8)
// 短いショットは捨てる
const short = resolveShots(makeShots({ ...r, segments: [{ state: 'brake', start: 1, end: 2.1 }] }, [], { ...S, brake: { ...S.brake, minDur: 0 } }, 0, 10), S, 0, 10)
assert.ok(short.every((x) => x.shot.kind !== 'brake'), '1.1秒の減速は捨てる')
// ---- コーナー進入の3パターン: 長いコーナー2本ごとに ② ライダー と ③ 真横 を交互に ----
const corners: RidingTrack['segments'] = []
const pk2 = new Float32Array(n)
const signs = [1, -1, 1, -1]
signs.forEach((sg, k) => {
  const a = 5 + k * 12
  corners.push({ state: 'corner', start: a, end: a + 4 })
  for (let i = a * rate; i < (a + 4) * rate; i++) pk2[i] = sg * 30
})
const r2: RidingTrack = { ...r, peakLean: pk2, segments: corners }
const g2 = generateKeyframes([{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }], r2, [], S, 0, 60).keyframes
const v2 = (t: number) => viewAt(g2, t)
assert.equal(v2(8).yaw, 18) // 1本目（右）: ① 内側を少し
assert.deepEqual([v2(20).yaw, v2(20).fov, v2(20).leanRatio], [180, 165, 0]) // 2本目: ② ライダー（水平固定・広角）
// 以前の設定（視点もプロジェクトに持っていた）を読んでも、視点の項目は捨てて、ほかはそのまま
{
  const old = { ...S, base: { yaw: 5, pitch: 0, fov: 100, leanRatio: 1 }, corner: { on: false, gain: 0.3, max: 20, special: { ...S.corner.special, every: 3, riderFov: 130, sideFov: 140 } } }
  const m = mergeDirector(old as unknown as typeof S) as unknown as Record<string, unknown> & typeof S
  assert.equal(m.base, undefined)
  assert.deepEqual(m.corner, { on: false, special: { ...S.corner.special, every: 3 } })
}
assert.equal(v2(32).yaw, 18) // 3本目（右）: ①
assert.deepEqual([v2(44).yaw, v2(44).fov, v2(44).leanRatio], [-90, 165, 0]) // 4本目（左）: ③ 真横（内側 = 左・水平固定・広角）
// 間隔を 1 にすると毎回特別ショット、② を切ると ③ だけ
const g3 = generateKeyframes([], r2, [], { ...S, corner: { ...S.corner, special: { ...S.corner.special, every: 1, rider: false, sideOut: false } } }, 0, 60).keyframes
assert.deepEqual([viewAt(g3, 8).yaw, viewAt(g3, 20).yaw], [90, -90])
// ③ 内側 と ④ 外側 を交互に（右コーナーの外側 = 左 -90°、左コーナーの外側 = 右 +90°）
const g4 = generateKeyframes([], r2, [], { ...S, corner: { ...S.corner, special: { ...S.corner.special, every: 1, rider: false } } }, 0, 60).keyframes
assert.deepEqual([8, 20, 32, 44].map((t) => viewAt(g4, t).yaw), [90, 90, 90, 90]) // 右③内=+90, 左④外=+90, 右③内=+90, 左④外=+90
assert.deepEqual([8, 20].map((t) => viewAt(g4, t).leanRatio), [0, 0])
const g5 = generateKeyframes([], r2, [], { ...S, corner: { ...S.corner, special: { ...S.corner.special, every: 1, rider: false, side: false } } }, 0, 60).keyframes
assert.deepEqual([8, 20].map((t) => viewAt(g5, t).yaw), [-90, 90]) // ④ だけ: 右コーナーは左、左コーナーは右

// ---- 視点の既定値（ShotViews）: 前方・コーナー入口・側方・後方を変えると、生成するキーフレームの視点が変わる ----
{
  const V = structuredClone(DEFAULT_SHOT_VIEWS)
  V.front = { yaw: 0, pitch: 3, fov: 100, leanRatio: 0.8 }
  V.corner = { gain: 1, max: 20, pitch: -5, fov: 120, leanRatio: 0.5 }
  V.side = { yaw: 70, pitch: 10, fov: 150, leanRatio: 0.2 }
  V.rear = { yaw: 170, pitch: -8, fov: 140, leanRatio: 0.1 }
  const sp = { ...S, corner: { ...S.corner, special: { ...S.corner.special, every: 1, sideOut: false } } }
  const g = generateKeyframes([], r2, [], sp, 0, 60, [], V).keyframes
  const v = (t: number) => viewAt(g, t)
  assert.deepEqual(v(2), { yaw: 0, pitch: 3, fov: 100, leanRatio: 0.8 }, '前方')
  // 長いコーナーの毎回 ② → ③ → ② → ③（every: 1）
  assert.deepEqual(v(8), { ...V.rear }, '1本目: 後方')
  assert.deepEqual(v(20), { yaw: -70, pitch: 10, fov: 150, leanRatio: 0.2 }, '2本目（左）: 側方・内側 = 左')
  // コーナー入口: 短いコーナー（特別ショットの対象外）で、リーン 30° × 100% → 最大 20°
  const short: RidingTrack = { ...r, peakLean: pk2, segments: [{ state: 'corner', start: 5, end: 7 }] }
  const gc = generateKeyframes([], short, [], S, 0, 20, [], V).keyframes
  assert.deepEqual(viewAt(gc, 6.5), { yaw: 20, pitch: -5, fov: 120, leanRatio: 0.5 }, 'コーナー入口')
  // 減速・加速は前方を元にする
  assert.equal(viewAt(generateKeyframes([], r, [], S, 0, 60, [], V).keyframes, 12).fov, 100 + S.brake.fovDelta)
  // キーフレームの印（タイムラインの色分け）: 前方・コーナー入口・側方・後方
  const tags = new Set(g.map((k) => k.tag))
  assert.ok(tags.has('front') && tags.has('side') && tags.has('rear'), [...tags].join(','))
  assert.ok(gc.some((k) => k.tag === 'corner'))
  assert.ok(g.filter((k) => k.tag === 'rear').every((k) => k.yaw === 170))
  // 注目ポイントの視点には印を付けない（手で置いたものと同じ色）
  const gm = generateKeyframes([], null, [marker], S, 0, 60).keyframes
  assert.ok(gm.filter((k) => k.yaw === marker.yaw).every((k) => k.tag === undefined))
  // プレビューの視点（例: リーン 30° の右コーナー）
  assert.deepEqual(shotPreviewView(V, 'corner'), { yaw: 20, pitch: -5, fov: 120, leanRatio: 0.5 })
  assert.equal(shotPreviewView(V, 'side').yaw, 70)
  assert.equal(shotPreviewView(V, 'side', 30, 'out').yaw, -70)
  assert.deepEqual(shotPreviewView(V, 'rear'), V.rear)
  // 覚えていた値: 無い項目・数でない値は既定値で補う
  assert.deepEqual(mergeShotViews(null), DEFAULT_SHOT_VIEWS)
  const m = mergeShotViews({ rear: { fov: 120, pitch: 'x' }, side: null })
  assert.equal(m.rear.fov, 120)
  assert.equal(m.rear.pitch, DEFAULT_SHOT_VIEWS.rear.pitch)
  assert.deepEqual(m.side, DEFAULT_SHOT_VIEWS.side)
  // 既定値は以前の動き（基本の視点 110°、① 0.6・最大 35°、②③④ 165°・水平固定）と同じ
  assert.deepEqual(DEFAULT_SHOT_VIEWS.front, { yaw: 0, pitch: 0, fov: 110, leanRatio: 1 })
}
console.log('director（合成データ）: OK')

// ---- 実データ ----
const [insvPath, csvPath] = process.argv.slice(2)
if (insvPath) {
  const { open } = await import('node:fs/promises')
  const { readFileSync } = await import('node:fs')
  const { InsvTrailer } = await import('../src/renderer/src/core/insv')
  const { estimateMount } = await import('../src/renderer/src/core/motion')
  const { cameraRollRate, fuseLean, parseMotoReco, syncLog } = await import('../src/renderer/src/core/motoreco')
  const { buildTelemetry } = await import('../src/renderer/src/core/telemetry')
  const { detectRiding } = await import('../src/renderer/src/core/riding')
  const fh = await open(insvPath, 'r')
  const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
  const tr = await InsvTrailer.open(reader)
  const imu = await tr.imu()
  const mount = estimateMount(imu).R
  const log = parseMotoReco(readFileSync(csvPath, 'utf-8'))
  const cam = cameraRollRate(imu, mount, tr.meta.firstFrameUs)
  const sync = syncLog(log, cam)
  const lean = fuseLean(log, cam, sync)
  const dur = tr.meta.frameCount / tr.meta.fps
  const tel = buildTelemetry(log, sync, lean, dur, 0.95)
  const rt = detectRiding(tel)
  const t0 = performance.now()
  const g = generateKeyframes([{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }], rt, [], S, 0, dur)
  console.log(`実データ: ${(performance.now() - t0).toFixed(0)}ms でキーフレーム ${g.keyframes.length} 個、ショット ${g.shots.length} 個（1分あたり ${((g.shots.length / dur) * 60).toFixed(1)} 回）`)
  const tot: Record<string, number> = {}
  g.shots.forEach((x, i) => {
    const end = g.shots[i + 1]?.start ?? dur
    tot[x.shot.kind] = (tot[x.shot.kind] ?? 0) + end - x.start
  })
  console.log('ショットの内訳（秒）', Object.entries(tot).map(([k, v]) => `${SHOT_NAMES[k as keyof typeof SHOT_NAMES]} ${v.toFixed(0)}`).join(' / '))
  for (const x of g.shots.filter((x) => x.start > 1380 && x.start < 1415)) console.log(`  ${x.start.toFixed(1)}s ${SHOT_NAMES[x.shot.kind]} yaw ${x.shot.view.yaw.toFixed(0)} pitch ${x.shot.view.pitch} fov ${x.shot.view.fov}`)
  await fh.close()
}
