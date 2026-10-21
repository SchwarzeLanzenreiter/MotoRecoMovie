// Export: decode the two fisheye streams -> reframe with WebGL -> hardware-encode with WebCodecs -> MP4.
// Finally the audio is muxed with ffmpeg (when tidying the riding audio, apply the same processing as the preview and encode to AAC; otherwise copy the original audio untouched).
import { Muxer, StreamTarget } from 'mp4-muxer'
import { openLocal } from '../core/file'
import { Compositor } from '../render/compositor'
import { TrackDecoder } from './decoder'
import type { Project } from './project'
import type { Session } from './session'
import { t } from '../i18n'
import { Dynamics, FX_BUILD_GAIN } from '../core/audiofx'

export interface ExportProgress {
  done: number
  total: number
  fps: number
  etaSec: number
  phase: 'encode' | 'audio' | 'done'
}

/**
 * Pick a usable encoder configuration (try HEVC, then H.264). Each is tried in this order:
 *   1. Hardware, actual frame rate
 *   2. Hardware, reporting the frame rate as HW_FPS_CAP. Windows hardware encoders are registered only up to
 *      30 fps above 1920x1080 (confirmed on an RTX 3070; 4K 50 fps is refused), so 4K export of 50 fps video was impossible.
 *      The frame rate is only a guide for bitrate allocation, so report a proportionally lower bitrate and still send frames at the video frame rate
 *   3. Software (slow)
 */
const HW_FPS_CAP = 30
async function pickEncoder(
  codec: 'hevc' | 'avc',
  w: number,
  h: number,
  fps: number,
  bitrate: number
): Promise<{ cfg: VideoEncoderConfig; mux: 'hevc' | 'avc'; note: string }> {
  const cands: { codec: string; mux: 'hevc' | 'avc' }[] = []
  if (codec === 'hevc') cands.push({ codec: 'hvc1.1.6.L153.B0', mux: 'hevc' }, { codec: 'hvc1.1.6.L150.B0', mux: 'hevc' })
  cands.push({ codec: 'avc1.640033', mux: 'avc' }, { codec: 'avc1.640028', mux: 'avc' })
  const tries: { hw: HardwareAcceleration; rate: number; note: string }[] = [
    { hw: 'prefer-hardware', rate: fps, note: 'hardware' },
    ...(fps > HW_FPS_CAP ? [{ hw: 'prefer-hardware' as HardwareAcceleration, rate: HW_FPS_CAP, note: `hardware (reporting the frame rate as ${HW_FPS_CAP}fps)` }] : []),
    { hw: 'prefer-software', rate: fps, note: 'software' }
  ]
  for (const tr of tries) {
    for (const c of cands) {
      const cfg: VideoEncoderConfig = {
        codec: c.codec,
        width: w,
        height: h,
        // When the reported frame rate is lowered, lower the bitrate too so the per-frame allocation stays the same
        bitrate: Math.round((bitrate * tr.rate) / fps),
        framerate: tr.rate,
        hardwareAcceleration: tr.hw,
        latencyMode: 'quality',
        ...(c.mux === 'avc' ? { avc: { format: 'avc' } } : {})
      } as VideoEncoderConfig
      const s = await VideoEncoder.isConfigSupported(cfg)
      if (s.supported) return { cfg, mux: c.mux, note: tr.note }
    }
  }
  throw new Error(t('No encoder found that can export {w}×{h}', { w, h }))
}

