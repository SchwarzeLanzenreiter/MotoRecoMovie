// 追い越しの演出: 車線をまたいだ区間・追い越しの選び方・車の検出の後処理・ショットを合成データで確かめる。
// 実行: npx tsx test/overtake.test.ts
import assert from 'node:assert/strict'
import { findLaneCrossings, laneSide, ownSide, type LaneSample } from '../src/renderer/src/core/lanes'
import { findOvertakes } from '../src/renderer/src/core/overtake'
import { decodeVehicles, sightingFromBox, DET_SIZE, type VehicleSighting } from '../src/renderer/src/core/vehicles'
import { DEFAULT_DIRECTOR, DEFAULT_SHOT_VIEWS, generateKeyframes } from '../src/renderer/src/engine/director'
import { viewAt } from '../src/renderer/src/engine/project'

// ---- 1 枚の観測からセンターラインの側 ----
assert.equal(laneSide({ yellow: { a: 1.5, b: 0, votes: 30 }, road: null }).side, 1)
assert.equal(laneSide({ yellow: { a: -2, b: 0, votes: 30 }, road: null }).side, -1)
assert.equal(laneSide({ yellow: null, road: { left: 1.5, right: 5, leftSeen: 1, rightSeen: 0 } }).side, 1, '右の路面が広い = 左側通行の自分の車線')
assert.equal(laneSide({ yellow: null, road: { left: 6, right: 6, leftSeen: 0, rightSeen: 0 } }).side, 0, '端が見えなければ分からない')

// ---- 観測の並びから、車線をまたいだ区間 ----
const Y = (t: number, a: number, bias = 0): LaneSample => ({ t, side: a >= 0 ? 1 : -1, yellow: true, a, bias })
const R = (t: number, side: -1 | 0 | 1, bias: number): LaneSample => ({ t, side, yellow: false, bias })
{
  const s: LaneSample[] = []
  for (let t = 0; t < 30; t++) s.push(Y(t, 1.5))
  // 30〜32 秒: 反対の車線（追い越し）
  s.push(Y(30, -2.8, -0.3), Y(31, -3, -0.25), Y(32, -1, -0.1))
  for (let t = 33; t < 50; t++) s.push(Y(t, 1.4))
  // 60 秒: 1 回だけ遠くに黄色（反対の車線の矢印など）→ 使わない
  s.push(Y(50, 1.5), Y(51, -4.8), Y(52, 1.5))
  // 70 秒: 線の真上を通っただけ（|a| < 0.6）→ 使わない
  s.push(Y(70, 0.5), Y(71, -0.3), Y(72, 0.6))
  // 80 秒: 路面の広がりは自分の車線なのに 1 回だけ反対側の黄色 → 使わない
  s.push(R(80, 1, 0.5), Y(81, -1.5, 0.45), R(82, 1, 0.5))
  // 90 秒: 路面の広がりだけで 2 回続けて反対側（白いセンターラインの道）→ 使う
  s.push(R(90, 1, 0.4), R(91, -1, -0.3), R(92, -1, -0.35), R(93, 1, 0.3))
  // 100 秒: 路面の広がりだけで反対側だが偏りが弱い（道路脇の駐車場の舗装で左が広く見えた）→ 使わない
  s.push(R(100, 1, 0.3), R(101, -1, -0.2), R(102, -1, -0.22), R(103, -1, -0.22), R(104, 1, 0.3))
  assert.equal(ownSide(s), 1, '左側通行')
  const c = findLaneCrossings(s)
  assert.deepEqual(
    c.map((x) => [x.start, x.end]),
    [
      [29, 33],
      [90, 93]
    ]
  )
}
// 右側通行（センターラインが左）でも同じように見つける
{
  const s: LaneSample[] = []
  for (let t = 0; t < 20; t++) s.push(Y(t, -1.5))
  s.push(Y(20, 2.5, 0.3), Y(21, 2.8, 0.3))
  for (let t = 22; t < 30; t++) s.push(Y(t, -1.5))
  assert.equal(ownSide(s), -1)
  assert.deepEqual(findLaneCrossings(s).map((x) => [x.start, x.end]), [[19, 22]])
}

// ---- 追い越しの選び方: 追い越す側の真横を車が通った区間だけ ----
{
  const crossings = [
    { start: 29, end: 33 }, // 左の真横を車が通る（追い越し）
    { start: 60, end: 63 }, // 右（反対側）を対向車が通るだけ
    { start: 90, end: 93 } // 自分の車体（いつも左後ろに大きく映る）だけ
  ]
  const v: VehicleSighting[] = [
    { t: 30, az: -16, size: 7, score: 0.8, cls: 2, low: 20 }, // 左前（まだ真横ではない）
    { t: 31, az: -97, size: 33, score: 0.9, cls: 2, low: 20 }, // 左の真横
    { t: 61, az: 95, size: 20, score: 0.9, cls: 2, low: 20 }, // 対向車
    { t: 91, az: -127, size: 31, score: 0.7, cls: 2, low: 44.8 }, // 自分のバイクの一部だけが左後ろに映ったもの（乗用車と判定されることもある。下の縁で切れている）
    { t: 92, az: -127, size: 31, score: 0.7, cls: 2, low: 44.3 },
    { t: 93, az: -126, size: 29, score: 0.6, cls: 2, low: 39.4 } // 切れ方が浅いが、同じ向き（自分の車体の向き）
  ]
  // 自分の車体: 調べた時刻の多くで、左後ろに大きく映る
  for (let t = 0; t < 100; t += 2) v.push({ t, az: -122, size: 50, score: 0.7, cls: 3, low: 20 })
  const o = findOvertakes(crossings, v, 1, 50)
  assert.deepEqual(o.map((x) => [x.start, x.end]), [[29, 33]])
}

