// 書き出し: 2本の魚眼をデコード → WebGL でリフレーム → WebCodecs でハードウェアエンコード → MP4。
// 最後に音声を ffmpeg で合成する（走行中の音を整えるときは、プレビューと同じ処理をかけて AAC に。整えないときは元ファイルの音声を無変換で）。
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
 * 使えるエンコーダー設定を選ぶ（HEVC → H.264 の順に試す）。それぞれ次の順で試す:
 *   1. ハードウェア・実際のフレームレート
 *   2. ハードウェア・フレームレートを HW_FPS_CAP と伝える。Windows のハードウェアエンコーダーは 1920×1080 より大きいと
 *      30fps までしか登録されておらず（RTX 3070 で確認。4K 50fps は断られる）、50fps の動画の 4K 書き出しができなかった。
 *      フレームレートはビットレートの配分の目安なので、その分ビットレートを下げて伝え、実際には動画のフレームレートで送る
 *   3. ソフトウェア（遅い）
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
    { hw: 'prefer-hardware', rate: fps, note: 'ハードウェア' },
    ...(fps > HW_FPS_CAP ? [{ hw: 'prefer-hardware' as HardwareAcceleration, rate: HW_FPS_CAP, note: `ハードウェア（フレームレートを ${HW_FPS_CAP}fps と伝える）` }] : []),
    { hw: 'prefer-software', rate: fps, note: 'ソフトウェア' }
  ]
  for (const tr of tries) {
    for (const c of cands) {
      const cfg: VideoEncoderConfig = {
        codec: c.codec,
        width: w,
        height: h,
        // 伝えるフレームレートを下げたときは、1 フレームあたりの割り当てが同じになるようビットレートも下げる
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
  throw new Error(t('{w}×{h} を書き出せるエンコーダーが見つかりません', { w, h }))
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
  console.log(`書き出しのエンコーダー: ${cfg.codec} ${cfg.width}×${cfg.height} ${note}・伝えたフレームレート ${cfg.framerate}fps・ビットレート ${((cfg.bitrate ?? 0) / 1e6).toFixed(1)}Mbps`)

  // 書き出し専用のデコーダーと描画先（プレビューと干渉しないように）
  const f = await openLocal(project.insvPath)
  const decs = session.decoders.map((d) => new TrackDecoder(f, d.track)) as [TrackDecoder, TrackDecoder]
  const canvas = new OffscreenCanvas(ex.width, ex.height)
  const comp = new Compositor(canvas)
  session.applySeam(project.stab)
  comp.setLenses(session.rig)
  comp.body = session.body
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
  try {
    for (let k = 0; k < n; k++) {
      if (signal.aborted) throw new DOMException(t('中止しました'), 'AbortError')
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
      comp.render(i, project, motion, telemetry, ex.width, ex.height)
      lap('draw')
      const vf = new VideoFrame(canvas, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) })
      enc.encode(vf, { keyFrame: k % (fps * 2) === 0 })
      vf.close()
      lap('frame')
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1))
      lap('wait')
      if (k === n - 1)
        console.log('書き出しの内訳[ms/フレーム]', Object.entries(prof).map(([key, v]) => `${key} ${(v / (k + 1)).toFixed(1)}`).join('  '), ` デコーダー ${decs.map((d) => JSON.stringify(d.stats)).join(' ')}（${n} フレーム）`)
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

  // ---- 音声の合成 ----
  // 走行中の音を整えるときは、プレビューと同じ処理（core/audiofx.ts の Dynamics: 高い音を切る・音圧を抑える）をかけて AAC に。
  // 整えた音声（音割れの補修・エンジン音以外を抑える）ができていればそれを元に、まだなら動画の音声を元にする。整えないときは無変換
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
    // 音声なしのまま最終ファイル名にする
    const text = t('ffmpeg で音声を合成できませんでした。映像のみのファイル: {path}', { path: tmpPath })
    log = (log ? log + '\n' : '') + text
  }
  onProgress({ done: n, total: n, fps: 0, etaSec: 0, phase: 'done' })
  return { codecUsed: cfg.codec, audio, log }
}

/**
 * 区間 [t0, t0+dur) [s] の音声に、プレビューと同じ処理（Dynamics）をかけて、映像（videoPath）と合わせて書き出す。
 * 処理の状態が落ち着くよう 1 秒前から処理し、リミッターの先読みのぶん遅れて出る所を詰める
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
      const skip = Math.round(pre * fs) + dyn.latency // 先頭の余白と、リミッターの遅れ
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
        // 先頭の skip サンプルは捨てる
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
      // リミッターの遅れのぶん、無音を流して最後まで出す
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
