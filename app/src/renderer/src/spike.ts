// Check whether HEVC Main10 (2 x 4K) can be decoded with WebCodecs
import { demux, keyframeBefore, type Track } from './core/mp4'
import { openLocal } from './core/file'

export async function runDecodeSpike(path: string, canvas: HTMLCanvasElement, startSec = 1400): Promise<void> {
  const f = await openLocal(path)
  const t0 = performance.now()
  const tracks = await demux(f)
  console.log(`demux ${(performance.now() - t0).toFixed(0)}ms`)
  for (const t of tracks) {
    console.log(`track ${t.id} ${t.kind} ${t.codec} ${t.width}x${t.height} samples=${t.sizes.length} timescale=${t.timescale} key=${t.keyframes.reduce((a, b) => a + b, 0)}`)
  }
  const videos = tracks.filter((t) => t.kind === 'video')
  const ctx = canvas.getContext('2d')!
  for (const [vi, t] of videos.entries()) {
    const cfg: VideoDecoderConfig = {
      codec: t.codec,
      description: t.description!,
      codedWidth: t.width,
      codedHeight: t.height,
      hardwareAcceleration: 'prefer-hardware'
    }
    const sup = await VideoDecoder.isConfigSupported(cfg)
    console.log(`isConfigSupported(${t.codec}) = ${sup.supported}`)
    if (!sup.supported) continue
    const target = Math.round(startSec * 50)
    const key = keyframeBefore(t, target)
    const N = target - key + 100
    let got = 0
    let last: VideoFrame | null = null
    let fmt = ''
    const done = new Promise<void>((resolve, reject) => {
      const dec = new VideoDecoder({
        output: (fr) => {
          got++
          fmt = `${fr.format} ${fr.codedWidth}x${fr.codedHeight} ts=${fr.timestamp}`
          last?.close()
          last = fr
          if (got === N) resolve()
        },
        error: (e) => reject(e)
      })
      dec.configure(cfg)
      ;(async () => {
        const ts0 = performance.now()
        for (let i = key; i < key + N; i++) {
          const data = await f.read(t.offsets[i], t.sizes[i])
          dec.decode(new EncodedVideoChunk({ type: t.keyframes[i] ? 'key' : 'delta', timestamp: Math.round((t.cts[i] / t.timescale) * 1e6), data }))
          while (dec.decodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1))
        }
        await dec.flush()
        const el = (performance.now() - ts0) / 1000
        console.log(`track ${t.id}: decoded ${N} frames (from keyframe ${key}) in ${el.toFixed(2)}s = ${(N / el).toFixed(1)} fps, format ${fmt}`)
        dec.close()
      })().catch(reject)
    })
    await done
    if (last) {
      const fr = last as VideoFrame
      ctx.drawImage(fr, vi * 480, 0, 480, 480)
      fr.close()
    }
  }
  await f.close()
}
