// 画面分割（テンプレート・移動・リサイズ・吸着）の単体テスト。実行: npx tsx test/layout.test.ts
import assert from 'node:assert/strict'
import { newProject, type ViewLayer } from '../src/renderer/src/engine/project'
import { addOverlayLayer, editView } from '../src/renderer/src/engine/edit'
import { applyTemplate, dragRect, snapTargets } from '../src/renderer/src/engine/layout'

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps
let p = newProject('x.insv')
p = editView(p, p.layers[0].id, 0, { yaw: 20 })
p = addOverlayLayer(p, 'readout', 'テレメトリー', { x: 0, y: 0.7, w: 0.2, h: 0.2 })
const views = (): ViewLayer[] => p.layers.filter((l): l is ViewLayer => l.type === 'view')

// 4分割: 視点が4つになり、2つ目以降は 後ろ・左・右 を向く。元の視点の向き（yaw 20）を基準にする
p = applyTemplate(p, 'grid4', 0)
assert.equal(views().length, 4)
assert.deepEqual(views().map((v) => v.keyframes[0].yaw), [20, 180, -90, 90])
assert.ok(views().every((v) => v.visible && v.border))
// 重ね表示は一番手前のまま
assert.equal(p.layers[p.layers.length - 1].type, 'overlay')
// 2分割にすると、余った2つは削除されず非表示になる
const ids = views().map((v) => v.id)
p = applyTemplate(p, 'lr', 0)
assert.deepEqual(views().map((v) => v.id), ids)
assert.deepEqual(views().map((v) => v.visible), [true, true, false, false])
assert.deepEqual(views()[1].rect, { x: 0.5, y: 0, w: 0.5, h: 1 })
// 小窓: 全画面のメインには枠線なし、小窓には枠線あり
p = applyTemplate(p, 'pip', 0)
assert.equal(views()[0].border, undefined)
assert.ok(views()[1].border)
// もう一度4分割にすると、非表示だった視点が再利用される（キーフレームが残っている）
p = applyTemplate(p, 'grid4', 0)
assert.deepEqual(views().map((v) => v.id), ids)
assert.equal(views()[2].keyframes[0].yaw, -90)

// ---- ドラッグ ----
const T = snapTargets([{ x: 0, y: 0, w: 1, h: 1 }])
const tol = 0.01
// 移動: 右辺が 1 に近づくと吸着する
let r = dragRect({ x: 0.6, y: 0.1, w: 0.3, h: 0.3 }, 'move', 0.095, 0, T, tol, tol)
assert.ok(near(r.x + r.w, 1), `右辺が 1 に吸着するはず: ${r.x + r.w}`)
// 移動: 遠ければ吸着しない
r = dragRect({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, 'move', 0.04, 0.02, T, tol, tol)
assert.ok(near(r.x, 0.24) && near(r.y, 0.22))
// リサイズ（右下）: 動かした辺だけが変わり、中央に吸着する
r = dragRect({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 'se', 0.105, 0.0, T, tol, tol)
assert.ok(near(r.x, 0.1) && near(r.y, 0.1) && near(r.x + r.w, 0.5) && near(r.h, 0.3))
// リサイズ: 最小サイズより小さくならない
r = dragRect({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 'w', 0.5, 0, T, tol, tol)
assert.ok(r.w >= 0.05 - 1e-9 && near(r.x + r.w, 0.4))
// 他のレイヤーの辺にも吸着する
const T2 = snapTargets([{ x: 0.42, y: 0, w: 0.1, h: 1 }])
r = dragRect({ x: 0.0, y: 0.0, w: 0.4, h: 0.4 }, 'e', 0.015, 0, T2, tol, tol)
assert.ok(near(r.x + r.w, 0.42))
console.log('layout.test: OK')

// ---- リーン角の MAX ホールド（切り返しでリセット）----
import { leanHoldTrack } from '../src/renderer/src/core/riding'
const lean = [0, 5, 20, 35, 30, 10, 2, -1, -4, -20, -40, -25, -2, 1, 2.5, -30]
const hold = Array.from(leanHoldTrack(lean))
// 右に傾いて最大 35° を保持 → 左へ切り返した（-4°）時点でリセット → 左の最大 -40° を保持 → 右へ 2.5° は閾値未満なので保持のまま
assert.deepEqual(hold, [0, 5, 20, 35, 35, 35, 35, 35, -4, -20, -40, -40, -40, -40, -40, -40])
console.log('leanHold: OK')