// ---- 車の検出の後処理（格子を戻す・重なりを除く） ----
{
  const n = (416 / 8) ** 2 + (416 / 16) ** 2 + (416 / 32) ** 2
  assert.equal(n, 3549)
  const out = new Float32Array(n * 85)
  // 格子 8 画素の (gx, gy) = (10, 20) に車（クラス 2）。中心のずれ 0.5、幅・高さ = exp(2)·8
  const k = 20 * 52 + 10
  out.set([0.5, 0.5, 2, 1.5, 0.9], k * 85)
  out[k * 85 + 5 + 2] = 0.95
  // すぐ隣に同じ車の重なった候補（除かれる）
  out.set([0.6, 0.5, 2, 1.5, 0.8], (k + 1) * 85 - 85 + 85)
  out[(k + 1) * 85 + 5 + 2] = 0.9
  // 人（クラス 0）は数えない
  out.set([0.5, 0.5, 1, 1, 0.9], (k + 5) * 85)
  out[(k + 5) * 85 + 5] = 0.9
  const d = decodeVehicles(out)
  assert.equal(d.length, 1)
  assert.ok(Math.abs(d[0].x - 84) < 1e-6 && Math.abs(d[0].y - 164) < 1e-6 && d[0].cls === 2)
  // 枠の中心が画像の中心なら、その画像の向き（右 90°）
  const s = sightingFromBox({ x: DET_SIZE / 2 - 0.5, y: DET_SIZE / 2 - 0.5, w: 10, h: 20, score: 0.9, cls: 2, low: 20 }, 5, 90, 90)
  assert.ok(Math.abs(s.az - 90) < 1e-6)
}

// ---- ショット: 追い越しの間は上を向く（水平固定）。切り替えはまたぎ始める前に終わる ----
{
  const s = structuredClone(DEFAULT_DIRECTOR)
  const base = DEFAULT_SHOT_VIEWS.front
  s.overtake.on = true
  const g = generateKeyframes([{ t: 0, ...base }], null, [], s, 0, 60, [{ start: 20, end: 25 }])
  const v = viewAt(g.keyframes, 21)
  assert.equal(v.pitch, s.overtake.pitch)
  assert.equal(v.fov, s.overtake.fov)
  assert.equal(v.leanRatio, 0)
  assert.equal(viewAt(g.keyframes, 20).pitch, s.overtake.pitch, 'またぎ始める時刻には切り替え済み')
  assert.equal(viewAt(g.keyframes, 10).pitch, base.pitch)
  // 追い越しの視点のキーフレーム（切り替え完了・戻り始め）だけに印が付く（タイムラインで黄色に描く）
  const tagged = g.keyframes.filter((k) => k.tag === 'overtake')
  assert.equal(tagged.length, 2)
  assert.ok(tagged.every((k) => k.pitch === s.overtake.pitch && k.t >= 19 && k.t <= 26))
  assert.ok(g.keyframes.filter((k) => k.tag !== 'overtake').every((k) => k.pitch === base.pitch && k.tag === 'front'))
  // オフなら何もしない
  s.overtake.on = false
  const g2 = generateKeyframes([{ t: 0, ...base }], null, [], s, 0, 60, [{ start: 20, end: 25 }])
  assert.equal(viewAt(g2.keyframes, 21).pitch, base.pitch)
}
// ---- 低速の追い越しでは切り替えない（区間の平均の車速が overtake.minSpeed より遅いとき） ----
{
  const s = structuredClone(DEFAULT_DIRECTOR)
  const base = DEFAULT_SHOT_VIEWS.front
  s.overtake.on = true
  assert.equal(s.overtake.minSpeed, 40, '既定は 40 km/h')
  const pitchAt = (spans: { start: number; end: number; speed?: number }[]): number => viewAt(generateKeyframes([{ t: 0, ...base }], null, [], s, 0, 60, spans).keyframes, 21).pitch
  assert.equal(pitchAt([{ start: 20, end: 25, speed: 30 }]), base.pitch, '30 km/h の追い越しは切り替えない')
  assert.equal(pitchAt([{ start: 20, end: 25, speed: 60 }]), s.overtake.pitch, '60 km/h は切り替える')
  assert.equal(pitchAt([{ start: 20, end: 25 }]), s.overtake.pitch, '車速が分からなければ切り替える')
  s.overtake.minSpeed = 0
  assert.equal(pitchAt([{ start: 20, end: 25, speed: 30 }]), s.overtake.pitch, '0 ならいつも切り替える')
  // 以前に保存した設定（minSpeed が無い）は既定値で補う
  const { mergeDirector } = await import('../src/renderer/src/engine/director')
  const old = structuredClone(DEFAULT_DIRECTOR) as unknown as { overtake: Record<string, unknown> }
  delete old.overtake.minSpeed
  assert.equal(mergeDirector(old as never).overtake.minSpeed, 40)
}
console.log('overtake.test: OK')
