// 車体挙動の乱れの検出と、乱れのある間の 2 画面分割を確認する。
// 実行: npx tsx test/disturb.test.ts [<insv> <csv>]
import assert from 'node:assert/strict'
import { disturbEvents, type DisturbTrack } from '../src/renderer/src/core/disturb'
import { DEFAULT_INCIDENT, incidentEvents, incidentLayout } from '../src/renderer/src/engine/incident'

// ---- 合成データ: しきい値を超えた区間と、近い区間のまとめ ----
const rate = 100
const score = new Float32Array(60 * rate)
const cause = new Uint8Array(score.length)
const bump = (t: number, len: number, v: number, c: number): void => {
  for (let i = Math.round(t * rate); i < Math.round((t + len) * rate); i++) {
    score[i] = v
    cause[i] = c
  }
}
bump(10, 0.3, 2.0, 6) // フロントサス
bump(11, 0.2, 2.5, 1) // 1 秒後にロール → まとめる
bump(30, 0.2, 1.2, 0) // しきい値未満
const d: DisturbTrack = { rate, score, cause, ref: {} as DisturbTrack['ref'] }
const ev = disturbEvents(d, 1.5)
assert.equal(ev.length, 1)
assert.equal(ev[0].cause, 'roll')
assert.ok(Math.abs(ev[0].peak - 11) < 0.05 && Math.abs(ev[0].start - 10) < 0.05)

// ---- 2 画面分割: 前後に余白を付け、切り替えはなめらかに ----
const S = { ...DEFAULT_INCIDENT, on: true }
const inc = incidentEvents(d, S, 60)
assert.equal(inc.length, 1)
assert.ok(Math.abs(inc[0].start - (10 - S.pre)) < 0.05, `開始 ${inc[0].start}`)
assert.ok(inc[0].end - inc[0].start >= S.minDur)
const mid = incidentLayout(inc, S, (inc[0].start + inc[0].end) / 2)
assert.equal(mid.w, 1)
assert.deepEqual(mid.main, { x: 0, y: 0, w: 0.5, h: 1 })
assert.deepEqual(mid.rider, { x: 0.5, y: 0, w: 0.5, h: 1 })
const before = incidentLayout(inc, S, inc[0].start - 1)
assert.equal(before.w, 0)
const half = incidentLayout(inc, S, inc[0].start + S.transition / 2)
assert.ok(half.w > 0.3 && half.w < 0.7, `途中 ${half.w}`)
// 上下分割・除外
assert.deepEqual(incidentLayout(inc, { ...S, layout: 'tb' }, (inc[0].start + inc[0].end) / 2).rider, { x: 0, y: 0.5, w: 1, h: 0.5 })
assert.equal(incidentEvents(d, { ...S, skip: [Math.round(inc[0].peak * 10) / 10] }, 60).length, 0)
// 以前の自車の画角（120°）のキーフレームは、開いたときに新しい画角になる
{
  const { migrateProject, newProject, newViewLayer } = await import('../src/renderer/src/engine/project')
  const { RIDER_VIEW } = await import('../src/renderer/src/engine/incident')
  const old = newProject('x.insv')
  old.layers.push({ ...newViewLayer('自車', { x: 0.5, y: 0, w: 0.5, h: 1 }, { ...RIDER_VIEW, fov: 120 }), role: 'incident' })
  const m = migrateProject(JSON.parse(JSON.stringify(old)), 'x.insv')
  const rider = m.layers.find((l) => l.type === 'view' && l.role === 'incident')
  assert.ok(rider && rider.type === 'view' && rider.keyframes[0].fov === RIDER_VIEW.fov)
}
console.log('disturb（合成データ）: OK')

// ---- 実データ ----
const [insvPath, csvPath] = process.argv.slice(2)
if (insvPath) {
  const { open } = await import('node:fs/promises')
  const { readFileSync } = await import('node:fs')
  const { InsvTrailer } = await import('../src/renderer/src/core/insv')
  const { estimateMount } = await import('../src/renderer/src/core/motion')
  const { cameraRollRate, cameraYawRate, fuseLean, parseMotoReco, syncLog } = await import('../src/renderer/src/core/motoreco')
  const { buildTelemetry, estimateGpsDelay, sampleChannel } = await import('../src/renderer/src/core/telemetry')
  const { disturbTrack, CAUSE_NAMES } = await import('../src/renderer/src/core/disturb')
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
  const yaw = cameraYawRate(imu, mount, tr.meta.firstFrameUs)
  const tel = buildTelemetry(log, sync, lean, dur, estimateGpsDelay(buildTelemetry(log, sync, lean, dur, 0), yaw).delay)
  const t0 = performance.now()
  const dt = disturbTrack(tel)!
  console.log(`乱れの強さの計算 ${(performance.now() - t0).toFixed(0)}ms  基準: ${Object.entries(dt.ref).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' / ')}`)
  const mmss = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
  for (const th of [1.5, 2.0]) {
    const es = disturbEvents(dt, th)
    console.log(`しきい値 ${th}: ${es.length} 件`)
    for (const e of [...es].sort((a, b) => b.score - a.score).slice(0, 12)) {
      const v = (k: Parameters<typeof sampleChannel>[1]): string => (sampleChannel(tel, k, e.peak) ?? NaN).toFixed(0)
      console.log(`  ${mmss(e.peak)}  強さ ${e.score.toFixed(2)}  ${CAUSE_NAMES[e.cause]}  速度 ${v('speed')} リーン ${v('lean')} ストローク 前${v('frStroke')} 後${v('rrStroke')} スリップ ${(sampleChannel(tel, 'slip', e.peak) ?? NaN).toFixed(1)}`)
    }
  }
  const top = [...disturbEvents(dt, 1.5)].sort((a, b) => b.score - a.score)[0]
  // Python での解析（ログ時刻 1281.8s・ロール角速度とヨー角速度が上位 0.5% の約 3 倍）と同じ事象がいちばん強い
  assert.ok(top.cause === 'roll' || top.cause === 'yaw', `いちばん強い事象の指標 ${top.cause}`)
  assert.ok(top.score > 2.5, `いちばん強い事象の強さ ${top.score}`)
  const inc = incidentEvents(dt, { ...DEFAULT_INCIDENT, on: true }, dur)
  console.log(`2 画面にする区間 ${inc.length} 件（合計 ${inc.reduce((s, x) => s + x.end - x.start, 0).toFixed(0)} 秒 / 動画 ${dur.toFixed(0)} 秒）`)
  console.log('disturb（実データ）: OK')
  await fh.close()
}
