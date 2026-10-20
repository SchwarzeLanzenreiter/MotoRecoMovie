// 継ぎ目の距離の選び方（動的なつなぎ合わせ）を合成データで確認する。
// 実行: npx tsx test/seamdepth.test.ts
import assert from 'node:assert/strict'
import { blurSeamQ, chooseSeamCut, chooseSeamDepth, CUT_OFFS, groundPrior } from '../src/renderer/src/render/seamdepth'

const cand = [0, 0.12, 0.25, 0.4, 0.55, 0.75, 1.0, 1.3, 1.7, 2.2]
const bins = 32
const K = cand.length
// 一致度: ビン 10〜14 は 1.3m（候補 7）、それ以外は無限遠（候補 0）で一致。ビン 20〜23 は模様がない
const cost = new Float32Array(K * bins)
const texture = new Float32Array(bins).fill(0.5)
for (let b = 0; b < bins; b++) {
  const best = b >= 10 && b <= 14 ? 7 : 0
  for (let k = 0; k < K; k++) cost[k * bins + b] = Math.min(1, 0.02 + 0.08 * Math.abs(k - best))
}
for (let b = 20; b <= 23; b++) texture[b] = 0.01
const r = chooseSeamDepth(cost, texture, cand, bins, null, 100)
assert.ok(Math.abs(r.q[12] - 1.3) < 1e-6, `近い物のビンは 1.3m: ${1 / r.q[12]}`)
assert.equal(r.q[3], 0, '遠景のビンは無限遠')
assert.equal(r.q[21], 0, '模様のないビンは隣（無限遠）に合わせる')
// 連続したフレームでは少しずつ近づける（ちらつき防止）。飛んだフレームではすぐに変える
const zero = { q: new Float32Array(bins), frame: 99 }
const r2 = chooseSeamDepth(cost, texture, cand, bins, zero, 100)
assert.ok(r2.q[12] > 0.1 && r2.q[12] < 0.5, `少しずつ: ${r2.q[12]}`)
const r3 = chooseSeamDepth(cost, texture, cand, bins, zero, 500)
assert.ok(Math.abs(r3.q[12] - 1.3) < 1e-6)
// 地面の目安: 水平より下のビン（30〜59）は地面までの距離 4m。路面は一致度が悪くばらつく（0.3〜0.6）ので、地面の距離を選ぶ。
// ビン 40 だけは 0.6m（候補 9）ではっきり一致する近い物（自車など）があるので、それを選ぶ
{
  const nb = 64
  const g = new Float32Array(nb)
  for (let b = 30; b < 60; b++) g[b] = 0.25
  const c2 = new Float32Array(K * nb)
  for (let b = 0; b < nb; b++)
    for (let k = 0; k < K; k++) {
      if (b >= 30 && b < 60) c2[k * nb + b] = 0.3 + 0.3 * (((b * 7 + k * 13) % 10) / 10) // ばらつき
      else c2[k * nb + b] = Math.min(1, 0.02 + 0.08 * k)
    }
  for (let k = 0; k < K; k++) c2[k * nb + 40] = Math.min(1, 0.03 + 0.1 * Math.abs(k - 9))
  const rg = chooseSeamDepth(c2, new Float32Array(nb).fill(0.5), cand, nb, null, 100, g)
  for (const b of [31, 35, 45, 50, 58]) assert.ok(Math.abs(rg.q[b] - 0.25) < 1e-6, `路面のビン ${b} は地面の距離: ${1 / rg.q[b]}m`)
  assert.ok(Math.abs(rg.q[40] - cand[9]) < 1e-6, `近い物: ${1 / rg.q[40]}m`)
  assert.equal(rg.q[10], 0, '水平より上は今までどおり')
  // 重力の向きから地面の距離: 方位 φ の向き = cos φ·e1 + sin φ·e2。e1 が真下なら φ = 0 で 1/高さ
  const gp = groundPrior([0, 1, 0], [1, 0, 0], [0, 1, 0], 360, 1.5)
  assert.ok(Math.abs(gp[0] - 1 / 1.5) < 1e-3 && gp[180] === 0 && gp[90] < 0.02)
}
// どの距離でも一致が悪いビン: 無限遠 0.55、いちばん近い候補だけ 0.24（明るい空との境目・模様の弱いコンクリートでのたまたまの一致）。
// 1 ビンだけ近い距離にすると、継ぎ目から少し離れた所の壁の縁に三角の段差ができる。隣（無限遠）に合わせる。
// 一方、はっきり一致する（0.14）近い物は、1 ビンでも選ぶ
{
  const c3 = new Float32Array(K * bins)
  for (let b = 0; b < bins; b++) for (let k = 0; k < K; k++) c3[k * bins + b] = Math.min(1, 0.02 + 0.08 * k)
  for (let k = 0; k < K; k++) c3[k * bins + 8] = k === 9 ? 0.24 : 0.55
  for (let k = 0; k < K; k++) c3[k * bins + 20] = k === 6 ? 0.14 : 0.35
  const rt = chooseSeamDepth(c3, new Float32Array(bins).fill(0.9), cand, bins, null, 100)
  assert.equal(rt.q[8], 0, `一致の悪いビンは隣に合わせる: ${1 / rt.q[8]}m`)
  assert.ok(Math.abs(rt.q[20] - cand[6]) < 1e-6, `はっきり一致する近い物: ${1 / rt.q[20]}m`)
}
// 継ぎ目に沿ったぼかし: 一様ならそのまま、1 ビンだけの値は周りへ広がって低くなる（合計は同じ・環状）
{
  const one = blurSeamQ(new Float32Array(64).fill(0.5))
  assert.ok(one.every((v) => Math.abs(v - 0.5) < 1e-6))
  const spike = new Float32Array(64)
  spike[0] = 2
  const bl = blurSeamQ(spike)
  assert.ok(bl[0] < 0.5 && bl[63] > 0.1 && bl[63] === bl[1], `広がる: ${bl[0]} ${bl[1]} ${bl[63]}`)
  assert.ok(Math.abs(bl.reduce((a, v) => a + v, 0) - 2) < 1e-4)
}
// ---- つなぎ目の位置と幅（chooseSeamCut）: 像が合わない方位だけ、像の差の小さい位置へずらして狭く切り替える ----
{
  const n = 64
  const J = CUT_OFFS.length
  // 距離の一致度: ビン 20〜27 はどの距離でも合わない（近い物・片方にだけ写る物）、それ以外は無限遠でよく合う
  const c2 = new Float32Array(K * n)
  for (let b = 0; b < n; b++) for (let k = 0; k < K; k++) c2[k * n + b] = b >= 20 && b <= 27 ? 0.55 : Math.min(1, 0.03 + 0.08 * k)
  // 位置の候補ごとの像の差: 合わないビンでは、幾何学的な継ぎ目（0°）の上に物があり、+4° の所（路面）なら差が小さい
  const diff = new Float32Array(J * n)
  for (let b = 0; b < n; b++)
    for (let j = 0; j < J; j++) diff[j * n + b] = b >= 20 && b <= 27 ? (CUT_OFFS[j] === 4 ? 0.05 : 0.6) : 0.05
  const tex = new Float32Array(n).fill(0.5)
  const q = new Float32Array(n)
  const c = chooseSeamCut(diff, c2, tex, cand, q, n, null, 10)
  assert.ok(c.ghost[24] > 0.9 && c.ghost[5] === 0, `合わない度合い: ${c.ghost[24]} ${c.ghost[5]}`)
  assert.ok(c.width[24] < 0.35, `合わない所は狭く: ${c.width[24]}`)
  assert.equal(c.width[5], 1, '合う所はそのまま')
  assert.ok(Math.abs(c.off[24] - 4) < 0.5, `差の小さい位置へずらす: ${c.off[24]}`)
  assert.ok(Math.abs(c.off[5]) < 1e-6 && Math.abs(c.off[45]) < 1e-6, '合う所は幾何学的な継ぎ目のまま')
  // 位置は方位に沿ってなめらかに変わる（隣のビンとの差が小さい）
  for (let b = 1; b < n; b++) assert.ok(Math.abs(c.off[b] - c.off[b - 1]) <= 2.01, `ビン ${b}: ${c.off[b - 1]} → ${c.off[b]}`)
  // 模様の無い所（空）は、合わなくても狭くしない（明るさの違いが線になって見えるので）
  const flat = new Float32Array(n).fill(0.01)
  assert.equal(chooseSeamCut(diff, c2, flat, cand, q, n, null, 10).width[24], 1)
  // 連続したフレームでは少しずつ変える
  const c3 = chooseSeamCut(diff, c2, tex, cand, q, n, { ...c, off: new Float32Array(n), width: new Float32Array(n).fill(1), frame: 9 }, 10)
  assert.ok(c3.off[24] > 0 && c3.off[24] < c.off[24], `少しずつ: ${c3.off[24]}`)
  // 像の差は時間でならす: 1 フレームだけ別の位置（−4°）の差が小さくなっても、選び直さない
  const diff2 = new Float32Array(J * n)
  for (let b = 0; b < n; b++)
    for (let j = 0; j < J; j++) diff2[j * n + b] = b >= 20 && b <= 27 ? (CUT_OFFS[j] === -4 ? 0.05 : 0.6) : 0.05
  const c4 = chooseSeamCut(diff2, c2, tex, cand, q, n, { ...c, frame: 9 }, 10)
  assert.ok(c4.off[24] > 3, `1 フレームでは選び直さない: ${c4.off[24]}`)
  // 続いたときは選び直す
  let s = c4
  for (let f = 11; f < 200; f++) s = chooseSeamCut(diff2, c2, tex, cand, q, n, s, f)
  assert.ok(s.off[24] < -3, `続けば選び直す: ${s.off[24]}`)
}
// 隣のビンへ位置を変えるときは、その間の位置の像の差も数える（物を斜めに横切らない）
{
  const n = 64
  const J = CUT_OFFS.length
  const c2 = new Float32Array(K * n).fill(0.55)
  // 差の小さい位置: ビン 0〜31 は −6° と +4°、ビン 32〜63 は +4° だけ。その間（−4〜+2°）は物の上で差が大きい
  const diff = new Float32Array(J * n)
  for (let b = 0; b < n; b++)
    for (let j = 0; j < J; j++) {
      const o = CUT_OFFS[j]
      diff[j * n + b] = o === 4 ? 0.12 : o === -6 && b < 32 ? 0.02 : o < -4 || o > 4 ? 0.3 : 0.9
    }
  const c = chooseSeamCut(diff, c2, new Float32Array(n).fill(0.5), cand, new Float32Array(n), n, null, 10)
  for (let b = 0; b < n; b++) assert.ok(c.off[b] > 2, `ビン ${b}: 物を横切って −6° へ乗り換えない: ${c.off[b]}`)
}
console.log('seamdepth.test: OK')
