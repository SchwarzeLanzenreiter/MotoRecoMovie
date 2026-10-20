// REFRAME_AUTOTEST 環境変数で起動したときの自動テスト（UI を操作できない環境での確認用）
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
    } else if (env.autotest === 'render') {
      // 指定時刻のフレームを複数の設定で描画して PNG に保存する
      const proj = newProject(args.path)
      const t0 = performance.now()
      const s = await Session.open(args.path, proj.stab, (m) => console.log(m))
      console.log(`Session.open ${(performance.now() - t0).toFixed(0)}ms`)
      if (args.log) {
        const t1 = performance.now()
        const info = await s.loadLog(args.log, args.ddf ?? null)
        console.log(`loadLog ${(performance.now() - t1).toFixed(0)}ms  b=${info.sync.b.toFixed(4)} k=${info.lean.k.toFixed(4)}`)
      }
      // gyroShiftMs: 確認用。フレームの時刻からジャイロの時刻への補正をこれだけずらす（スタビライズの時刻合わせの確認）
      if (args.gyroShiftMs) (s.motion as unknown as { offsetUs: number }).offsetUs += args.gyroShiftMs * 1000
      // imuLean: 車両ログ無しのとき（動画の IMU から推定したリーン角）と同じ条件で描く
      if (args.imuLean) await s.loadImuTelemetry()
      // logOff: ログを読み込んだうえで無効にした状態（取り付け姿勢はログで詰めたもの、リーン角は動画からの推定）
      if (args.logOff) s.setLogEnabled(false)
      const c = document.createElement('canvas')
      const gl = new GlReframer(c)
      // seam: 'auto' = 継ぎ目の合わせ込みを推定して使う、{ rot, edge } = その補正を使う
      if (args.seam) {
        const t1 = performance.now()
        const fix = args.seam === 'auto' ? (await s.estimateSeam()).fix : args.seam
        s.applySeam({ ...proj.stab, seam: fix })
        console.log(`継ぎ目の合わせ込み 回転 [${fix.rot.map((v: number) => v.toFixed(3)).join(', ')}]° 縁 ${fix.edge.toFixed(3)}° ${(performance.now() - t1).toFixed(0)}ms`)
      }
      // edge0: レンズ0 にも縁の角度の補正 [deg] をかける（確認用。継ぎ目の合わせ込みはレンズ1 だけを直す）
      if (args.edge0 !== undefined) s.rig = s.rig.map((L, k) => (k === 0 ? { ...L, edge: (args.edge0 * Math.PI) / 180 } : L))
      gl.setLenses(s.rig)
      // body: 自車の継ぎ目の型（core/bodymap.ts）を作って使う。{ source（型を作る動画。省略でこの動画）, from, to（作る範囲 [s]、source の時刻）,
      // offset（source の時刻 = この動画の時刻 + offset）, inpaint, forceHole, windowSec }。bodyOff: true のジョブは使わない
      let body: { track: BodyTrack; offset: number } | null = null
      if (args.body) {
        const src = args.body.source ? await Session.open(args.body.source, proj.stab, () => undefined) : s
        if (args.seam && src !== s) src.applySeam({ ...proj.stab, seam: args.seam === 'auto' ? undefined : args.seam })
        const t1 = performance.now()
        const track = await buildBodyTrack(src, { from: args.body.from, to: args.body.to, windowSec: args.body.windowSec, inpaint: args.body.inpaint, forceHole: args.body.forceHole ?? null })
        console.log(`自車の継ぎ目の型 ${(performance.now() - t1).toFixed(0)}ms: 区間 ${track.windows.length}、型 ${track.maps.length}`)
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
        // rigView: 視点をリグ座標の行列（出力カメラ → リグ、行優先 9 個）で直接指定する（切り出した動画で元の動画と同じ向きを再現する）
        // ローリングシャッターの補正（読み出し中の回転）はジャイロだけで決まり、取り付け姿勢によらないので、そのまま使う
        const fm = s.motion.frame(i, v)
        const fp = job.rigView ? { ...fm, view: new Float64Array(job.rigView) } : fm
        if (job.printView) console.log(`視点（リグ座標）: ${JSON.stringify(Array.from(fp.view, (x) => Math.round(x * 1e6) / 1e6))} 下向き: ${JSON.stringify(Array.from(s.motion.downInRig(i), (x) => Math.round(x * 1e6) / 1e6))}`)
        // 動的なつなぎ合わせ: 単発の描画なので、同じフレームで数回求めて落ち着かせる
        for (let k = 0; k < (gl.dynamicSeam ? (job.seamIters ?? 4) : 1); k++) gl.updateSeam(i + (k % 2), job.ground === false ? null : (job.rigDown ?? s.motion.downInRig(i)))
        const sq = gl.seamDepth()
        if (sq && job.seamQ === undefined) console.log(`継ぎ目の距離 [m]: ${Array.from(sq, (q) => (q < 0.02 ? '∞' : (1 / q).toFixed(1))).join(' ')}`)
        if (job.seamQ !== undefined) gl.forceSeamQ(job.seamQ)
        if (args.groundDump && gl.lastProbe && gl.seamDepth()) {
          // 確認用: ビンごとの地面までの距離・模様・一致度が最も良い候補・選んだ距離
          const { cost, texture } = gl.lastProbe
          const { e1, e2 } = seamBasis(s.rig)
          const g = groundPrior(e1, e2, s.motion.downInRig(i), SEAM_BINS)
          const q = gl.seamDepth()!
          const fmt = (v: number): string => (v < 0.02 ? '∞' : (1 / v).toFixed(1))
          for (let b = 0; b < SEAM_BINS; b += 4) {
            let kb = 0
            for (let k = 1; k < SEAM_CAND.length; k++) if (cost[k * SEAM_BINS + b] < cost[kb * SEAM_BINS + b]) kb = k
            console.log(`ビン ${b} 地面 ${fmt(g[b])}m 模様 ${texture[b].toFixed(2)} 最良 ${fmt(SEAM_CAND[kb])}m(${cost[kb * SEAM_BINS + b].toFixed(2)}) ∞(${cost[b].toFixed(2)}) 選択 ${fmt(q[b])}m`)
          }
        }
        if (args.probeBins && gl.lastProbe) {
          const { cost, texture } = gl.lastProbe
          for (const b of args.probeBins as number[]) console.log(`ビン ${b} 模様 ${texture[b].toFixed(2)} 不一致: ${SEAM_CAND.map((q, k) => `${q < 0.02 ? '∞' : (1 / q).toFixed(1)}m=${cost[k * SEAM_BINS + b].toFixed(3)}`).join(' ')}`)
          const cut = gl.seamCut()
          if (cut) for (const b of args.probeBins as number[]) console.log(`ビン ${b} 合わない度合い ${cut.ghost[b].toFixed(2)} 位置 ${cut.off[b].toFixed(1)}° 幅 ${cut.width[b].toFixed(2)}  像の差: ${CUT_OFFS.map((o, j) => `${o}°=${gl.lastProbe!.cutDiff[j * SEAM_BINS + b].toFixed(2)}`).join(' ')}${cut.avgDiff ? `  ならした差: ${CUT_OFFS.map((o, j) => `${o}°=${cut.avgDiff![j * SEAM_BINS + b].toFixed(2)}`).join(' ')}` : ''}`)
        }
        if (args.pixelBins) {
          // 確認用: 出力の画素 [x, y]（左上原点）が継ぎ目のどのビンに当たるか（シェーダーの main・seamQ と同じ計算）
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
            console.log(`画素 (${x}, ${y}) ビン ${bin.toFixed(1)} 継ぎ目から ${fromSeam.toFixed(1)}°`)
          }
        }
        if (body && !(job as { bodyOff?: boolean }).bodyOff) {
          const ba = bodyAt(body.track, job.t + body.offset)
          gl.setBody(body.track.maps[ba.a] ?? null, body.track.maps[ba.b] ?? null, ba.mix)
        } else gl.setBody(null, null, 0)
        gl.draw({ view: fp.view, rs: fp.rs, hfovDeg: v.fov }, args.width ?? 1920, args.height ?? 1080)
        await saveCanvas(c, job.out)
        console.log(`frame ${i}: decode ${(t3 - t2).toFixed(0)}ms  draw+save ${(performance.now() - t3).toFixed(0)}ms  補正 ${fp.correctionDeg.toFixed(2)}°  lean ${s.motion.leanAt(i)?.toFixed(1)}`)
      }
      await s.close()
    } else if (env.autotest === 'band') {
      // 帯の画像（自車の継ぎ目の型、core/bodymap.ts）を書き出す: ranges = [[開始 s, 終了 s, 枚数], …] の範囲のキーフレームを等分に、
      // 両レンズの帯を out/<範囲の番号>_<枚目>_<レンズ>.png に（アルファ = そのレンズの写る範囲の内か）
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
          console.log(`範囲 ${ri} 枚目 ${k}: フレーム ${i}（${(i / s.fps).toFixed(1)} 秒）${q ? '' : ''}`)
        }
      }
      await s.close()
    } else if (env.autotest === 'ui') {
      // 実際の画面を操作してキャプチャする: steps = [{action, ...}, {wait: ms}, {capture: path}, {until: 'loaded'}]
      const st = (): Record<string, unknown> => (window as unknown as { __reframe: Record<string, unknown> }).__reframe ?? {}
      // 確認のダイアログ（「集め直しますか？」など）は止まってしまうので、自動で「はい」にする
      window.confirm = () => true
      // 画面の準備（操作を受け取る仕組み）ができるまで待つ。先に送った操作は捨てられてしまう
      while (!(window as unknown as { __reframe?: unknown }).__reframe) await new Promise((r) => setTimeout(r, 50))
      await new Promise((r) => setTimeout(r, 300))
      for (const step of args.steps as Record<string, unknown>[]) {
        if (step.wait) await new Promise((r) => setTimeout(r, step.wait as number))
        else if (step.until === 'loaded') {
          const t0 = performance.now()
          let lastMsg: unknown = null
          while (!(st().hasSession && !st().loading)) {
            // 読み込みの進み具合が変わったら出す（どこで時間がかかっているか分かるように）
            if (st().loading !== lastMsg) console.log(`  … ${st().loading}（${(performance.now() - t0).toFixed(0)}ms）`)
            lastMsg = st().loading
            await new Promise((r) => setTimeout(r, 100))
          }
          console.log(`読み込み完了 ${(performance.now() - t0).toFixed(0)}ms`, JSON.stringify(st()))
        } else if (step.until === 'frame') {
          // 指定したフレームが表示されるまで待つ（シークの完了待ち）
          const t0 = performance.now()
          while (st().frame !== step.frame && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50))
          await new Promise((r) => setTimeout(r, 300))
        } else if (step.until === 'exported') {
          await new Promise((r) => setTimeout(r, 500))
          while (st().exporting) await new Promise((r) => setTimeout(r, 200))
          console.log('書き出し終了', JSON.stringify(st()))
        } else if (step.until === 'seam') {
          const t0 = performance.now()
          await new Promise((r) => setTimeout(r, 300))
          while (st().seamBusy) await new Promise((r) => setTimeout(r, 100))
          console.log(`継ぎ目 ${(performance.now() - t0).toFixed(0)}ms`, JSON.stringify(st().seam))
        } else if (step.until === 'audio') {
          // 整えた音声ができるまで待つ
          const t0 = performance.now()
          await new Promise((r) => setTimeout(r, 1500))
          while (!st().audioReady && (st().audioBusy || performance.now() - t0 < 5000)) await new Promise((r) => setTimeout(r, 300))
          console.log(`整えた音声 ${(performance.now() - t0).toFixed(0)}ms`, st().audioReady, st().audioMsg)
        } else if (step.until === 'body') {
          // 自車の継ぎ目の型ができるまで待つ（作る範囲は bodyRange で限れる）
          const t0 = performance.now()
          await new Promise((r) => setTimeout(r, 500))
          while (!st().bodyReady && (st().bodyBusy || performance.now() - t0 < 5000)) await new Promise((r) => setTimeout(r, 200))
          console.log(`自車の継ぎ目 ${(performance.now() - t0).toFixed(0)}ms`, st().bodyReady, st().bodyMsg)
        } else if (step.bodyRange) {
          ;(globalThis as { __bodyRange?: unknown }).__bodyRange = step.bodyRange
        } else if (step.until === 'saved') {
          while (!st().saved) await new Promise((r) => setTimeout(r, 100))
          console.log('保存済み', JSON.stringify(st()))
        } else if (step.dragHandle) {
          // 選択枠のハンドル（またはつまみ）を合成したポインターイベントでドラッグする
          const el = document.querySelector(`[data-handle="${step.dragHandle}"]`) as HTMLElement | null
          if (!el) {
            console.log('ハンドルが見つかりません', step.dragHandle)
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
          console.log(`ドラッグ ${step.dragHandle} (${step.dx}, ${step.dy}) →`, JSON.stringify(st().rects))
        } else if (step.print) {
          const x = st()
          console.log(`[${step.print}] frame ${x.frame} playing ${x.playing} fps ${(x.fps as number)?.toFixed(1)} 音声とのずれ ${x.av === null ? '-' : (x.av as number).toFixed(1) + 'ms'} 音声 ${JSON.stringify(x.audio)}`)
        } else if (step.raf) {
          // 1 秒間の描画フレーム（requestAnimationFrame）の数（画面が描き変わっているかの確認用）
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
          console.log(`raf ${step.raf}: ${n} 回/秒  visibility=${document.visibilityState}`)
        } else if (step.dom) {
          // 要素の中身（文字）と大きさを出す（画面の確認用）
          const el = document.querySelector(step.dom as string) as HTMLElement | null
          const r = el?.getBoundingClientRect()
          const text = el ? el.innerText.slice(0, 300).split('\n').join(' / ') : ''
          console.log(`dom ${step.dom}: ${el ? `${Math.round(r!.width)}x${Math.round(r!.height)} 子 ${el.children.length} scrollTop ${el.scrollTop} 文字「${text}」` : 'なし'}`)
        } else if (step.mouse) {
          // 本物のマウスを要素（セレクター、k 番目）の真ん中へ動かす（:hover の確認）
          const els = document.querySelectorAll(step.mouse as string)
          let el = els[(step.k as number) ?? 0] as HTMLElement | undefined
          // prev: その要素のすぐ前の要素（説明の付いた項目）
          if (el && step.prev) el = el.previousElementSibling as HTMLElement | undefined
          if (el) {
            el.scrollIntoView({ block: 'center' })
            await new Promise((r) => setTimeout(r, 100))
            const r = el.getBoundingClientRect()
            await window.api.test.mouse(r.left + r.width / 2, r.top + r.height / 2)
            await new Promise((r) => setTimeout(r, 300))
          } else console.log('要素が見つかりません', step.mouse)
        } else if (step.hoverScan) {
          // 要素の上の高さ y [px] で、左から右へマウスを動かし、説明（[data-tip]）が出た所でその文字を出す
          const el = document.querySelector(step.hoverScan as string) as HTMLElement | null
          const r = el?.getBoundingClientRect()
          let found = ''
          for (let x = (step.from as number) ?? 0; el && r && x < r.width && !found; x += 2) {
            el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: r.left + x, clientY: r.top + (step.y as number) }))
            await new Promise((res) => setTimeout(res, 0))
            await new Promise((res) => requestAnimationFrame(res))
            const tip = document.querySelector('[data-tip]') as HTMLElement | null
            if (tip) found = `x=${x} 「${tip.innerText}」`
          }
          console.log(`hover ${step.hoverScan}: ${found || '説明なし'}`)
        } else if (step.scroll) {
          // 要素が見えるところまでスクロールする
          ;(document.querySelector(step.scroll as string) as HTMLElement | null)?.scrollIntoView({ block: 'start' })
          await new Promise((r) => setTimeout(r, 200))
        } else if (step.storage) {
          // このパソコンに覚えておく設定（localStorage）を書く。自動テストでは一時フォルダのものなので普段の設定は変わらない
          for (const [k, v] of Object.entries(step.storage as Record<string, unknown>)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))
        } else if (step.lang) {
          // 画面の言語を切り替える（'ja' | 'en'）
          setLang(step.lang as Lang)
          await new Promise((r) => setTimeout(r, 300))
        } else if (step.click) {
          ;(document.querySelector(step.click as string) as HTMLElement | null)?.click()
          await new Promise((r) => setTimeout(r, 200))
        } else if (step.seamDebug !== undefined || step.seamCut !== undefined) {
          // 画面の描画の確認用の表示（GlReframer.debug。3 = 混ぜる帯）と、つなぎ目をずらす処理の切り替え
          const g = globalThis as { __seamDebug?: number; __seamCut?: boolean }
          if (step.seamDebug !== undefined) g.__seamDebug = step.seamDebug as number
          if (step.seamCut !== undefined) g.__seamCut = step.seamCut as boolean
        } else if (step.key) {
          // キーを押す（画面のキー操作の確認用）
          window.dispatchEvent(new KeyboardEvent('keydown', { key: step.key as string, bubbles: true }))
          await new Promise((r) => setTimeout(r, 300))
          console.log(`キー ${step.key}:`, JSON.stringify(st().layers))
        } else if (step.capture) {
          await window.api.test.capture(step.capture as string)
          console.log('capture', step.capture, JSON.stringify(st()))
        } else window.dispatchEvent(new CustomEvent('reframe:test', { detail: step }))
      }
    } else if (env.autotest === 'lanes') {
      // 車線のどちら側を走っているかを動画全体で調べ、センターラインをまたいだ区間を出す
      const proj = newProject(args.path)
      const s = await Session.open(args.path, args.seam ? { ...proj.stab, seam: args.seam } : proj.stab)
      if (args.log) await s.loadLog(args.log, args.ddf ?? null)
      const t0 = performance.now()
      const samples = await s.scanLanes()
      const fmt = (x: number): string => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`
      console.log(`車線の調査 ${samples.length} 枚 ${((performance.now() - t0) / 1000).toFixed(1)}秒  黄 ${samples.filter((x) => x.yellow).length} 白 ${samples.filter((x) => !x.yellow && x.side !== 0).length} 不明 ${samples.filter((x) => x.side === 0).length}`)
      if (args.from !== undefined) for (const x of samples.filter((x) => x.t >= args.from && x.t <= args.to)) console.log(`  ${fmt(x.t)} ${x.side > 0 ? '右' : x.side < 0 ? '左' : '?'}${x.yellow ? '（黄）' : ''}`)
      if (args.dump) await window.api.writeText(args.dump, JSON.stringify(samples))
      for (const c of findLaneCrossings(samples)) console.log(`またいだ区間 ${fmt(c.start)}〜${fmt(c.end)}`)
      await s.close()
    } else if (env.autotest === 'overtakes') {
      // 追い越しの場面を探す（車線の判定 + 車の検出）
      const proj = newProject(args.path)
      const s = await Session.open(args.path, args.seam ? { ...proj.stab, seam: args.seam } : proj.stab)
      if (args.log) await s.loadLog(args.log, args.ddf ?? null)
      const t0 = performance.now()
      let last = ''
      const r = await s.scanOvertakes((m) => {
        if (m.split(' ')[0] !== last) console.log(m)
        last = m.split(' ')[0]
      }, undefined, (c, x) => console.log(`  決め手 ${c.start}〜${c.end}: ${x.t}s 方位 ${x.az.toFixed(0)}° 大きさ ${x.size.toFixed(1)}° 下端 ${x.low.toFixed(1)}° クラス ${x.cls} ${x.score.toFixed(2)}`))
      const fmt = (x: number): string => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`
      console.log(`追い越しの調査 ${((performance.now() - t0) / 1000).toFixed(1)}秒`)
      console.log(`車線をまたいだ区間: ${r.crossings.map((c) => `${fmt(c.start)}〜${fmt(c.end)}`).join(' ')}`)
      console.log(`追い越し: ${r.overtakes.map((c) => `${fmt(c.start)}〜${fmt(c.end)}`).join(' ')}`)
      await s.close()
    } else if (env.autotest === 'vehicles') {
      // 指定した時刻の範囲のキーフレームで車を探し、車体から見た向きを出す
      const proj = newProject(args.path)
      const s = await Session.open(args.path, args.seam ? { ...proj.stab, seam: args.seam } : proj.stab)
      if (args.log) await s.loadLog(args.log, args.ddf ?? null)
      const keys = s.keyframeIndices().filter((i) => s.motion.videoTime(i) >= args.from && s.motion.videoTime(i) <= args.to)
      const t0 = performance.now()
      const v = await s.scanVehicles(keys)
      console.log(`車の検出 ${keys.length} 枚 ${((performance.now() - t0) / 1000).toFixed(1)}秒`)
      if (args.dump) await window.api.writeText(args.dump, JSON.stringify(v))
      for (const x of v) console.log(`  ${(x.t / 60) | 0}:${(x.t % 60).toFixed(1).padStart(4, '0')} 方位 ${x.az.toFixed(0)}° 大きさ ${x.size.toFixed(1)}° 確からしさ ${x.score.toFixed(2)}`)
      await s.close()
    } else if (env.autotest === 'encprobe') {
      // 書き出しのエンコーダー: この PC で使える設定を調べる（大きさ・コーデック・ハードウェア・ビットレート・画質優先の組み合わせ）
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
                  console.log(`  ${w}x${h} ${codec} ${hw} ${bitrate / 1e6}M ${latencyMode}: 例外 ${String(e).slice(0, 80)}`)
                }
                if (ok || args.all) console.log(`  ${w}x${h} ${codec} ${hw} ${bitrate / 1e6}M ${latencyMode} ${framerate}fps: ${ok ? '使える' : '×'}`)
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
          console.log(`先読み ${ahead} 転送 ${upload}: ${((N * 1000) / (performance.now() - t0)).toFixed(1)} fps`)
        }
      }
      await s.close()
    } else if (env.autotest === 'export') {
      const proj = newProject(args.path)
      proj.export = { ...proj.export, ...args.export }
      if (args.keyframes) (proj.layers[0] as ViewLayer).keyframes = args.keyframes
      const s = await Session.open(args.path, proj.stab)
      if (args.log) await s.loadLog(args.log, args.ddf ?? null)
      // audioFx: 走行中の音を整えてから書き出す（{ on, declip, noiseDb, compThresholdDb }）
      if (args.audioFx) {
        const t1 = performance.now()
        await s.setFxAudio(await buildFxAudio(s, { ...DEFAULT_AUDIO_FX, ...args.audioFx }, (f, m) => console.log(`  音 ${((performance.now() - t1) / 1000).toFixed(1)}s ${(f * 100).toFixed(0)}% ${m}`)))
        console.log(`整えた音声 ${((performance.now() - t1) / 1000).toFixed(1)}s ${s.fxAudio?.path}`)
      }
      const ac = new AbortController()
      const t0 = performance.now()
      const r = await exportVideo(s, proj, args.out, (p) => {
        if (p.phase !== 'encode' || p.done % 50 === 0) console.log(`${p.phase} ${p.done}/${p.total} ${p.fps.toFixed(1)}fps`)
      }, ac.signal)
      console.log(`書き出し完了 ${((performance.now() - t0) / 1000).toFixed(1)}s codec=${r.codecUsed} audio=${r.audio} ${r.log ?? ''}`)
      await s.close()
    }
    console.log('AUTOTEST DONE')
  } catch (e) {
    console.error('AUTOTEST FAILED', e instanceof Error ? e.stack : String(e))
  }
  await window.api.test.quit()
}
