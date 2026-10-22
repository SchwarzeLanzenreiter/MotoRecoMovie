// Automated tests run when launched with the REFRAME_AUTOTEST environment variable (for checking in environments where the UI cannot be operated)
import { setLang, type Lang } from './i18n'
import { runDecodeSpike } from './spike'
import { Session } from './engine/session'
import { newProject, viewAt, type ViewLayer } from './engine/project'
import { GlReframer, SEAM_BINS, SEAM_CAND } from './render/gl-reframe'
import { exportVideo } from './engine/exporter'
import { buildFxAudio } from './engine/audiofx'
import { DEFAULT_AUDIO_FX } from './core/audiofx'
import { CUT_OFFS, groundPrior } from './render/seamdepth'
import { seamBasis } from './core/seamfit'
import { findLaneCrossings } from './core/lanes'
import { focalFor, wideK } from './render/projection'
import { BAND_H, BAND_W, bodyAt, type BodyTrack } from './core/bodymap'
import { buildBodyTrack } from './engine/bodymap'
import { keyframeBefore } from './core/mp4'
import { drawThemeGallery } from './themegallery'
import { chooseLogoFile, initMeterLogos, updateMeterLogo } from './engine/meter-logos'
import type { MeterLogo } from './core/logo'
import { debugPlateCrops, initPlates } from './engine/plates'
import { PLATE_SIZE } from './core/plates'

async function saveCanvas(c: HTMLCanvasElement, path: string): Promise<void> {
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
  await window.api.writeBinary(path, new Uint8Array(await blob.arrayBuffer()))
}