export async function exportVideo(
  session: Session,
  project: Project,
  outPath: string,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal
): Promise<{ codecUsed: string; audio: boolean; log?: string }> {
  const ex = project.export
  const fps = session.fps
  const total = session.frameCount
  const i0 = Math.max(0, Math.round(ex.inSec * fps))
  const i1 = ex.outSec < 0 ? total - 1 : Math.min(total - 1, Math.round(ex.outSec * fps))
  const n = i1 - i0 + 1
  const { cfg, mux, note } = await pickEncoder(ex.codec, ex.width, ex.height, fps, ex.bitrateMbps * 1e6)
  console.log(`Export encoder: ${cfg.codec} ${cfg.width}×${cfg.height} ${note}, reported frame rate ${cfg.framerate}fps, bitrate ${((cfg.bitrate ?? 0) / 1e6).toFixed(1)}Mbps`)

  // Dedicated decoders and render target for export (so they do not interfere with the preview)
  const f = await openLocal(project.insvPath)
  const decs = session.decoders.map((d) => new TrackDecoder(f, d.track)) as [TrackDecoder, TrackDecoder]
  const canvas = new OffscreenCanvas(ex.width, ex.height)
  const comp = new Compositor(canvas)
  session.applySeam(project.stab)
  comp.setLenses(session.rig)
  comp.body = session.body
  comp.bikeMask = session.bikeMask
  comp.exactSegmentation = true
  const telemetry = session.telemetry(project.logEnabled)

  const tmpPath = outPath.replace(/\.mp4$/i, '') + '.video-only.mp4'
  const out = await window.api.open(tmpPath, 'w')
  let writes: Promise<void> = Promise.resolve()
  const muxer = new Muxer({
    target: new StreamTarget({
      onData: (data, position) => {
        const copy = data.slice()
        writes = writes.then(() => window.api.write(out.id, copy, position))
      },
      chunked: true
    }),
    video: { codec: mux, width: ex.width, height: ex.height, frameRate: fps },
    fastStart: false,
    firstTimestampBehavior: 'offset'
  })
  let encErr: unknown = null
  const enc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encErr = e)
  })
  enc.configure(cfg)

  const t0 = performance.now()
  const motion = session.motion
  const prof = { decode: 0, upload: 0, motion: 0, draw: 0, frame: 0, wait: 0 }
  let tp = 0
  const lap = (k: keyof typeof prof): void => {
    const now = performance.now()
    prof[k] += now - tp
    tp = now
  }
  let segWaits = 0
  let prevWaited = false
  try {
    for (let k = 0; k < n; k++) {
      if (signal.aborted) throw new DOMException(t('Cancelled'), 'AbortError')
      if (encErr) throw encErr
      const i = i0 + k
      tp = performance.now()
      const [a, b] = await Promise.all([decs[0].get(i), decs[1].get(i)])
      lap('decode')
      comp.upload([a, b])
      a.close()
      b.close()
      lap('upload')
      lap('motion')
      // Signs near the own bike in the frame before: start this frame's outline now
      if (prevWaited) comp.prefetchSegmentation(i, motion)
      comp.render(i, project, motion, telemetry, ex.width, ex.height)
      // Signs near the own bike: wait for its outline in this frame and draw the frame again
      const seg = comp.segWait(i)
      prevWaited = !!seg
      if (seg) {
        segWaits++
        await seg
        comp.render(i, project, motion, telemetry, ex.width, ex.height)
      }
      lap('draw')
      const vf = new VideoFrame(canvas, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) })
      enc.encode(vf, { keyFrame: k % (fps * 2) === 0 })
      vf.close()
      lap('frame')
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1))
      lap('wait')
      if (k === n - 1)
        console.log('Export breakdown [ms/frame]', Object.entries(prof).map(([key, v]) => `${key} ${(v / (k + 1)).toFixed(1)}`).join('  '), ` decoders ${decs.map((d) => JSON.stringify(d.stats)).join(' ')} (${n} frames, ${segWaits} waited for the outline of the own bike)`)
      if (k % 10 === 0 || k === n - 1) {
        const el = (performance.now() - t0) / 1000
        const r = (k + 1) / el
        onProgress({ done: k + 1, total: n, fps: r, etaSec: (n - k - 1) / r, phase: 'encode' })
      }
    }
    await enc.flush()
    muxer.finalize()
    await writes
  } finally {
    enc.state !== 'closed' && enc.close()
    decs.forEach((d) => d.close())
    await window.api.close(out.id)
    await f.close()
  }

  // ---- Audio muxing ----
  // When tidying the riding audio, apply the same processing as the preview (Dynamics in core/audiofx.ts: cut high sounds, reduce loudness) and encode to AAC.
  // If the tidied audio (declip, suppress non-engine sound) exists, use it as the source; otherwise use the video audio. When not tidying, copy untouched
  onProgress({ done: n, total: n, fps: 0, etaSec: 0, phase: 'audio' })
  let audio = false
  let log: string | undefined
  if (session.audioTrack) {
    const fx = project.audioFx
    let r: { code: number; log: string }
    if (fx.on) {
      r = await processedAudio(session, fx, i0 / fps, n / fps, tmpPath, outPath)
    } else {
      r = await window.api.runFfmpeg([
        '-y', '-v', 'error',
        '-i', tmpPath,
        '-ss', (i0 / fps).toFixed(6), '-t', (n / fps).toFixed(6), '-i', project.insvPath,
        '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', '-movflags', '+faststart', outPath
      ])
    }
    if (r.code === 0) {
      audio = true
      await window.api.unlink(tmpPath)
    } else {
      log = r.log
    }
  }
  if (!audio) {
    // Keep the video-only file as the final file name
    const text = t('ffmpeg could not add the audio. Video-only file: {path}', { path: tmpPath })
    log = (log ? log + '\n' : '') + text
  }
  onProgress({ done: n, total: n, fps: 0, etaSec: 0, phase: 'done' })
  return { codecUsed: cfg.codec, audio, log }
}

