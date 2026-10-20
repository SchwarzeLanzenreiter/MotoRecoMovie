// リーン中に横を向いたとき、視線が地面側へ下がらないこと（水平基準のヨー）を実データで確認する。
// 実行: npx tsx test/view.test.ts <insv> <csv>
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { estimateMount, integrate } from '../src/renderer/src/core/motion'
import { cameraRollRate, fuseLean, parseMotoReco, syncLog } from '../src/renderer/src/core/motoreco'
import { matVec, qAxisAngle, qRotate } from '../src/renderer/src/core/quat'
import { MotionModel } from '../src/renderer/src/engine/motion-model'
import { fixedMount } from '../src/renderer/src/core/mount'
import { newProject } from '../src/renderer/src/engine/project'

const [insvPath, csvPath] = process.argv.slice(2)
const fh = await open(insvPath, 'r')
const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
const tr = await InsvTrailer.open(reader)
const imu = await tr.imu()
const mount = estimateMount(imu).R
const log = parseMotoReco(readFileSync(csvPath, 'utf-8'))
const cam = cameraRollRate(imu, mount, tr.meta.firstFrameUs)
const lean = fuseLean(log, cam, syncLog(log, cam))
const ft = await tr.gyroFrameTimes(0)
const stab = newProject('x').stab
const mm = new MotionModel(tr.meta, integrate(imu), fixedMount(mount), ft, lean, stab)
const i = 1400 * 50
const L = mm.leanAt(i)!
// リグ座標の「真上」= 車体の上方向を前後軸まわりに -L 回したもの（validate_tilt.py と同じ）
const fwd = [mount[2], mount[5], mount[8]]
const upB = [-mount[1], -mount[4], -mount[7]]
const up = qRotate(qAxisAngle(fwd, (-L * Math.PI) / 180), upB)
const deg = (r: number): number => (r * 180) / Math.PI
const measure = (yaw: number, ratio: number): { elev: number; tilt: number } => {
  const V = mm.frame(i, { yaw, pitch: 0, fov: 100, leanRatio: ratio }).view // 列 = 右・下・前（リグ座標）
  const f = matVec(V, [0, 0, 1])
  const rgt = matVec(V, [1, 0, 0])
  const dn = matVec(V, [0, 1, 0])
  const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return { elev: deg(Math.asin(dot(f, up))), tilt: deg(Math.atan2(dot(up, rgt), -dot(up, dn))) }
}
console.log(`t=1400s リーン ${L.toFixed(1)}°`)
// 車体に固定したカメラ（スタビライズなし）の画面の傾き: 傾きを残す 100% は、前でも後ろでもこれと同じ向きに傾く
const rigid = new MotionModel(tr.meta, integrate(imu), fixedMount(mount), ft, lean, { ...stab, enabled: false })
const rigidTilt = (yaw: number): number => {
  const V = rigid.frame(i, { yaw, pitch: 0, fov: 100, leanRatio: 1 }).view
  const rgt = matVec(V, [1, 0, 0])
  const dn = matVec(V, [0, 1, 0])
  const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return deg(Math.atan2(dot(up, rgt), -dot(up, dn)))
}
for (const ratio of [1, 0]) {
  for (const yaw of [0, 30, 60, 90, 180]) {
    const m = measure(yaw, ratio)
    console.log(`  傾きを残す ${ratio * 100}%  ヨー ${String(yaw).padStart(3)}°: 視線の仰角 ${m.elev.toFixed(1).padStart(6)}°  画面の傾き ${m.tilt.toFixed(1).padStart(6)}°`)
    // 横を向いても視線は水平のまま（車体の上下動の分だけ多少ずれる）
    assert.ok(Math.abs(m.elev) < 6, `ヨー ${yaw}° で視線が上下に ${m.elev.toFixed(1)}° ずれている`)
    // 画面の傾きは「残す割合 × cos(ヨー) × リーン角」。真横では水平、後ろ向きは前向きと逆向き
    // （後ろを向いた視線は車体の前後軸と逆向きなので、車体に固定したカメラでも逆向きに傾いて見える）
    const expect = -ratio * Math.cos((yaw * Math.PI) / 180) * L
    assert.ok(Math.abs(m.tilt - expect) < 4, `ヨー ${yaw}° の傾き ${m.tilt.toFixed(1)}°（期待 ${expect.toFixed(1)}°）`)
  }
}
for (const yaw of [0, 180]) {
  const k = measure(yaw, 1).tilt
  const r = rigidTilt(yaw)
  console.log(`  ヨー ${yaw}°: 傾きを残す 100% ${k.toFixed(1)}°、車体に固定したカメラ ${r.toFixed(1)}°`)
  assert.ok(Math.sign(k) === Math.sign(r) && Math.abs(k - r) < 8, `ヨー ${yaw}° で車体に固定したカメラと傾きの向きが違う`)
}
console.log('view.test: OK')
await fh.close()
