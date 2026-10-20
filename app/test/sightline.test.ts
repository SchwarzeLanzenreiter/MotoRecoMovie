// 空中の標識の見通しの判定（core/sightline.ts）を合成した道路で確かめる。
// 実行: npx tsx test/sightline.test.ts
import assert from 'node:assert/strict'
import { sightVisibility, type RoadTrack } from '../src/renderer/src/core/sightline'

/** 点列 (x, y, alt) から道路を作る（1 点 = 0.1 秒） */
function road(pts: [number, number, number][]): RoadTrack {
  return {
    t: Float64Array.from(pts, (_, i) => i * 0.1),
    x: Float64Array.from(pts, (p) => p[0]),
    y: Float64Array.from(pts, (p) => p[1]),
    alt: Float64Array.from(pts, (p) => p[2])
  }
}
const at = (r: RoadTrack, i: number, h: number): { x: number; y: number; h: number } => ({ x: r.x[i], y: r.y[i], h: r.alt[i] + h })
const EYE = 1.2
const TOP = 4.5

// 1. まっすぐな平らな道: 300m 先の標識も見える
{
  const r = road(Array.from({ length: 200 }, (_, i) => [0, i * 2, 100] as [number, number, number]))
  assert.equal(sightVisibility(r, 0, r.t[150], at(r, 0, EYE), at(r, 150, TOP)), 1)
}

// 2. ヘアピン: 北へ 150m 進み、半径 30m で折り返して南へ戻る。折り返した先（60m 横・視線は山の斜面を横切る）の標識は見えない
{
  const pts: [number, number, number][] = []
  for (let y = 0; y <= 150; y += 2) pts.push([0, y, 100])
  for (let a = 0; a <= 180; a += 4) pts.push([30 - 30 * Math.cos((a * Math.PI) / 180), 150 + 30 * Math.sin((a * Math.PI) / 180), 100])
  for (let y = 150; y >= 0; y -= 2) pts.push([60, y, 100])
  const r = road(pts)
  // 手前（y=0）から、折り返した後の y=20 の地点の標識
  const iSign = pts.findIndex((p, i) => i > 100 && p[0] === 60 && p[1] <= 20)
  const v = sightVisibility(r, 0, r.t[iSign], at(r, 0, EYE), at(r, iSign, TOP))
  assert.equal(v, 0, `ヘアピンの先の標識 ${v}`)
  // ヘアピンの入口（同じ直線の先）の標識は見える
  const iEntry = pts.findIndex((p) => p[1] >= 140)
  assert.equal(sightVisibility(r, 0, r.t[iEntry], at(r, 0, EYE), at(r, iEntry, TOP)), 1)
}

// 3. 峠の頂上: 150m 先が 15m 高い頂上で、その先 100m は下り。頂上の向こうの標識は見えない。頂上の手前の標識は見える
{
  const pts: [number, number, number][] = []
  for (let y = 0; y <= 300; y += 2) pts.push([0, y, y <= 150 ? 100 + y * 0.1 : 115 - (y - 150) * 0.15])
  const r = road(pts)
  const iFar = pts.findIndex((p) => p[1] >= 280)
  const iNear = pts.findIndex((p) => p[1] >= 120)
  assert.equal(sightVisibility(r, 0, r.t[iFar], at(r, 0, EYE), at(r, iFar, TOP)), 0, '頂上の向こう')
  assert.equal(sightVisibility(r, 0, r.t[iNear], at(r, 0, EYE), at(r, iNear, TOP)), 1, '頂上の手前')
}

// 4. 緩いカーブ（半径 600m）: 200m 先も見える
{
  const R = 600
  const pts: [number, number, number][] = []
  for (let s = 0; s <= 300; s += 2) pts.push([R - R * Math.cos(s / R), R * Math.sin(s / R), 100])
  const r = road(pts)
  const i = pts.findIndex((_, k) => k * 2 >= 200)
  assert.equal(sightVisibility(r, 0, r.t[i], at(r, 0, EYE), at(r, i, TOP)), 1)
}
console.log('sightline.test: OK')
