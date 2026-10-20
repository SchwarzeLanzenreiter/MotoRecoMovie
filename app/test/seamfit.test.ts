// 継ぎ目の合わせ込み（レンズ1の回転補正の推定）を実データで確認する。フレームは ffmpeg で読む。
// 実行: npx tsx test/seamfit.test.ts <insv>
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { open } from 'node:fs/promises'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { makeRig } from '../src/renderer/src/core/lens'
import { fitSeam, type SeamFrame } from '../src/renderer/src/core/seamfit'

const [insvPath] = process.argv.slice(2)
const fh = await open(insvPath, 'r')
const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
const tr = await InsvTrailer.open(reader)
const rig = makeRig(tr.meta.calibration, 3840)
const SIZE = 960
// X6 はトラック順が逆（ストリーム1がレンズ0）
const gray = (lens: number, frame: number): Float32Array => {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', (frame / tr.meta.fps).toFixed(6), '-i', insvPath, '-map', `0:${lens === 0 ? 1 : 0}`, '-vf', `scale=${SIZE}:${SIZE}:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 })
  return Float32Array.from(raw.subarray(0, SIZE * SIZE), (v) => v / 255)
}
const frames: SeamFrame[] = [43800, 3000, 20000, 60000].map((f) => ({ size: SIZE, img: [gray(0, f), gray(1, f)] }))
const t0 = performance.now()
const r = fitSeam(rig, frames)
console.log(`推定 ${(performance.now() - t0).toFixed(0)}ms  回転 [${r.fix.rot.map((v) => v.toFixed(3)).join(", ")}]°  縁 ${r.fix.edge.toFixed(3)}°  重なり帯の差 ${r.before.toFixed(4)} → ${r.after.toFixed(4)}`)
// Python（proto, 1920 四方・4 フレーム）の推定: 縁の角度 1.96°・回転はほぼ 0（[0.20, -0.03, -0.03]）
assert.ok(Math.abs(r.fix.edge - 1.96) < 0.3, `縁の角度 ${r.fix.edge}`)
assert.ok(Math.hypot(...r.fix.rot) < 0.5, `回転 ${r.fix.rot}`)
assert.ok(r.after < r.before * 0.75, '重なり帯の差が 25% 以上減る')
console.log('seamfit.test: OK')
await fh.close()