export async function runAutotest(): Promise<void> {
  const env = await window.api.test.env()
  if (!env.autotest) return
  const args = JSON.parse(env.args ?? '{}')
  try {
    if (env.autotest === 'decode') {
      const c = document.createElement('canvas')
      c.width = 960
      c.height = 480
      c.style.cssText = 'position:fixed;left:0;top:0;z-index:99'
      document.body.appendChild(c)
      await runDecodeSpike(args.path, c, args.start ?? 1400)
      if (args.capture) await window.api.test.capture(args.capture)
    } else if (env.autotest === 'plates') {
      // License plate detector on the crops round the given frames (args.frames), saved with the boxes drawn (args.out: folder)
      const proj = newProject(args.path)
      const s = await Session.open(args.path, proj.stab, (m) => console.log(m))
      console.log('plate detector:', await initPlates())
      for (const i of (args.frames as number[] | undefined) ?? (args.times as number[]).map((x) => s.frameOf(x))) {
        const t0 = performance.now()
        const crops = await debugPlateCrops(s, i)
        console.log(`frame ${i}: ${(performance.now() - t0).toFixed(0)}ms`, JSON.stringify(crops.map((c) => ({ yaw: c.yaw, pitch: c.pitch, boxes: c.boxes.map((b) => [Math.round(b.x0), Math.round(b.y0), Math.round(b.x1), Math.round(b.y1), +b.score.toFixed(2)]) }))))
        for (const c of crops) {
          if (!c.boxes.length && !args.all) continue
          const cv = document.createElement('canvas')
          cv.width = PLATE_SIZE
          cv.height = PLATE_SIZE
          const g = cv.getContext('2d')!
          g.putImageData(new ImageData(new Uint8ClampedArray(c.rgba.buffer as ArrayBuffer), PLATE_SIZE, PLATE_SIZE), 0, 0)
          g.lineWidth = 2
          g.font = '14px sans-serif'
          for (const b of c.boxes) {
            g.strokeStyle = b.score >= 0.35 ? '#00ff00' : '#ffaa00'
            g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0)
            g.fillStyle = g.strokeStyle
            g.fillText(b.score.toFixed(2), b.x0, b.y0 - 3)
          }
          await saveCanvas(cv, `${args.out}/plates_${i}_${c.yaw}_${c.pitch}.png`)
        }
      }
    } else if (env.autotest === 'themes') {
      // Gallery of the design themes (args.capture: PNG path; args.grey: as while the engine is stopped;
      // args.logos: { [themeId]: { path, circle?, keyBg?, keyAll?, tolerance?, size?, opacity? } } shows an image in the middle of that theme's meter, in memory only)
      const logos = (args.logos ?? {}) as Record<string, { path: string } & Partial<Omit<MeterLogo, 'file'>>>
      await initMeterLogos()
      for (const [id, { path, ...rest }] of Object.entries(logos)) {
        await chooseLogoFile(id, path)
        updateMeterLogo(id, rest, false)
      }
      const c = document.createElement('canvas')
      drawThemeGallery(c, !!args.grey)
      await saveCanvas(c, args.capture)
      console.log(`themes: ${c.width}x${c.height} -> ${args.capture}`)
    } else if (env.autotest === 'render') {
      // Render the frame at the given time with several settings and save PNGs
      const proj = newProject(args.path)
      const t0 = performance.now()
      const s = await Session.open(args.path, proj.stab, (m) => console.log(m))
      console.log(`Session.open ${(performance.now() - t0).toFixed(0)}ms`)
      if (args.log) {
        const t1 = performance.now()
        const info = await s.loadLog(args.log, args.ddf ?? null)
        console.log(`loadLog ${(performance.now() - t1).toFixed(0)}ms  b=${info.sync.b.toFixed(4)} k=${info.lean.k.toFixed(4)}`)
      }
      // gyroShiftMs: for verification. Shift the correction from frame time to gyro time by this much (to check the stabilization time alignment)
      if (args.gyroShiftMs) (s.motion as unknown as { offsetUs: number }).offsetUs += args.gyroShiftMs * 1000
      // imuLean: render under the same conditions as with no vehicle log (lean angle estimated from the video IMU)
      if (args.imuLean) await s.loadImuTelemetry()
      // logOff: the state with the log loaded and then disabled (mount orientation refined with the log, lean angle estimated from the video)
      if (args.logOff) s.setLogEnabled(false)
      const c = document.createElement('canvas')
      const gl = new GlReframer(c)
      // seam: 'auto' = estimate and use seam fitting, { rot, edge } = use that correction
      if (args.seam) {
        const t1 = performance.now()
        const fix = args.seam === 'auto' ? (await s.estimateSeam()).fix : args.seam
        s.applySeam({ ...proj.stab, seam: fix })
        console.log(`Seam fitting rotation [${fix.rot.map((v: number) => v.toFixed(3)).join(', ')}]° edge ${fix.edge.toFixed(3)}° ${(performance.now() - t1).toFixed(0)}ms`)
      }
      // edge0: also apply the edge angle correction [deg] to lens 0 (for verification. Seam fitting corrects only lens 1)
      if (args.edge0 !== undefined) s.rig = s.rig.map((L, k) => (k === 0 ? { ...L, edge: (args.edge0 * Math.PI) / 180 } : L))
      gl.setLenses(s.rig)
      // body: build and use the own-bike seam template (core/bodymap.ts). { source (video to build the template from; this video if omitted), from, to (range to build [s], source time),
      // offset (source time = this video time + offset), inpaint, forceHole, windowSec }. Jobs with bodyOff: true do not use it
      let body: { track: BodyTrack; offset: number } | null = null
      if (args.body) {
        const src = args.body.source ? await Session.open(args.body.source, proj.stab, () => undefined) : s
        if (args.seam && src !== s) src.applySeam({ ...proj.stab, seam: args.seam === 'auto' ? undefined : args.seam })
        const t1 = performance.now()
        const track = await buildBodyTrack(src, { from: args.body.from, to: args.body.to, windowSec: args.body.windowSec, inpaint: args.body.inpaint, forceHole: args.body.forceHole ?? null })
        console.log(`Own-bike seam template ${(performance.now() - t1).toFixed(0)}ms: sections ${track.windows.length}, templates ${track.maps.length}`)
        if (src !== s) await src.close()
        body = { track, offset: args.body.offset ?? 0 }
      }
      for (const job of args.jobs as { t: number; out: string; yaw?: number; pitch?: number; fov?: number; leanRatio?: number; stab?: boolean; rs?: boolean; k?: number; cut?: boolean; rigView?: number[]; rigDown?: number[]; printView?: boolean; seamIters?: number; debug?: number; dynamic?: boolean; seamQ?: number; blend?: number; ground?: boolean }[]) {
        gl.debug = job.debug ?? 0
        gl.dynamicSeam = job.dynamic ?? true
        gl.adaptiveCut = job.cut ?? true
        gl.kOverride = job.k ?? null
        gl.blendDeg = job.blend ?? 12
        const i = Math.round(job.t * s.fps)
        const t2 = performance.now()
        const [f0, f1] = await Promise.all([s.decoders[0].get(i), s.decoders[1].get(i)])
        const t3 = performance.now()
        gl.upload([f0, f1])
        f0.close()
        f1.close()
        s.motion.setStab({ ...proj.stab, enabled: job.stab ?? true, rollingShutter: job.rs ?? proj.stab.rollingShutter })
        const v = { ...viewAt((proj.layers[0] as ViewLayer).keyframes, job.t), ...(job.yaw !== undefined && { yaw: job.yaw }), ...(job.pitch !== undefined && { pitch: job.pitch }), ...(job.fov !== undefined && { fov: job.fov }), ...(job.leanRatio !== undefined && { leanRatio: job.leanRatio }) }
        // rigView: specify the view directly as a rig-coordinate matrix (output camera -> rig, row-major, 9 values) (to reproduce the same direction as the original video in a cut-out video)
        // The rolling shutter correction (rotation during readout) is determined by the gyro alone and does not depend on the mount orientation, so use it as is
        const fm = s.motion.frame(i, v)
        const fp = job.rigView ? { ...fm, view: new Float64Array(job.rigView) } : fm
        if (job.printView) console.log(`View (rig coordinates): ${JSON.stringify(Array.from(fp.view, (x) => Math.round(x * 1e6) / 1e6))} down: ${JSON.stringify(Array.from(s.motion.downInRig(i), (x) => Math.round(x * 1e6) / 1e6))}`)
        // Dynamic stitching: this is a single render, so estimate several times on the same frame to let it settle
        for (let k = 0; k < (gl.dynamicSeam ? (job.seamIters ?? 4) : 1); k++) gl.updateSeam(i + (k % 2), job.ground === false ? null : (job.rigDown ?? s.motion.downInRig(i)))
        const sq = gl.seamDepth()
        if (sq && job.seamQ === undefined) console.log(`Seam distance [m]: ${Array.from(sq, (q) => (q < 0.02 ? '∞' : (1 / q).toFixed(1))).join(' ')}`)
        if (job.seamQ !== undefined) gl.forceSeamQ(job.seamQ)
        if (args.groundDump && gl.lastProbe && gl.seamDepth()) {
          // For verification: per bin, the distance to the ground, the texture, the best-matching candidate, and the chosen distance
          const { cost, texture } = gl.lastProbe
          const { e1, e2 } = seamBasis(s.rig)
          const g = groundPrior(e1, e2, s.motion.downInRig(i), SEAM_BINS)
          const q = gl.seamDepth()!
          const fmt = (v: number): string => (v < 0.02 ? '∞' : (1 / v).toFixed(1))
          for (let b = 0; b < SEAM_BINS; b += 4) {
            let kb = 0
            for (let k = 1; k < SEAM_CAND.length; k++) if (cost[k * SEAM_BINS + b] < cost[kb * SEAM_BINS + b]) kb = k
            console.log(`bin ${b} ground ${fmt(g[b])}m texture ${texture[b].toFixed(2)} best ${fmt(SEAM_CAND[kb])}m(${cost[kb * SEAM_BINS + b].toFixed(2)}) ∞(${cost[b].toFixed(2)}) chosen ${fmt(q[b])}m`)
          }
        }
        if (args.probeBins && gl.lastProbe) {
          const { cost, texture } = gl.lastProbe
          for (const b of args.probeBins as number[]) console.log(`bin ${b} texture ${texture[b].toFixed(2)} mismatch: ${SEAM_CAND.map((q, k) => `${q < 0.02 ? '∞' : (1 / q).toFixed(1)}m=${cost[k * SEAM_BINS + b].toFixed(3)}`).join(' ')}`)
          const cut = gl.seamCut()
          if (cut) for (const b of args.probeBins as number[]) console.log(`bin ${b} mismatch ${cut.ghost[b].toFixed(2)} position ${cut.off[b].toFixed(1)}° width ${cut.width[b].toFixed(2)}  image diff: ${CUT_OFFS.map((o, j) => `${o}°=${gl.lastProbe!.cutDiff[j * SEAM_BINS + b].toFixed(2)}`).join(' ')}${cut.avgDiff ? `  smoothed diff: ${CUT_OFFS.map((o, j) => `${o}°=${cut.avgDiff![j * SEAM_BINS + b].toFixed(2)}`).join(' ')}` : ''}`)
        }
        if (args.pixelBins) {
          // For verification: which seam bin the output pixel [x, y] (top-left origin) falls on (same calculation as main / seamQ in the shader)
          const W = args.width ?? 1920
          const H = args.height ?? 1080
          const f = focalFor(W, v.fov)
          const K = wideK(v.fov)
          const { ax, e1, e2 } = seamBasis(s.rig)
          for (const [x, y] of args.pixelBins as [number, number][]) {
            const qx = (x - W / 2) / f
            const qy = (y - H / 2) / f
            const r = Math.hypot(qx, qy)
            const th = (1 + K) * Math.atan(r / (1 + K))
            const ray = r > 1e-6 ? [(qx / r) * Math.sin(th), (qy / r) * Math.sin(th), Math.cos(th)] : [0, 0, 1]
            const m = fp.view
            const d = [0, 1, 2].map((j) => m[j * 3] * ray[0] + m[j * 3 + 1] * ray[1] + m[j * 3 + 2] * ray[2])
            const dot = (a: ArrayLike<number>): number => a[0] * d[0] + a[1] * d[1] + a[2] * d[2]
            const ph = Math.atan2(dot(e2), dot(e1))
            const bin = (((ph < 0 ? ph + 2 * Math.PI : ph) / (2 * Math.PI)) * SEAM_BINS - 0.5 + SEAM_BINS) % SEAM_BINS
            const fromSeam = 90 - (Math.acos(Math.max(-1, Math.min(1, dot(ax)))) * 180) / Math.PI
            console.log(`pixel (${x}, ${y}) bin ${bin.toFixed(1)} ${fromSeam.toFixed(1)}° from the seam`)
          }
        }
        if (body && !(job as { bodyOff?: boolean }).bodyOff) {
          const ba = bodyAt(body.track, job.t + body.offset)
          gl.setBody(body.track.maps[ba.a] ?? null, body.track.maps[ba.b] ?? null, ba.mix)
        } else gl.setBody(null, null, 0)
        gl.draw({ view: fp.view, rs: fp.rs, hfovDeg: v.fov }, args.width ?? 1920, args.height ?? 1080)
        await saveCanvas(c, job.out)
        console.log(`frame ${i}: decode ${(t3 - t2).toFixed(0)}ms  draw+save ${(performance.now() - t3).toFixed(0)}ms  correction ${fp.correctionDeg.toFixed(2)}°  lean ${s.motion.leanAt(i)?.toFixed(1)}`)
      }
      await s.close()
    } else if (env.autotest === 'band') {
      // Write out band images (own-bike seam template, core/bodymap.ts): ranges = [[start s, end s, count], ...]; keyframes in each range are taken at equal intervals,
      // and the bands of both lenses go to out/<range index>_<image index>_<lens>.png (alpha = whether inside that lens's imaged area)
      const proj = newProject(args.path)
      const s = await Session.open(args.path, proj.stab, (m) => console.log(m))
      if (args.seam) s.applySeam({ ...proj.stab, seam: args.seam })
      const gl = new GlReframer(document.createElement('canvas'))
      gl.setLenses(s.rig)
      const c = new OffscreenCanvas(BAND_W, BAND_H)
      const g = c.getContext('2d')!
      for (const [ri, [a, b, n]] of (args.ranges as [number, number, number][]).entries()) {
        const used = new Set<number>()
        for (let k = 0; k < n; k++) {
          const i = keyframeBefore(s.decoders[0].track, Math.round((a + ((b - a) * (k + 0.5)) / n) * s.fps))
          if (used.has(i)) continue
          used.add(i)
          const [f0, f1] = await Promise.all([s.decoders[0].get(i), s.decoders[1].get(i)])
          gl.upload([f0, f1])
          f0.close()
          f1.close()
          for (const which of [0, 1] as const) {
            const px = gl.renderBand(which)
            g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), BAND_W, BAND_H), 0, 0)
            const blob = await c.convertToBlob({ type: 'image/png' })
            await window.api.writeBinary(`${args.out}/${ri}_${String(k).padStart(2, '0')}_${which}.png`, new Uint8Array(await blob.arrayBuffer()))
          }
          const q = s.mount.fixed ? null : s.mount
          console.log(`range ${ri} image ${k}: frame ${i} (${(i / s.fps).toFixed(1)} s)${q ? '' : ''}`)
        }
      }
      await s.close()
    } else if (env.autotest === 'ui') {
      // Operate the real UI and capture: steps = [{action, ...}, {wait: ms}, {capture: path}, {until: 'loaded'}]
      const st = (): Record<string, unknown> => (window as unknown as { __reframe: Record<string, unknown> }).__reframe ?? {}
      // Confirmation dialogs (e.g. "Collect again?") would block, so answer "Yes" automatically
      window.confirm = () => true
      // Wait until the UI is ready (the mechanism that receives operations). Operations sent earlier would be discarded
      while (!(window as unknown as { __reframe?: unknown }).__reframe) await new Promise((r) => setTimeout(r, 50))
      await new Promise((r) => setTimeout(r, 300))
      for (const step of args.steps as Record<string, unknown>[]) {
        if (step.wait) await new Promise((r) => setTimeout(r, step.wait as number))
        else if (step.until === 'loaded') {
          const t0 = performance.now()
          let lastMsg: unknown = null
          while (!(st().hasSession && !st().loading)) {
            // Print when the loading progress changes (to see where time is spent)
            if (st().loading !== lastMsg) console.log(`  … ${st().loading} (${(performance.now() - t0).toFixed(0)}ms)`)
            lastMsg = st().loading
            await new Promise((r) => setTimeout(r, 100))
          }
          console.log(`Load complete ${(performance.now() - t0).toFixed(0)}ms`, JSON.stringify(st()))
        } else if (step.until === 'frame') {
          // Wait until the specified frame is shown (wait for the seek to finish)
          const t0 = performance.now()
          while (st().frame !== step.frame && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50))
          await new Promise((r) => setTimeout(r, 300))
        } else if (step.until === 'exported') {
          await new Promise((r) => setTimeout(r, 500))
          while (st().exporting) await new Promise((r) => setTimeout(r, 200))
          console.log('Export finished', JSON.stringify(st()))
        } else if (step.until === 'seam') {
          const t0 = performance.now()
          await new Promise((r) => setTimeout(r, 300))
          while (st().seamBusy) await new Promise((r) => setTimeout(r, 100))
          console.log(`Seam ${(performance.now() - t0).toFixed(0)}ms`, JSON.stringify(st().seam))
        } else if (step.until === 'audio') {
          // Wait until the tidied audio is ready
          const t0 = performance.now()
          await new Promise((r) => setTimeout(r, 1500))
          while (!st().audioReady && (st().audioBusy || performance.now() - t0 < 5000)) await new Promise((r) => setTimeout(r, 300))
          console.log(`Tidied audio ${(performance.now() - t0).toFixed(0)}ms`, st().audioReady, st().audioMsg)
        } else if (step.until === 'body') {
          // Wait until the own-bike seam template is ready (the range to build can be limited with bodyRange)
          const t0 = performance.now()
          await new Promise((r) => setTimeout(r, 500))
          while (!st().bodyReady && (st().bodyBusy || performance.now() - t0 < 5000)) await new Promise((r) => setTimeout(r, 200))
          console.log(`Own-bike seam ${(performance.now() - t0).toFixed(0)}ms`, st().bodyReady, st().bodyMsg)
        } else if (step.until === 'bikemask') {
          // Wait until the own-bike mask for the signs is ready
          const t0 = performance.now()
          await new Promise((r) => setTimeout(r, 500))
          while (!st().maskReady && (st().maskBusy || performance.now() - t0 < 5000)) await new Promise((r) => setTimeout(r, 300))
          console.log(`Bike mask ${(performance.now() - t0).toFixed(0)}ms`, st().maskReady)
        } else if (step.segDump) {
          // For checking: save each crop the segmentation model sees, with the outline kept and the bike masks (<path>-<frame>.png)
          ;(globalThis as { __segDump?: unknown }).__segDump = step.segDump
        } else if (step.bikeMaskShow !== undefined) {
          // For checking: show where signs are cut (the same as the switch in the side panel)
          window.dispatchEvent(new CustomEvent('reframe:test', { detail: { action: 'bikeMaskShow', on: !!step.bikeMaskShow } }))
          await new Promise((r) => setTimeout(r, 200))
        } else if (step.bikeMaskDump) {
          // For checking: save the first frame of each stretch with its own-bike mask as PNG (<path>-<stretch>.png)
          ;(globalThis as { __bikeMaskDump?: unknown }).__bikeMaskDump = step.bikeMaskDump
        } else if (step.bodyRange) {
          ;(globalThis as { __bodyRange?: unknown }).__bodyRange = step.bodyRange
        } else if (step.until === 'saved') {
          while (!st().saved) await new Promise((r) => setTimeout(r, 100))
          console.log('Saved', JSON.stringify(st()))
        } else if (step.dragHandle) {
          // Drag a selection box handle (or knob) with synthesized pointer events
          const el = document.querySelector(`[data-handle="${step.dragHandle}"]`) as HTMLElement | null
          if (!el) {
            console.log('Handle not found', step.dragHandle)
            continue
          }
          const b = el.getBoundingClientRect()
          const x0 = b.left + b.width / 2
          const y0 = b.top + b.height / 2
          const opt = { bubbles: true, pointerId: 1, isPrimary: true }
          el.dispatchEvent(new PointerEvent('pointerdown', { ...opt, clientX: x0, clientY: y0 }))
          const N = 5
          for (let k = 1; k <= N; k++) {
            window.dispatchEvent(new PointerEvent('pointermove', { ...opt, clientX: x0 + ((step.dx as number) * k) / N, clientY: y0 + ((step.dy as number) * k) / N }))
            await new Promise((r) => setTimeout(r, 30))
          }
          window.dispatchEvent(new PointerEvent('pointerup', { ...opt, clientX: x0 + (step.dx as number), clientY: y0 + (step.dy as number) }))
          await new Promise((r) => setTimeout(r, 200))
          console.log(`Drag ${step.dragHandle} (${step.dx}, ${step.dy}) →`, JSON.stringify(st().rects))
        } else if (step.print) {
          const x = st()
          console.log(`[${step.print}] frame ${x.frame} playing ${x.playing} fps ${(x.fps as number)?.toFixed(1)} A/V offset ${x.av === null ? '-' : (x.av as number).toFixed(1) + 'ms'} audio ${JSON.stringify(x.audio)} busy seam ${!!x.seamBusy} sound ${!!x.audioBusy} body ${!!x.bodyBusy} plates ${x.plates ?? "-"} ${x.audioMsg ?? ""}`)
        } else if (step.raf) {
          // Number of drawn frames (requestAnimationFrame) in 1 second (to check that the screen is being redrawn)
          let n = 0
          const t0 = performance.now()
          await new Promise<void>((res) => {
            const f = (): void => {
              n++
              if (performance.now() - t0 < 1000) requestAnimationFrame(f)
              else res()
            }
            requestAnimationFrame(f)
            setTimeout(res, 3000)
          })
          console.log(`raf ${step.raf}: ${n} per second  visibility=${document.visibilityState}`)
        } else if (step.dom) {
          // Print the contents (text) and size of an element (for checking the screen)
          const el = document.querySelector(step.dom as string) as HTMLElement | null
          const r = el?.getBoundingClientRect()
          const text = el ? el.innerText.slice(0, 300).split('\n').join(' / ') : ''
          console.log(`dom ${step.dom}: ${el ? `${Math.round(r!.width)}x${Math.round(r!.height)} children ${el.children.length} scrollTop ${el.scrollTop} text "${text}"` : 'none'}`)
        } else if (step.mouse) {
          // Move the real mouse to the middle of an element (selector, k-th) (to check :hover)
          const els = document.querySelectorAll(step.mouse as string)
          let el = els[(step.k as number) ?? 0] as HTMLElement | undefined
          // prev: the element just before it (the item that has a description)
          if (el && step.prev) el = el.previousElementSibling as HTMLElement | undefined
          if (el) {
            el.scrollIntoView({ block: 'center' })
            await new Promise((r) => setTimeout(r, 100))
            const r = el.getBoundingClientRect()
            await window.api.test.mouse(r.left + r.width / 2, r.top + r.height / 2)
            await new Promise((r) => setTimeout(r, 300))
          } else console.log('Element not found', step.mouse)
        } else if (step.hoverScan) {
          // At height y [px] above the element, move the mouse from left to right and print the text where a description ([data-tip]) appears
          const el = document.querySelector(step.hoverScan as string) as HTMLElement | null
          const r = el?.getBoundingClientRect()
          let found = ''
          for (let x = (step.from as number) ?? 0; el && r && x < r.width && !found; x += 2) {
            el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: r.left + x, clientY: r.top + (step.y as number) }))
            await new Promise((res) => setTimeout(res, 0))
            await new Promise((res) => requestAnimationFrame(res))
            const tip = document.querySelector('[data-tip]') as HTMLElement | null
            if (tip) found = `x=${x} "${tip.innerText}"`
          }
          console.log(`hover ${step.hoverScan}: ${found || 'no description'}`)
        } else if (step.scroll) {
          // Scroll until the element is visible
          ;(document.querySelector(step.scroll as string) as HTMLElement | null)?.scrollIntoView({ block: 'start' })
          await new Promise((r) => setTimeout(r, 200))
        } else if (step.storage) {
          // Write a setting remembered on this PC (localStorage). In automated tests it is in the temporary folder, so the usual settings do not change
          for (const [k, v] of Object.entries(step.storage as Record<string, unknown>)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))
        } else if (step.lang) {
          // Switch the UI language ('ja' | 'en')
          setLang(step.lang as Lang)
          await new Promise((r) => setTimeout(r, 300))
        } else if (step.tap) {
          // A click on the preview at a point given as a fraction of the picture [u, v] (e.g. to place a label)
          const c = document.querySelector('.viewer canvas') as HTMLCanvasElement | null
          const r = c?.getBoundingClientRect()
          const [u, v] = step.tap as [number, number]
          if (c && r) {
            const opt = { bubbles: true, pointerId: 1, clientX: r.left + u * r.width, clientY: r.top + v * r.height }
            c.dispatchEvent(new PointerEvent('pointerdown', opt))
            c.dispatchEvent(new PointerEvent('pointerup', opt))
          }
          await new Promise((r) => setTimeout(r, 200))
          console.log(`tap ${u},${v}:`, JSON.stringify(st().labels))
        } else if (step.keyMenu !== undefined) {
          // Right click on the timeline's keyframe row at time keyMenu [s] (whole video shown), then pick step.choice in the menu
          const c = document.querySelector('.timeline canvas') as HTMLCanvasElement | null
          const r = c?.getBoundingClientRect()
          const dur = (st().duration as number) || 1
          if (c && r) {
            const x = r.left + 12 + ((step.keyMenu as number) / dur) * (r.width - 24)
            c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: r.top + 22 }))
          }
          await new Promise((r) => setTimeout(r, 300))
          const b = document.querySelector(`.tl-menu button[data-choice="${step.choice as string}"]`) as HTMLButtonElement | null
          console.log(`keyMenu ${step.keyMenu}: menu ${b ? 'shown' : 'not shown'}`)
          b?.click()
          await new Promise((r) => setTimeout(r, 300))
        } else if (step.until === 'followed') {
          // Wait until no place label is being followed
          const t0 = performance.now()
          await new Promise((r) => setTimeout(r, 300))
          while ((st().following as number) > 0 && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 200))
          console.log(`Followed ${(performance.now() - t0).toFixed(0)}ms`, JSON.stringify(st().labels))
        } else if (step.select) {
          // Choose a value in a <select> (CSS selector) as the user would
          const el = document.querySelector(step.select as string) as HTMLSelectElement | null
          if (!el) console.log('Element not found', step.select)
          else {
            el.value = String(step.value)
            el.dispatchEvent(new Event('change', { bubbles: true }))
            console.log(`select ${step.select} = ${el.value}`)
          }
        } else if (step.dragCanvas) {
          // Drag on the video from (x0, y0) to (x1, y1) [px in the window] with synthesized pointer events
          const [x0, y0, x1, y1] = step.dragCanvas as number[]
          const c = document.querySelector('.viewer canvas') as HTMLCanvasElement
          const opt = { bubbles: true, pointerId: 1, isPrimary: true }
          c.dispatchEvent(new PointerEvent('pointerdown', { ...opt, clientX: x0, clientY: y0 }))
          for (let k = 1; k <= 5; k++) {
            c.dispatchEvent(new PointerEvent('pointermove', { ...opt, clientX: x0 + ((x1 - x0) * k) / 5, clientY: y0 + ((y1 - y0) * k) / 5 }))
            await new Promise((r) => setTimeout(r, 30))
          }
          c.dispatchEvent(new PointerEvent('pointerup', { ...opt, clientX: x1, clientY: y1 }))
        } else if (step.click) {
          ;(document.querySelector(step.click as string) as HTMLElement | null)?.click()
          await new Promise((r) => setTimeout(r, 200))
        } else if (step.seamDebug !== undefined || step.seamCut !== undefined) {
          // Display for checking the rendering (GlReframer.debug. 3 = the blend band) and the switch for the seam-shifting process
          const g = globalThis as { __seamDebug?: number; __seamCut?: boolean }
          if (step.seamDebug !== undefined) g.__seamDebug = step.seamDebug as number
          if (step.seamCut !== undefined) g.__seamCut = step.seamCut as boolean
        } else if (step.key) {
          // Press a key (for checking keyboard operation on the screen)
          window.dispatchEvent(new KeyboardEvent('keydown', { key: step.key as string, bubbles: true }))
          await new Promise((r) => setTimeout(r, 300))
          console.log(`Key ${step.key}:`, JSON.stringify(st().layers))
        } else if (step.capture) {
          await window.api.test.capture(step.capture as string)
          console.log('capture', step.capture, JSON.stringify(st()))
        } else window.dispatchEvent(new CustomEvent('reframe:test', { detail: step }))
      }
    } else if (env.autotest === 'lanes') {
      // Check over the whole video which side of the lane is being ridden, and print the sections that crossed the center line
      const proj = newProject(args.path)
      const s = await Session.open(args.path, args.seam ? { ...proj.stab, seam: args.seam } : proj.stab)
      if (args.log) await s.loadLog(args.log, args.ddf ?? null)
      const t0 = performance.now()
      const samples = await s.scanLanes()
      const fmt = (x: number): string => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`
      console.log(`Lane scan ${samples.length} samples ${((performance.now() - t0) / 1000).toFixed(1)}s  yellow ${samples.filter((x) => x.yellow).length} white ${samples.filter((x) => !x.yellow && x.side !== 0).length} unknown ${samples.filter((x) => x.side === 0).length}`)
      if (args.from !== undefined) for (const x of samples.filter((x) => x.t >= args.from && x.t <= args.to)) console.log(`  ${fmt(x.t)} ${x.side > 0 ? 'Right' : x.side < 0 ? 'Left' : '?'}${x.yellow ? ' (yellow)' : ''}`)
      if (args.dump) await window.api.writeText(args.dump, JSON.stringify(samples))
      for (const c of findLaneCrossings(samples)) console.log(`Crossed section ${fmt(c.start)} to ${fmt(c.end)}`)
      await s.close()
    } else if (env.autotest === 'overtakes') {
      // Look for overtake scenes (lane detection + car detection)
      const proj = newProject(args.path)
      const s = await Session.open(args.path, args.seam ? { ...proj.stab, seam: args.seam } : proj.stab)
      if (args.log) await s.loadLog(args.log, args.ddf ?? null)
      const t0 = performance.now()
      let last = ''
      const r = await s.scanOvertakes((m) => {
        if (m.split(' ')[0] !== last) console.log(`${((performance.now() - t0) / 1000).toFixed(1)}s ${m}`)
        last = m.split(' ')[0]
      }, undefined, (c, x) => console.log(`  decisive ${c.start} to ${c.end}: ${x.t}s azimuth ${x.az.toFixed(0)}° size ${x.size.toFixed(1)}° bottom ${x.low.toFixed(1)}° class ${x.cls} ${x.score.toFixed(2)}`))
      const fmt = (x: number): string => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`
      console.log(`Overtake scan ${((performance.now() - t0) / 1000).toFixed(1)}s`)
      console.log(`Lane-crossing sections: ${r.crossings.map((c) => `${fmt(c.start)} to ${fmt(c.end)}`).join(' ')}`)
      console.log(`Overtakes: ${r.overtakes.map((c) => `${fmt(c.start)} to ${fmt(c.end)}`).join(' ')}`)
      await s.close()
    } else if (env.autotest === 'vehicles') {
      // Look for cars in the keyframes of the given time range and print their direction as seen from the body
      const proj = newProject(args.path)
      const s = await Session.open(args.path, args.seam ? { ...proj.stab, seam: args.seam } : proj.stab)
      if (args.log) await s.loadLog(args.log, args.ddf ?? null)
      const keys = s.keyframeIndices().filter((i) => s.motion.videoTime(i) >= args.from && s.motion.videoTime(i) <= args.to)
      const t0 = performance.now()
      const v = await s.scanVehicles(keys)
      console.log(`Car detection ${keys.length} frames ${((performance.now() - t0) / 1000).toFixed(1)}s`)
      if (args.dump) await window.api.writeText(args.dump, JSON.stringify(v))
      for (const x of v) console.log(`  ${(x.t / 60) | 0}:${(x.t % 60).toFixed(2).padStart(5, '0')} azimuth ${x.az.toFixed(0)}° size ${x.size.toFixed(1)}° bottom ${x.low.toFixed(1)}° class ${x.cls} confidence ${x.score.toFixed(2)}`)
      await s.close()
    } else if (env.autotest === 'encprobe') {
      // Export encoder: check the settings usable on this PC (combinations of size, codec, hardware, bitrate, quality-first)
      const sizes: [number, number][] = args.sizes ?? [[1920, 1080], [3840, 2160], [2160, 3840]]
      const codecs: string[] = args.codecs ?? ['hvc1.1.6.L153.B0', 'hvc1.1.6.L150.B0', 'hvc1.1.6.L156.B0', 'hvc1.2.4.L153.B0', 'hev1.1.6.L153.B0', 'avc1.640033', 'avc1.640034', 'avc1.640028']
      for (const [w, h] of sizes)
        for (const codec of codecs)
          for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software'] as HardwareAcceleration[])
            for (const bitrate of (args.bitrates as number[] | undefined) ?? [40e6, 80e6])
              for (const latencyMode of ['quality', 'realtime'] as LatencyMode[])
              for (const framerate of (args.fps as number[] | undefined) ?? [50]) {
                const cfg = { codec, width: w, height: h, bitrate, framerate, hardwareAcceleration: hw, latencyMode, ...(codec.startsWith('avc') ? { avc: { format: 'avc' } } : {}) } as VideoEncoderConfig
                let ok = false
                try {
                  ok = !!(await VideoEncoder.isConfigSupported(cfg)).supported
                } catch (e) {
                  console.log(`  ${w}x${h} ${codec} ${hw} ${bitrate / 1e6}M ${latencyMode}: exception ${String(e).slice(0, 80)}`)
                }
                if (ok || args.all) console.log(`  ${w}x${h} ${codec} ${hw} ${bitrate / 1e6}M ${latencyMode} ${framerate}fps: ${ok ? 'usable' : '×'}`)
              }
    } else if (env.autotest === 'decodebench') {
      const proj = newProject(args.path)
      const s = await Session.open(args.path, proj.stab)
      const c = document.createElement('canvas')
      const gl = new GlReframer(c)
      gl.setLenses(s.rig)
      for (const ahead of [0, 4, 16]) {
        for (const upload of [false, true]) {
          const i0 = Math.round((args.start ?? 1394) * 50) + ahead * 1000 + (upload ? 300 : 0)
          await Promise.all([s.decoders[0].get(i0), s.decoders[1].get(i0)]).then((fs) => fs.forEach((f) => f.close()))
          const t0 = performance.now()
          const N = 100
          for (let i = i0 + 1; i <= i0 + N; i++) {
            const fs = await Promise.all([s.decoders[0].get(i, ahead), s.decoders[1].get(i, ahead)])
            if (upload) {
              gl.upload([fs[0], fs[1]])
              gl.gl.finish()
            }
            fs.forEach((f) => f.close())
          }
          console.log(`Prefetch ${ahead} transfer ${upload}: ${((N * 1000) / (performance.now() - t0)).toFixed(1)} fps`)
        }
      }
      await s.close()
    } else if (env.autotest === 'export') {
      const proj = newProject(args.path)
      proj.export = { ...proj.export, ...args.export }
      if (args.keyframes) (proj.layers[0] as ViewLayer).keyframes = args.keyframes
      const s = await Session.open(args.path, proj.stab)
      if (args.log) await s.loadLog(args.log, args.ddf ?? null)
      // audioFx: tidy the riding audio and then export ({ on, declip, noiseDb, compThresholdDb })
      if (args.audioFx) {
        const t1 = performance.now()
        await s.setFxAudio(await buildFxAudio(s, { ...DEFAULT_AUDIO_FX, ...args.audioFx }, (f, m) => console.log(`  audio ${((performance.now() - t1) / 1000).toFixed(1)}s ${(f * 100).toFixed(0)}% ${m}`)))
        console.log(`Tidied audio ${((performance.now() - t1) / 1000).toFixed(1)}s ${s.fxAudio?.path}`)
      }
      const ac = new AbortController()
      const t0 = performance.now()
      const r = await exportVideo(s, proj, args.out, (p) => {
        if (p.phase !== 'encode' || p.done % 50 === 0) console.log(`${p.phase} ${p.done}/${p.total} ${p.fps.toFixed(1)}fps`)
      }, ac.signal)
      console.log(`Export complete ${((performance.now() - t0) / 1000).toFixed(1)}s codec=${r.codecUsed} audio=${r.audio} ${r.log ?? ''}`)
      await s.close()
    }
    console.log('AUTOTEST DONE')
  } catch (e) {
    console.error('AUTOTEST FAILED', e instanceof Error ? e.stack : String(e))
  }
  await window.api.test.quit()
}