/**
 * Apply the same processing as the preview (Dynamics) to the audio of the section [t0, t0+dur) [s] and export it together with the video (videoPath).
 * Process from 1 second earlier so the processing state settles, and trim the part that comes out late by the limiter lookahead
 */
async function processedAudio(session: Session, fx: Project['audioFx'], t0: number, dur: number, videoPath: string, outPath: string): Promise<{ code: number; log: string }> {
  const tr = session.audioTrack!
  const fs = tr.sampleRate
  const C = tr.channels
  const pre = Math.min(1, t0)
  const src = session.fxAudio?.path ?? session.path
  const inGain = session.fxAudio ? 1 / FX_BUILD_GAIN : 1
  const tmpIn = outPath.replace(/\.mp4$/i, '') + '.audio-in.f32'
  const tmpOut = outPath.replace(/\.mp4$/i, '') + '.audio-out.f32'
  try {
    let r = await window.api.runFfmpeg(['-y', '-v', 'error', '-ss', (t0 - pre).toFixed(6), '-t', (dur + pre).toFixed(6), '-i', src, '-map', '0:a:0', '-ac', String(C), '-ar', String(fs), '-f', 'f32le', '-c:a', 'pcm_f32le', tmpIn])
    if (r.code !== 0) return r
    const fin = await window.api.open(tmpIn, 'r')
    const fout = await window.api.open(tmpOut, 'w')
    try {
      const dyn = new Dynamics(fs, fx, C, inGain)
      const total = Math.floor(fin.size / 4 / C)
      const skip = Math.round(pre * fs) + dyn.latency // leading margin and the limiter delay
      const block = fs * 10
      let written = 0
      const run = async (inter: Float32Array): Promise<void> => {
        const m = inter.length / C
        const chans = Array.from({ length: C }, (_, c) => {
          const a = new Float32Array(m)
          for (let i = 0; i < m; i++) a[i] = inter[i * C + c]
          return a
        })
        dyn.process(chans)
        for (let i = 0; i < m; i++) for (let c = 0; c < C; c++) inter[i * C + c] = chans[c][i]
        // Discard the first skip samples
        const done = written
        written += m
        const from = Math.max(0, skip - done)
        if (from >= m) return
        const part = inter.subarray(from * C)
        await window.api.write(fout.id, new Uint8Array(part.buffer, part.byteOffset, part.byteLength), (done + from - skip) * C * 4)
      }
      for (let p = 0; p < total; p += block) {
        const m = Math.min(block, total - p)
        const raw = await window.api.read(fin.id, p * C * 4, m * C * 4)
        await run(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)))
      }
      // Feed silence for the limiter delay so everything comes out to the end
      await run(new Float32Array(dyn.latency * C))
    } finally {
      await window.api.close(fin.id)
      await window.api.close(fout.id)
    }
    r = await window.api.runFfmpeg([
      '-y', '-v', 'error',
      '-i', videoPath,
      '-f', 'f32le', '-ar', String(fs), '-ac', String(C), '-i', tmpOut,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outPath
    ])
    return r
  } finally {
    await window.api.unlink(tmpIn).catch(() => undefined)
    await window.api.unlink(tmpOut).catch(() => undefined)
  }
}
