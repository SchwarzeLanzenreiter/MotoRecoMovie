// レンズのつなぎ目の問題の場面集（testdata/seam）を作る・描く。
//
//   npx tsx tools/seam-cases.ts make [id...]    元の動画から場面を切り出し（cut-insv.ts）、元の動画での視点（リグ座標）を記録する
//   npx tsx tools/seam-cases.ts render [id...]  切り出した動画を、記録した視点で描く（testdata/seam/out/）
//
// 場面の一覧は testdata/seam/cases.json。描くと、場面・視点ごとに
//   <id>_<視点>.png         今のアプリの描画
//   <id>_<視点>_nocut.png   つなぎ目の位置をずらさない描画（chooseSeamCut なし）
//   <id>_<視点>_band.png    2 つのレンズを混ぜる帯を紫で示したもの
// と、それらを並べた index.html を書く。
// 視点は元の動画で求めたリグ座標の向き（rigView）と重力の向き（rigDown）で描くので、取り付け姿勢の推定（動画の長さで変わる）によらず
// 元の動画と同じ画になる（切り出した動画の同じフレームを同じ視点で描くと、元の動画と 1 画素も違わない）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { cutInsv } from './cut-insv'

const APP = resolve(import.meta.dirname, '..')
const DIR = resolve(APP, '../testdata/seam')
const CLIP_BEFORE = 3 // 問題の時刻の前に含める長さ [s]
const CLIP_LEN = 6 // 切り出す長さ [s]
const BODY_WINDOW = 30 // 自車の継ぎ目の型の区間 [s]（engine/bodymap.ts の BODY_WINDOW_SEC と同じ）

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

/** アプリの自動テスト（render）を動かして、標準出力を返す */
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
    // 1. 切り出す
    const clip = `${c.id}.insv`
    const r = await cutInsv(c.source, c.time - CLIP_BEFORE, CLIP_LEN, join(DIR, clip))
    c.clip = clip
    c.clipTime = Math.round((c.time - r.startSec) * 1000) / 1000
    console.log(`${c.id}: 元の ${r.startSec.toFixed(2)} 秒から ${r.frames} フレーム、問題の時刻は切り出した動画の ${c.clipTime} 秒`)
    // 2. 元の動画で視点を求める（車両ログを読み、取り付け姿勢・リーン角は元の動画全体から）
    const out = runRender({
      path: c.source,
      ...(c.log && { log: c.log }),
      ...(c.ddf && { ddf: c.ddf }),
      seam: c.seam,
      jobs: c.views.map((v) => ({ t: c.time, out: join(DIR, 'out', `${c.id}_${v.name}_source.png`), yaw: v.yaw, pitch: v.pitch, fov: v.fov, leanRatio: v.leanRatio, printView: true }))
    })
    const lines = [...out.matchAll(/視点（リグ座標）: (\[[^\]]*\]) 下向き: (\[[^\]]*\])/g)]
    if (lines.length !== c.views.length) throw new Error(`${c.id}: 視点を読み取れませんでした\n${out.slice(-2000)}`)
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
    if (!c.clip || !existsSync(join(DIR, c.clip))) throw new Error(`${c.id}: 切り出した動画がありません（先に make）`)
    const jobs = c.views.flatMap((v) => {
      const base = { t: c.clipTime, fov: v.fov, rigView: v.rigView, rigDown: v.rigDown }
      return [
        { ...base, out: join(outDir, `${c.id}_${v.name}.png`) },
        { ...base, out: join(outDir, `${c.id}_${v.name}_nobody.png`), bodyOff: true },
        { ...base, out: join(outDir, `${c.id}_${v.name}_nocut.png`), cut: false, bodyOff: true },
        { ...base, out: join(outDir, `${c.id}_${v.name}_band.png`), debug: 3 }
      ]
    })
    // 自車の継ぎ目の型（core/bodymap.ts）: アプリと同じ区間（動画の始まりから 30 秒ごと）を、元の動画から作って使う
    const w0 = Math.floor(c.time / BODY_WINDOW) * BODY_WINDOW
    const body = { source: c.source, from: w0, to: w0 + BODY_WINDOW, offset: c.time - (c.clipTime ?? 0) }
    runRender({ path: join(DIR, c.clip), seam: c.seam, body, jobs })
    console.log(`${c.id}: ${jobs.length} 枚`)
  }
  // 並べて見る HTML
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const rows = doc.cases
    .map((c) =>
      c.views
        .map(
          (v) => `<section><h2>${esc(c.title)}（${esc(c.id)}・${esc(v.name)}）</h2>
<p>元の動画: ${esc(c.source)} の ${c.time} 秒 / 状態: ${esc(c.status)}</p><p>${esc(c.cause)}</p>
<div class="row"><figure><img src="${c.id}_${v.name}.png"><figcaption>今の描画（自車の継ぎ目の型あり）</figcaption></figure>
<figure><img src="${c.id}_${v.name}_nobody.png"><figcaption>自車の継ぎ目の型なし</figcaption></figure>
<figure><img src="${c.id}_${v.name}_nocut.png"><figcaption>型なし・つなぎ目をずらさない</figcaption></figure>
<figure><img src="${c.id}_${v.name}_band.png"><figcaption>混ぜる帯（紫）・型のつなぎ目（緑）</figcaption></figure></div></section>`
        )
        .join('\n')
    )
    .join('\n')
  writeFileSync(
    join(outDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>つなぎ目の場面集</title>
<style>body{font-family:'Yu Gothic UI',sans-serif;background:#16181d;color:#e3e6ec;margin:16px}.row{display:flex;gap:8px;flex-wrap:wrap}figure{margin:0;flex:1;min-width:300px}img{width:100%}figcaption{font-size:12px;color:#9aa1ae}section{margin-bottom:28px}</style>
<h1>レンズのつなぎ目の場面集</h1>${rows}`
  )
  console.log(`→ ${join(outDir, 'index.html')}`)
} else {
  console.log('使い方: npx tsx tools/seam-cases.ts make|render [id...]')
  process.exit(1)
}
