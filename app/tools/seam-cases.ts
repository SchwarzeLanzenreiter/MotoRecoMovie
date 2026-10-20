// Builds and renders the collection of lens-seam problem cases (testdata/seam).
//
//   npx tsx tools/seam-cases.ts make [id...]    cuts each case out of its source video (cut-insv.ts) and records the view in the source video (rig coordinates)
//   npx tsx tools/seam-cases.ts render [id...]  renders the cut videos with the recorded views (testdata/seam/out/)
//
// The list of cases is testdata/seam/cases.json. Rendering writes, for each case and view,
//   <id>_<view>.png         rendering by the current app
//   <id>_<view>_nocut.png   rendering without shifting the seam position (no chooseSeamCut)
//   <id>_<view>_band.png    the band where the two lenses are blended, shown in purple
// and an index.html that lays them side by side.
// Views are rendered with the rig-coordinate direction (rigView) and gravity direction (rigDown) found in the source video, so the picture
// is the same as in the source video regardless of the mount estimate (which varies with video length)
// (the same frame of the cut video rendered with the same view differs from the source video by not even one pixel)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { cutInsv } from './cut-insv'

const APP = resolve(import.meta.dirname, '..')
const DIR = resolve(APP, '../testdata/seam')
const CLIP_BEFORE = 3 // length to include before the problem time [s]
const CLIP_LEN = 6 // length to cut out [s]
const BODY_WINDOW = 30 // own-bike seam pattern window [s] (same as BODY_WINDOW_SEC in engine/bodymap.ts)

interface View {
  name: string
  yaw: number
  pitch: number
  fov: number
  leanRatio: number
  rigView?: number[]
  rigDown?: number[]
}
interface Case {
  id: string
  title: string
  source: string
  log?: string
  ddf?: string
  seam: { rot: number[]; edge: number }
  time: number
  views: View[]
  cause: string
  status: string
  clip?: string
  clipTime?: number
}

const casesPath = join(DIR, 'cases.json')
const doc = JSON.parse(readFileSync(casesPath, 'utf-8')) as { about: string; cases: Case[] }

/** Runs the app's autotest (render) and returns its output */
function runRender(args: unknown): string {
  const r = spawnSync(electronPath as unknown as string, ['.'], {
    cwd: APP,
    encoding: 'utf-8',
    timeout: 600_000,
    env: { ...process.env, REFRAME_AUTOTEST: 'render', REFRAME_TEST_ARGS: JSON.stringify(args) }
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  if (/AUTOTEST FAILED/.test(out)) throw new Error(out.split('\n').find((l) => l.includes('AUTOTEST FAILED')))
  return out
}

const [cmd, ...ids] = process.argv.slice(2)
const pick = doc.cases.filter((c) => !ids.length || ids.includes(c.id))

if (cmd === 'make') {
  for (const c of pick) {
    // 1. cut it out
    const clip = `${c.id}.insv`
    const r = await cutInsv(c.source, c.time - CLIP_BEFORE, CLIP_LEN, join(DIR, clip))
    c.clip = clip
    c.clipTime = Math.round((c.time - r.startSec) * 1000) / 1000
    console.log(`${c.id}: ${r.frames} frames from ${r.startSec.toFixed(2)} s of the source; the problem time is at ${c.clipTime} s in the cut video`)
    // 2. find the view in the source video (read the vehicle log; the mount and lean angle come from the whole source video)
    const out = runRender({
      path: c.source,
      ...(c.log && { log: c.log }),
      ...(c.ddf && { ddf: c.ddf }),
      seam: c.seam,
      jobs: c.views.map((v) => ({ t: c.time, out: join(DIR, 'out', `${c.id}_${v.name}_source.png`), yaw: v.yaw, pitch: v.pitch, fov: v.fov, leanRatio: v.leanRatio, printView: true }))
    })
    const lines = [...out.matchAll(/View \(rig coordinates\): (\[[^\]]*\]) down: (\[[^\]]*\])/g)]
    if (lines.length !== c.views.length) throw new Error(`${c.id}: could not read the view\n${out.slice(-2000)}`)
    c.views.forEach((v, k) => {
      v.rigView = JSON.parse(lines[k][1])
      v.rigDown = JSON.parse(lines[k][2])
    })
    writeFileSync(casesPath, JSON.stringify(doc, null, 2) + '\n')
  }
} else if (cmd === 'render') {
  const outDir = join(DIR, 'out')
  mkdirSync(outDir, { recursive: true })
  for (const c of pick) {
    if (!c.clip || !existsSync(join(DIR, c.clip))) throw new Error(`${c.id}: the cut video is missing (run make first)`)
    const jobs = c.views.flatMap((v) => {
      const base = { t: c.clipTime, fov: v.fov, rigView: v.rigView, rigDown: v.rigDown }
      return [
        { ...base, out: join(outDir, `${c.id}_${v.name}.png`) },
        { ...base, out: join(outDir, `${c.id}_${v.name}_nobody.png`), bodyOff: true },
        { ...base, out: join(outDir, `${c.id}_${v.name}_nocut.png`), cut: false, bodyOff: true },
        { ...base, out: join(outDir, `${c.id}_${v.name}_band.png`), debug: 3 }
      ]
    })
    // Own-bike seam pattern (core/bodymap.ts): build it from the source video over the same window as the app (every 30 s from the start of the video)
    const w0 = Math.floor(c.time / BODY_WINDOW) * BODY_WINDOW
    const body = { source: c.source, from: w0, to: w0 + BODY_WINDOW, offset: c.time - (c.clipTime ?? 0) }
    runRender({ path: join(DIR, c.clip), seam: c.seam, body, jobs })
    console.log(`${c.id}: ${jobs.length} images`)
  }
  // HTML for viewing them side by side
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const rows = doc.cases
    .map((c) =>
      c.views
        .map(
          (v) => `<section><h2>${esc(c.title)} (${esc(c.id)} / ${esc(v.name)})</h2>
<p>Source video: ${esc(c.source)} at ${c.time} s / Status: ${esc(c.status)}</p><p>${esc(c.cause)}</p>
<div class="row"><figure><img src="${c.id}_${v.name}.png"><figcaption>Current rendering (with own-bike seam pattern)</figcaption></figure>
<figure><img src="${c.id}_${v.name}_nobody.png"><figcaption>Without own-bike seam pattern</figcaption></figure>
<figure><img src="${c.id}_${v.name}_nocut.png"><figcaption>No pattern, seam not shifted</figcaption></figure>
<figure><img src="${c.id}_${v.name}_band.png"><figcaption>Blend band (purple) / pattern seam (green)</figcaption></figure></div></section>`
        )
        .join('\n')
    )
    .join('\n')
  writeFileSync(
    join(outDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Seam cases</title>
<style>body{font-family:'Yu Gothic UI',sans-serif;background:#16181d;color:#e3e6ec;margin:16px}.row{display:flex;gap:8px;flex-wrap:wrap}figure{margin:0;flex:1;min-width:300px}img{width:100%}figcaption{font-size:12px;color:#9aa1ae}section{margin-bottom:28px}</style>
<h1>Lens seam cases</h1>${rows}`
  )
  console.log(`-> ${join(outDir, 'index.html')}`)
} else {
  console.log('Usage: npx tsx tools/seam-cases.ts make|render [id...]')
  process.exit(1)
}
