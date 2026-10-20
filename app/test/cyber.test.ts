// サイバー風メーター: エンジン停止中の灰色の判定（enginePower）を合成データで確かめる。
// 実行: npx tsx test/cyber.test.ts [<.insv> <MotoReco .csv>]   実データを渡すと、エンジンが止まっている区間を出す
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { airShift, airTempShown, enginePower, gearShift, POP_TIME, ROLL_TIME } from '../src/renderer/src/render/overlay'
import type { Telemetry } from '../src/renderer/src/core/telemetry'
import { airTempColor } from '../src/renderer/src/render/chrono'

// 0〜10 秒は止まっている（0 rpm）、10 秒で始動（1100 rpm）、30 秒で停止
const rate = 100
const n = 40 * rate
const rpm = new Float32Array(n).map((_, i) => (i >= 10 * rate && i < 30 * rate ? 1100 : 0))
const tel = { rate, n, t0: 0, channels: { rpm }, gps: null } as unknown as Telemetry
assert.equal(enginePower(tel, 5), 0, '止まっている間は 0（灰色）')
assert.equal(enginePower(tel, 20), 1, '掛かっている間は 1（普通の色）')
const mid = enginePower(tel, 10.25)
assert.ok(mid > 0 && mid < 1, `始動の直後は灰色から少しずつ戻る: ${mid}`)
assert.equal(enginePower(tel, 10.6), 1, '始動から 0.5 秒で普通の色')
assert.ok(enginePower(tel, 30.25) > 0 && enginePower(tel, 30.25) < 1, '停止の直後は少しずつ灰色へ')
assert.equal(enginePower(tel, 31), 0)
// 回転数のデータが無い（車両ログが無い・ログに回転数が無い）ときは演出しない
assert.equal(enginePower(null, 5), 1)
assert.equal(enginePower({ ...tel, channels: {} } as Telemetry, 5), 1)

// ---- 数字の切り替わり: ギア 6 → 5 を 20 秒で。ROLL_TIME + POP_TIME 秒の間は前の値と経過時間を返す ----
{
  const gear = new Float32Array(n).map((_, i) => (i < 20 * rate ? 6 : 5))
  const tg = { rate, n, t0: 0, channels: { gear } } as unknown as Telemetry
  assert.equal(gearShift(tg, 19.9), null, '切り替わる前')
  const s = gearShift(tg, 20.1)
  assert.ok(s && s.prev === 6 && Math.abs(s.e - 0.1) < 0.02, `途中: ${JSON.stringify(s)}`)
  assert.equal(gearShift(tg, 20 + ROLL_TIME + POP_TIME + 0.05), null, '切り替わり終わった後')
  assert.equal(gearShift({ ...tg, channels: {} } as Telemetry, 20.1), null, 'ギアのデータが無い')
}
// ---- 外気温: 0.75℃ 違いの 2 つの値を行ったり来たりしても、表示の数字は一度変わったら往復しない ----
{
  const air = new Float32Array(n).map((_, i) => (i < 10 * rate ? 20.25 : i < 20 * rate ? (Math.floor(i / 50) % 2 ? 21.0 : 20.25) : 22.5))
  const ta = { rate, n, t0: 0, channels: { airTemp: air } } as unknown as Telemetry
  const shown = airTempShown(ta)!
  assert.equal(shown[5 * rate], 20)
  let changes = 0
  for (let i = 10 * rate + 1; i < 20 * rate; i++) if (shown[i] !== shown[i - 1]) changes++
  assert.ok(changes <= 1, `20.25 と 21.0 を行ったり来たりしても数字は往復しない: ${changes} 回`)
  assert.equal(shown[25 * rate], 23)
  const r = airShift(ta, 20.2)
  assert.ok(r && r.prev === 21, `22.5℃ になったら 21 → 23 へ流れる: ${JSON.stringify(r)}`)
}

