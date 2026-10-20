// プロジェクト（レイヤー・キーフレーム）の単体テスト。実行: npx tsx test/project.test.ts
import assert from 'node:assert/strict'
import { migrateProject, newProject, shiftProjectTimes, viewAt, viewLayers, type ViewLayer } from '../src/renderer/src/engine/project'
import { addKey, addOverlayLayer, addViewLayer, editView, keyIndex, keyTolerance, moveLayer, removeKey, removeLayer } from '../src/renderer/src/engine/edit'

let p = newProject('x.insv')
const main = p.layers[0].id
const keys = (q = p, id = main): number[] => (q.layers.find((l) => l.id === id) as ViewLayer).keyframes.map((k) => k.t)
const layer = (id: string): ViewLayer => p.layers.find((l) => l.id === id) as ViewLayer

// キーフレーム1つ: レイヤー全体の視点として直接編集される
p = editView(p, main, 10, { yaw: 30 })
assert.deepEqual(keys(), [0])
assert.equal(layer(main).keyframes[0].yaw, 30)
// 追加したキーフレームは指定した時刻を持つ（端のキーフレームの t で上書きされない）
p = addKey(p, main, 100)
assert.deepEqual(keys(), [0, 100])
p = editView(p, main, 100, { yaw: -150 })
assert.equal(layer(main).keyframes[1].yaw, -150)
// 2つ以上あるとき、キーフレームのない時刻の編集は新しいキーフレームを作る
p = editView(p, main, 50, { pitch: 10 })
assert.deepEqual(keys(), [0, 50, 100])
p = removeKey(p, main, 50)
assert.deepEqual(keys(), [0, 100])

// ヨーは近い向きへ回る（170° → -170° は 20° だけ）
const mid = viewAt([{ t: 0, yaw: 170, pitch: 0, fov: 100, leanRatio: 1 }, { t: 1, yaw: -170, pitch: 0, fov: 100, leanRatio: 1 }], 0.5).yaw
assert.ok(Math.abs(Math.abs(mid) - 180) < 1e-9, `中間のヨーは ±180° のはず: ${mid}`)
assert.equal('t' in viewAt(layer(main).keyframes, -5), false)

// レイヤー: 追加した視点は元の視点を引き継ぎ、キーフレームは独立している
p = addViewLayer(p, 'サブ', { x: 0.65, y: 0.65, w: 0.3, h: 0.3 }, 0, layer(main))
const sub = p.layers[1].id
assert.equal(layer(sub).keyframes[0].yaw, 30)
p = editView(p, sub, 0, { yaw: 180 })
assert.equal(layer(sub).keyframes[0].yaw, 180)
assert.equal(layer(main).keyframes[0].yaw, 30)
p = addOverlayLayer(p, 'readout', 'テレメトリー', { x: 0.02, y: 0.7, w: 0.3, h: 0.25 })
assert.equal(p.layers.length, 3)
p = moveLayer(p, sub, 1)
assert.deepEqual(p.layers.map((l) => l.type), ['view', 'overlay', 'view'])
// 視点レイヤーは最低1つ残る
p = removeLayer(p, sub)
p = removeLayer(p, main)
assert.equal(viewLayers(p).length, 1)

