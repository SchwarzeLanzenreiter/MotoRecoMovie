// 走行状態の判定を実データで確認する。実行: npx tsx test/riding.test.ts <insv> <csv>
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { estimateMount } from '../src/renderer/src/core/motion'
import { cameraRollRate, fuseLean, parseMotoReco, syncLog } from '../src/renderer/src/core/motoreco'
import { buildTelemetry } from '../src/renderer/src/core/telemetry'
import { detectRiding, STATE_NAMES, STATES } from '../src/renderer/src/core/riding'

const [insvPath, csvPath] = process.argv.slice(2)
const fh = await open(insvPath, 'r')
const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
const tr = await InsvTrailer.open(reader)
const imu = await tr.imu()
const mount = estimateMount(imu).R
const log = parseMotoReco(readFileSync(csvPath, 'utf-8'))
const cam = cameraRollRate(imu, mount, tr.meta.firstFrameUs)
const sync = syncLog(log, cam)
const lean = fuseLean(log, cam, sync)
const tel = buildTelemetry(log, sync, lean, tr.meta.frameCount / tr.meta.fps, 0.95)
// 参考: 判定に使う値の分布
const pct = (a: Float32Array, q: number[]): string => { const s = Float32Array.from(a).sort(); return q.map((x) => s[Math.floor((s.length - 1) * x)].toFixed(2)).join(' / ') }
console.log('前後G 1/5/50/95/99%:', pct(tel.channels.accelG!, [0.01, 0.05, 0.5, 0.95, 0.99]))
console.log('Fブレーキ 50/90/99%:', pct(tel.channels.brakeFront!, [0.5, 0.9, 0.99]), ' スロットル 50/90%:', pct(tel.channels.throttle!, [0.5, 0.9]))
const t0 = performance.now()
const r = detectRiding(tel)
console.log(`判定 ${(performance.now() - t0).toFixed(0)}ms`)
for (const [k, s] of STATES.entries()) {
  const segs = r.segments.filter((x) => x.state === s)
  const tot = segs.reduce((a, x) => a + x.end - x.start, 0)
  const lens = segs.map((x) => x.end - x.start).sort((a, b) => a - b)
  console.log(`${STATE_NAMES[s].padEnd(6, '　')}: 区間 ${String(segs.length).padStart(4)}  合計 ${tot.toFixed(0).padStart(5)}s (${((100 * tot) / (tel.n / tel.rate)).toFixed(1)}%)  長さの中央値 ${(lens[lens.length >> 1] ?? 0).toFixed(1)}s  最長 ${(lens[lens.length - 1] ?? 0).toFixed(1)}s`)
  void k
}
console.log('切り替わり 1分あたり', ((r.segments.length - 1) / (tel.n / tel.rate / 60)).toFixed(1), '回')
// 検証用に、1390〜1410秒の区間を表示
for (const s of r.segments.filter((x) => x.end > 1385 && x.start < 1412)) console.log(`  ${s.start.toFixed(1)}〜${s.end.toFixed(1)}s ${STATE_NAMES[s.state]}`)
await fh.close()
// 状態ごとの代表的な時刻（最長の区間の中央。見た目の確認用）
for (const s of STATES) {
  const segs = r.segments.filter((x) => x.state === s).sort((a, b) => b.end - b.start - (a.end - a.start))
  if (segs[0]) console.log(`代表 ${STATE_NAMES[s]}: ${((segs[0].start + segs[0].end) / 2).toFixed(1)}s（${segs[0].start.toFixed(1)}〜${segs[0].end.toFixed(1)}）`)
}