// ---- 外気温の色: 5℃ 以下は水色、30℃ 以上は黄色、35℃ 以上はオレンジ、40℃ 以上は赤、それ以外は白 ----
{
  const white = airTempColor(20)
  assert.equal(white, '#ffffff')
  assert.equal(airTempColor(5), airTempColor(-3), '5℃ 以下は同じ水色')
  assert.notEqual(airTempColor(5), white)
  assert.equal(airTempColor(6), white)
  assert.equal(airTempColor(29), white)
  const y = airTempColor(30)
  const o = airTempColor(35)
  const r = airTempColor(40)
  assert.ok(new Set([white, airTempColor(5), y, o, r]).size === 5, '5 つの色はすべて違う')
  assert.equal(airTempColor(34), y)
  assert.equal(airTempColor(39), o)
  assert.equal(airTempColor(45), r)
  assert.equal(airTempColor(undefined), white)
}

// ---- 変速の途中の短い 0 は前の段のまま（1 → N → 2 とちらつかない）。止まってニュートラルに入れた長い 0 は残す ----
{
  const { holdThroughShift } = await import('../src/renderer/src/core/telemetry')
  const g = new Float32Array([1, 1, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3])
  // rate 10Hz: 0.2 秒の 0 は埋め、1.0 秒の 0 は残す
  assert.deepEqual(Array.from(holdThroughShift(g, 10)), [1, 1, 1, 1, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3])
}

// 実データ: エンジンが止まっている区間（動画時刻）
const [insvPath, csvPath] = process.argv.slice(2)
if (insvPath && csvPath) {
  const { InsvTrailer } = await import('../src/renderer/src/core/insv')
  const { estimateMount } = await import('../src/renderer/src/core/motion')
  const { cameraRollRate, fuseLean, parseMotoReco, syncLog } = await import('../src/renderer/src/core/motoreco')
  const { buildTelemetry } = await import('../src/renderer/src/core/telemetry')
  const fh = await open(insvPath, 'r')
  const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
  const tr = await InsvTrailer.open(reader)
  const imu = await tr.imu()
  const mount = estimateMount(imu).R
  const log = parseMotoReco(readFileSync(csvPath, 'utf-8'))
  const cam = cameraRollRate(imu, mount, tr.meta.firstFrameUs)
  const sync = syncLog(log, cam)
  const real = buildTelemetry(log, sync, fuseLean(log, cam, sync), tr.meta.frameCount / tr.meta.fps, 0)
  let start = -1
  const out: string[] = []
  const fmt = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
  for (let s = 0; s < real.n / real.rate; s += 0.1) {
    const off = enginePower(real, s) === 0
    if (off && start < 0) start = s
    if (!off && start >= 0) {
      out.push(`${fmt(start)}〜${fmt(s)}`)
      start = -1
    }
  }
  if (start >= 0) out.push(`${fmt(start)}〜最後`)
  console.log('エンジン停止:', out.join(' ') || 'なし')
  const shifts: string[] = []
  for (let s = 0; s < real.n / real.rate && shifts.length < 6; s += 0.01) {
    const g = gearShift(real, s)
    if (g && g.e < 0.01) {
      shifts.push(`${fmt(s)}（${g.prev}→${real.channels.gear![Math.floor(s * real.rate)]}）`)
      s += 1
    }
  }
  console.log('ギアの切り替わり:', shifts.join(' '))
  const airs: string[] = []
  const shownAir = airTempShown(real)
  for (let i = 1; shownAir && i < shownAir.length && airs.length < 6; i++)
    if (shownAir[i] !== shownAir[i - 1] && Number.isFinite(shownAir[i - 1])) airs.push(`${fmt(i / real.rate)}（${shownAir[i - 1]}→${shownAir[i]}℃）`)
  console.log('外気温の表示の切り替わり:', airs.join(' ') || 'なし')
  await fh.close()
}
console.log('cyber.test: OK')
