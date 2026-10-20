// .insv を短く切り出す（デバッグ用のテストデータを作る）。アプリでそのまま開ける .insv になる。
//
//   映像・音声（MP4）: ffmpeg で再エンコードせずに写す（-c copy。始まりは直前のキーフレーム）
//   トレーラー: アプリが使うレコードだけを、切り出した範囲に合わせて作り直す
//     0x101 メタデータ（先頭フレームの時刻 field 24・フレーム数 field 40 を書き換え、ほかはそのまま）
//     0x3   IMU（範囲の前後 IMU_MARGIN 秒を含める）
//     0x4 / 0xc 各レンズのフレーム時刻（切り出したフレームの分）
//   時刻（us）は元の動画の時間軸のまま。切り出した動画の 0 秒 = 元の動画の startUsed 秒
//
// 実行: npx tsx tools/cut-insv.ts <元の .insv> <開始 [s]> <長さ [s]> <出力 .insv>
//   出力の横に <出力>.json（元の動画・切り出した範囲）を書く
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

/** protobuf の varint */
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

/** 最上位の field の値（varint）だけを置き換え、ほかのバイトはそのまま写す */
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
    } else throw new Error(`未対応の wire type ${wt}`)
    for (let j = start; j < i; j++) out.push(b[j])
  }
  return new Uint8Array(out)
}

/** 切り出した映像の 1 本目の映像トラックが、元のどのフレームから始まるか（サンプルの大きさの並びで照合） */
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
  throw new Error('切り出した映像の先頭フレームが元の動画に見つかりません')
}

export async function cutInsv(srcPath: string, startSec: number, durSec: number, outPath: string): Promise<{ startFrame: number; frames: number; startSec: number }> {
  const src = await reader(srcPath)
  const tr = await InsvTrailer.open(src.r)
  const tracks = await demux(src.r)
  const vids = tracks.filter((t) => t.kind === 'video')
  const ft0 = await tr.gyroFrameTimes(0) // ジャイロの時間軸（X5・分割の 2 本目以降は、記録の時刻がずれている）
  const first = tr.meta.firstFrameUs
  // 開始フレーム（2 本の映像トラックの両方でキーフレームの所まで戻る）
  let i0 = 0
  while (i0 < ft0.length - 1 && (ft0[i0] - first) / 1e6 < startSec) i0++
  let k0 = keyframeBefore(vids[0], i0)
  while (k0 > 0 && !vids.every((v) => v.keyframes[k0])) k0 = keyframeBefore(vids[0], k0 - 1)
  const tSeek = vids[0].cts[k0] / vids[0].timescale
  // 映像・音声を写す
  const tmp = outPath + '.part.mp4'
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', tSeek.toFixed(6), '-i', srcPath, '-t', String(durSec + (startSec - (ft0[k0] - first) / 1e6)), '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', tmp])
  const clip = await reader(tmp)
  const ct = (await demux(clip.r)).filter((t) => t.kind === 'video')
  await clip.close()
  const j0 = findStart(vids[0], ct[0], k0)
  const j1 = findStart(vids[1], ct[1], k0)
  if (j0 !== j1) throw new Error(`2 本の映像トラックの先頭がそろっていません（${j0} と ${j1}）`)
  const n = Math.min(ct[0].sizes.length, ct[1].sizes.length)
  // トレーラーを作る
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

// コマンドラインから
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/cut-insv.ts')) {
  const [srcPath, s, d, out] = process.argv.slice(2)
  if (!out) {
    console.log('使い方: npx tsx tools/cut-insv.ts <元の .insv> <開始 [s]> <長さ [s]> <出力 .insv>')
    process.exit(1)
  }
  const r = await cutInsv(srcPath, Number(s), Number(d), out)
  console.log(`切り出しました: 元の ${r.startSec.toFixed(2)} 秒（フレーム ${r.startFrame}）から ${r.frames} フレーム → ${out}`)
}