// v1 形式（keyframes が直下にある）の読み込み
const v1 = { version: 1, insvPath: 'old', logPath: null, logEnabled: false, keyframes: [{ t: 0, yaw: 5, pitch: 0, fov: 90, leanRatio: 1 }, { t: 3, yaw: 50, pitch: 0, fov: 90, leanRatio: 0 }], export: { width: 1080, height: 1920, codec: 'avc', bitrateMbps: 20, inSec: 1, outSec: 9 } }
const m = migrateProject(v1, 'new.insv')
assert.equal(m.version, 2)
assert.equal(m.insvPath, 'new.insv')
assert.equal(m.logEnabled, false)
assert.equal(m.export.height, 1920)
assert.equal(m.layers.length, 1)
assert.deepEqual((m.layers[0] as ViewLayer).keyframes.map((k) => k.yaw), [5, 50])
assert.equal('keyframes' in m, false)
// 走行地点の解説（字幕）はアプリから外した: 古いプロジェクトの解説と字幕のレイヤーは読み捨てる
{
  const old = { ...newProject('x.insv'), commentary: [{ id: 'a', kind: 'spot', title: '丸山', text: '…', start: 1, end: 9, look: true, enabled: true }], commentaryLang: 'en' } as Record<string, unknown>
  ;(old.layers as unknown[]).push({ id: 'c', type: 'overlay', name: '走行地点の解説（字幕）', rect: { x: 0, y: 0, w: 1, h: 0.2 }, visible: true, widget: 'caption', props: {} })
  const mm = migrateProject(JSON.parse(JSON.stringify(old)), 'x.insv')
  assert.equal('commentary' in mm, false)
  assert.equal('commentaryLang' in mm, false)
  assert.ok(mm.layers.every((l) => !(l.type === 'overlay' && (l.widget as string) === 'caption')))
  assert.equal(mm.layers.length, 1)
}
// ---- コマの区切りに乗っていないキーフレーム（自動生成）も、そのコマにいれば削除・編集できる ----
{
  const tol = keyTolerance(50) // 12ms
  let q = newProject('x.insv')
  const id = q.layers[0].id
  q = { ...q, layers: q.layers.map((l) => (l.type === 'view' ? { ...l, keyframes: [{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }, { t: 32.55, yaw: 30, pitch: 0, fov: 110, leanRatio: 1 }, { t: 40, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }] } : l)) }
  // 32.55 秒は 1627.5 コマ目。◆をクリックすると 1628 コマ目（32.56 秒）へ移る
  assert.equal(keyIndex((q.layers[0] as ViewLayer).keyframes, 32.56), -1, '0.01 秒の決まりでは見つからなかった')
  assert.equal(keyIndex((q.layers[0] as ViewLayer).keyframes, 32.56, tol), 1)
  assert.equal(keyIndex((q.layers[0] as ViewLayer).keyframes, 32.54, tol), 1)
  assert.equal(keyIndex((q.layers[0] as ViewLayer).keyframes, 32.58, tol), -1, '隣のコマのキーフレームとはみなさない')
  const r = removeKey(q, id, 32.56, tol)
  assert.deepEqual((r.layers[0] as ViewLayer).keyframes.map((k) => k.t), [0, 40])
  // 編集: 隣に新しいキーフレームを足さず、そのキーフレームを直す
  const e = editView(q, id, 32.56, { yaw: 45 }, tol)
  assert.deepEqual((e.layers[0] as ViewLayer).keyframes.map((k) => [k.t, k.yaw]), [[0, 0], [32.55, 45], [40, 0]])
  // 追加: すでにあれば足さない
  assert.equal((addKey(q, id, 32.56, tol).layers[0] as ViewLayer).keyframes.length, 3)
}
// 時刻の基準: 新しいプロジェクトは 1、以前の版で保存したもの（無い）は無いまま読み、開いたときにずらす
{
  assert.equal(newProject('a.insv').timeBase, 1)
  const old = migrateProject({ ...newProject('a.insv'), timeBase: undefined } as unknown as Record<string, unknown>, 'a.insv')
  assert.equal(old.timeBase, undefined)
  const p = newProject('a.insv')
  const v = p.layers[0] as ViewLayer
  v.keyframes = [{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }, { t: 10, yaw: 30, pitch: 0, fov: 110, leanRatio: 1 }]
  p.markers = [{ t: 5 } as never]
  p.export = { ...p.export, inSec: 2, outSec: -1 }
  p.overtakes = [{ start: 20, end: 25 }]
  p.incident = { ...p.incident, skip: [30] }
  const q = shiftProjectTimes(p, 0.7675)
  assert.deepEqual((q.layers[0] as ViewLayer).keyframes.map((k) => k.t), [0, 10.7675], '最初のキーフレーム（0 秒）は動画の始まりのまま')
  assert.equal(q.markers[0].t, 5.7675)
  assert.equal(q.export.inSec, 2.7675)
  assert.equal(q.export.outSec, -1, '最後まで（−1）はそのまま')
  assert.deepEqual(q.overtakes, [{ start: 20.7675, end: 25.7675 }])
  assert.deepEqual(q.incident.skip, [30.7675])
  assert.equal(shiftProjectTimes(p, 0), p)
}
// 以前の既定のローパス（1500Hz）は新しい既定へ。ほかの値はそのまま
{
  const a = migrateProject({ ...newProject('a.insv'), audioFx: { on: true, declip: true, noiseDb: 12, compThresholdDb: -20, lowpassHz: 1500 } } as unknown as Record<string, unknown>, 'a.insv')
  assert.equal(a.audioFx.lowpassHz, 2000)
  const b = migrateProject({ ...newProject('a.insv'), audioFx: { on: true, declip: true, noiseDb: 12, compThresholdDb: -20, lowpassHz: 3000 } } as unknown as Record<string, unknown>, 'a.insv')
  assert.equal(b.audioFx.lowpassHz, 3000)
}
console.log('project.test: OK')
