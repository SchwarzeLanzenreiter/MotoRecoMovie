// 設定ファイル（engine/settings-file.ts）: 保存して別の動画のプロジェクトに読み込むと、設定とメーターなどの位置が移り、
// 動画ごとのもの（メインのキーフレーム・継ぎ目の推定値・書き出し範囲・乱れの「2 画面にしない」）は残ることを確かめる。
// 実行: npx tsx test/settings.test.ts
import assert from 'node:assert/strict'
import { applySettings, parseSettings, settingsFromProject } from '../src/renderer/src/engine/settings-file'
import { newProject, newViewLayer, type OverlayLayer, type ViewLayer } from '../src/renderer/src/engine/project'

// ---- 保存する側: メーターを右下に置き、後ろの画面を左上の小窓に、書き出しは 4K、スタビライズを弱めた ----
const a = newProject('a.insv')
const mainA = a.layers[0] as ViewLayer
mainA.keyframes = [
  { t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 },
  { t: 10, yaw: 30, pitch: 0, fov: 110, leanRatio: 1 }
]
const rearA = newViewLayer('後ろ', { x: 0, y: 0, w: 0.3, h: 0.3 }, { yaw: 180, pitch: 5, fov: 150, leanRatio: 0 })
rearA.border = { width: 0.004, color: '#ffffff' }
const riderA = { ...newViewLayer('自車（挙動の乱れ）', { x: 0.5, y: 0, w: 0.5, h: 1 }, { yaw: 170, pitch: 0, fov: 160, leanRatio: 0 }), role: 'incident' as const }
const meterA: OverlayLayer = { id: 'm1', type: 'overlay', name: 'サイバー風メーター', rect: { x: 0.7, y: 0.6, w: 0.25, h: 0.4 }, visible: true, widget: 'cyber', props: { theme: 'neon' } }
a.layers = [mainA, rearA, riderA, meterA]
a.stab = { ...a.stab, sigma: [1, 0.5, 0.3], seam: { rot: [0.1, 0, 0], edge: 1.9 }, seamBlend: 14 }
a.export = { ...a.export, width: 3840, height: 2160, bitrateMbps: 60, inSec: 5, outSec: 50, textLang: 'en' }
a.director = { ...a.director, transition: 1.2, overtake: { ...a.director.overtake, on: true } }
a.incident = { ...a.incident, on: true, threshold: 2, skip: [12.3] }
a.markers = [{ id: 'k', t: 3, yaw: 90, pitch: 0, fov: 100, hold: 2 }]

const file = settingsFromProject(a)
// ファイルの中身: 動画ごとのものは入らない
const text = JSON.stringify(file)
assert.ok(!text.includes('"seam":{') && !text.includes('"skip"') && !text.includes('"inSec"') && !text.includes('"markers"') && !text.includes('keyframes'))
assert.equal(file.layers.length, 4)

// ---- 読み込む側: 別の動画。メインのキーフレームが 3 つあり、メーターは別の位置、継ぎ目の推定値・書き出し範囲・乱れの選択は別 ----
const b = newProject('b.insv')
const mainB = b.layers[0] as ViewLayer
mainB.name = 'Main' // 英語で作ったプロジェクト（既定の名前は言語が違っても同じとみなす）
mainB.keyframes = [
  { t: 0, yaw: 0, pitch: 0, fov: 100, leanRatio: 1 },
  { t: 4, yaw: -20, pitch: 0, fov: 100, leanRatio: 1 },
  { t: 8, yaw: 0, pitch: 0, fov: 100, leanRatio: 1 }
]
const meterB: OverlayLayer = { id: 'm2', type: 'overlay', name: 'クロノグラフ風メーター', rect: { x: 0.4, y: 0.6, w: 0.2, h: 0.4 }, visible: true, widget: 'chrono', props: {} }
b.layers = [mainB, meterB]
b.stab = { ...b.stab, seam: { rot: [0.2, 0.1, 0], edge: 1.7 } }
b.export = { ...b.export, inSec: 100, outSec: 200 }
b.incident = { ...b.incident, skip: [77.7] }
b.markers = [{ id: 'z', t: 9, yaw: -90, pitch: 0, fov: 100, hold: 2 }]

const sameName = (x: string, y: string): boolean => x === y || (['メイン', 'Main'].includes(x) && ['メイン', 'Main'].includes(y))
const c = applySettings(b, parseSettings(JSON.stringify(file)), sameName)

// レイヤーはファイルの並び（メイン・後ろ・自車・サイバー風メーター）
assert.deepEqual(
  c.layers.map((l) => `${l.type}:${l.name}`),
  ['view:メイン', 'view:後ろ', 'view:自車（挙動の乱れ）', 'overlay:サイバー風メーター']
)
// メインは読み込む先のレイヤー（同じ id）で、動きのあるキーフレームを残す
const mainC = c.layers[0] as ViewLayer
assert.equal(mainC.id, mainB.id)
assert.deepEqual(mainC.keyframes, mainB.keyframes)
// 後ろ・自車の画面は新しく作られ、向き・位置・枠線・役割がファイルのとおり
const rearC = c.layers[1] as ViewLayer
assert.deepEqual(rearC.rect, { x: 0, y: 0, w: 0.3, h: 0.3 })
assert.deepEqual(rearC.keyframes, [{ t: 0, yaw: 180, pitch: 5, fov: 150, leanRatio: 0 }])
assert.deepEqual(rearC.border, { width: 0.004, color: '#ffffff' })
assert.equal((c.layers[2] as ViewLayer).role, 'incident')
// メーターの種類・位置・設定はファイルのとおり（読み込む先のメーターは置き換わる）
const meterC = c.layers[3] as OverlayLayer
assert.equal(meterC.widget, 'cyber')
assert.deepEqual(meterC.rect, { x: 0.7, y: 0.6, w: 0.25, h: 0.4 })
assert.deepEqual(meterC.props, { theme: 'neon' })
// 設定はファイルのとおり、動画ごとのものは読み込む先のまま
assert.deepEqual(c.stab.sigma, [1, 0.5, 0.3])
assert.equal(c.stab.seamBlend, 14)
assert.deepEqual(c.stab.seam, b.stab.seam)
assert.equal(c.export.width, 3840)
assert.equal(c.export.textLang, 'en')
assert.equal(c.export.inSec, 100)
assert.equal(c.export.outSec, 200)
assert.equal(c.director.transition, 1.2)
assert.equal(c.director.overtake.on, true)
assert.equal(c.incident.threshold, 2)
assert.deepEqual(c.incident.skip, [77.7])
assert.deepEqual(c.markers, b.markers)

// 視点レイヤーの無い設定ファイルなら、今の視点レイヤーを残す
{
  const onlyMeter = { ...file, layers: file.layers.filter((l) => l.type === 'overlay') }
  const d = applySettings(b, onlyMeter, sameName)
  assert.ok(d.layers.some((l) => l.id === mainB.id))
}
// 前の名前（Insta360 Reframe）のときに保存した設定ファイルも読む
assert.equal(parseSettings(JSON.stringify({ ...file, app: 'insta360-reframe' })).layers.length, 4)
assert.equal(file.app, 'motorecomovie')
// 設定ファイルでないものは読まない
assert.throws(() => parseSettings('{"version":2,"layers":[]}'))
assert.throws(() => parseSettings('not json'))
assert.throws(() => parseSettings(JSON.stringify({ ...file, version: 9 })))
console.log('settings.test: OK')
