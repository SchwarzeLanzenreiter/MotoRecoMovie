// Cuts a short piece out of an .insv (to make test data for debugging). The result is an .insv that the app can open as is.
//
//   Video and audio (MP4): copied by ffmpeg without re-encoding (-c copy; the start is the preceding keyframe)
//   Trailer: only the records the app uses are rebuilt to match the cut range
//     0x101 metadata (rewrites the first-frame time, field 24, and the frame count, field 40; the rest is kept as is)
//     0x3   IMU (includes IMU_MARGIN seconds before and after the range)
//     0x4 / 0xc frame times of each lens (for the cut frames)
//   Times (us) stay on the time axis of the original video. 0 s of the cut video = startUsed seconds of the original
//
// Run: npx tsx tools/cut-insv.ts <source .insv> <start [s]> <duration [s]> <output .insv>
//   Writes <output>.json (the source video and the cut range) next to the output
import { open, writeFile, appendFile, copyFile, unlink, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { demux, keyframeBefore, type FileReader, type Track } from '../src/renderer/src/core/mp4'

const IMU_MARGIN = 2 // [s]
const MAGIC = '8db42d694ccc418790edff439fe026bf'

async function reader(path: string): Promise<{ r: FileReader; close: () => Promise<void> }> {
  const fh = await open(path, 'r')
  const size = (await fh.stat()).size
  return {
    r: {
      size,
      read: async (o: number, l: number) => {
        const b = new Uint8Array(l)
        await fh.read(b, 0, l, o)
        return b
      }
    },
    close: () => fh.close()
  }
}

/** protobuf varint */
function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v >= 128) {
    out.push((v % 128) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

/** Replaces only the values (varint) of top-level fields; all other bytes are copied as is */
function patchProtobuf(b: Uint8Array, patch: Map<number, number>): Uint8Array {
  const out: number[] = []
  let i = 0
  const readVarint = (): number => {
    let r = 0
    let s = 1
    for (;;) {
      const c = b[i++]
      r += (c & 0x7f) * s
      s *= 128
      if (c < 0x80) return r
    }
  }
  while (i < b.length) {
    const start = i
    const k = readVarint()
    const fn = Math.floor(k / 8)
    const wt = k & 7
    if (wt === 0) {
      readVarint()
      if (patch.has(fn)) out.push(...varint(k), ...varint(patch.get(fn)!))
      else for (let j = start; j < i; j++) out.push(b[j])
      continue
    }
    if (wt === 1) i += 8
    else if (wt === 5) i += 4
    else if (wt === 2) {
      const n = readVarint()
      i += n
    } else throw new Error(`Unsupported wire type ${wt}`)
    for (let j = start; j < i; j++) out.push(b[j])
  }
  return new Uint8Array(out)
}

/** Which frame of the original the first video track of the cut video starts from (matched by the sequence of sample sizes) */
function findStart(src: Track, clip: Track, guess: number): number {
  const N = Math.min(12, clip.sizes.length)
  for (let d = 0; d < 400; d++) {
    for (const j of [guess - d, guess + d]) {
      if (j < 0 || j + N > src.sizes.length) continue
      let ok = true
      for (let k = 0; k < N && ok; k++) ok = src.sizes[j + k] === clip.sizes[k]
      if (ok) return j
    }
  }
  throw new Error('The first frame of the cut video was not found in the original video')
}

export async function cutInsv(srcPath: string, startSec: number, durSec: number, outPath: string): Promise<{ startFrame: number; frames: number; startSec: number }> {
  const src = await reader(srcPath)
  const tr = await InsvTrailer.open(src.r)
  const tracks = await demux(src.r)
  const vids = tracks.filter((t) => t.kind === 'video')
  const ft0 = await tr.gyroFrameTimes(0) // gyro time axis (on the X5 and on second and later split files, the recorded times are offset)
  const first = tr.meta.firstFrameUs
  // start frame (go back to a keyframe on both video tracks)
  let i0 = 0
  while (i0 < ft0.length - 1 && (ft0[i0] - first) / 1e6 < startSec) i0++
  let k0 = keyframeBefore(vids[0], i0)
  while (k0 > 0 && !vids.every((v) => v.keyframes[k0])) k0 = keyframeBefore(vids[0], k0 - 1)
  const tSeek = vids[0].cts[k0] / vids[0].timescale
  // copy the video and audio
  const tmp = outPath + '.part.mp4'
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', tSeek.toFixed(6), '-i', srcPath, '-t', String(durSec + (startSec - (ft0[k0] - first) / 1e6)), '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', tmp])
  const clip = await reader(tmp)
  const ct = (await demux(clip.r)).filter((t) => t.kind === 'video')
  await clip.close()
  const j0 = findStart(vids[0], ct[0], k0)
  const j1 = findStart(vids[1], ct[1], k0)
  if (j0 !== j1) throw new Error(`The starts of the two video tracks do not match (${j0} and ${j1})`)
  const n = Math.min(ct[0].sizes.length, ct[1].sizes.length)
  // build the trailer
  const imuRaw = await tr.record(0x3)
  const dvI = new DataView(imuRaw.buffer, imuRaw.byteOffset, imuRaw.byteLength)
  const tA = ft0[j0] - IMU_MARGIN * 1e6
  const tB = ft0[Math.min(ft0.length - 1, j0 + n - 1)] + IMU_MARGIN * 1e6
  let a = 0
  while (a * 20 < imuRaw.length && Number(dvI.getBigUint64(a * 20, true)) < tA) a++
  let b = a
  while (b * 20 < imuRaw.length && Number(dvI.getBigUint64(b * 20, true)) <= tB) b++
  const ftRec = async (id: number): Promise<Uint8Array> => (await tr.record(id)).slice(j0 * 16, (j0 + n) * 16)
  const records: [number, Uint8Array][] = [
    [0x101, patchProtobuf(await tr.record(0x101), new Map([[24, ft0[j0]], [40, n]]))],
    [0x3, imuRaw.slice(a * 20, b * 20)],
    [0x4, await ftRec(0x4)],
    [0xc, await ftRec(0xc)]
  ]
  const parts: Uint8Array[] = []
  const index: number[] = []
  let off = 0
  const header = (id: number, size: number): Uint8Array => {
    const h = new Uint8Array(6)
    h[0] = id >> 8
    h[1] = id & 0xff
    new DataView(h.buffer).setUint32(2, size, true)
    return h
  }
  for (const [id, data] of records) {
    parts.push(data, header(id, data.length))
    index.push(id, data.length, off)
    off += data.length + 6
  }
  const idx = new Uint8Array((index.length / 3) * 10)
  const dvx = new DataView(idx.buffer)
  for (let k = 0; k < index.length / 3; k++) {
    dvx.setUint16(k * 10, index[k * 3], true)
    dvx.setUint32(k * 10 + 2, index[k * 3 + 1], true)
    dvx.setUint32(k * 10 + 6, index[k * 3 + 2], true)
  }
  parts.push(idx, header(0, idx.length))
  off += idx.length + 6
  const tail = new Uint8Array(72)
  const dvt = new DataView(tail.buffer)
  dvt.setUint32(32, off + 72, true)
  dvt.setUint32(36, 3, true)
  tail.set(new TextEncoder().encode(MAGIC), 40)
  parts.push(tail)
  await copyFile(tmp, outPath)
  await unlink(tmp)
  for (const p of parts) await appendFile(outPath, p)
  await src.close()
  const used = (ft0[j0] - first) / 1e6
  await writeFile(
    outPath + '.json',
    JSON.stringify({ source: srcPath, startSec: used, startFrame: j0, frames: n, fps: tr.meta.fps, imuSamples: b - a, bytes: (await stat(outPath)).size }, null, 2)
  )
  return { startFrame: j0, frames: n, startSec: used }
}

// from the command line
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/cut-insv.ts')) {
  const [srcPath, s, d, out] = process.argv.slice(2)
  if (!out) {
    console.log('Usage: npx tsx tools/cut-insv.ts <source .insv> <start [s]> <duration [s]> <output .insv>')
    process.exit(1)
  }
  const r = await cutInsv(srcPath, Number(s), Number(d), out)
  console.log(`Cut: ${r.frames} frames from ${r.startSec.toFixed(2)} s of the source (frame ${r.startFrame}) -> ${out}`)
}
