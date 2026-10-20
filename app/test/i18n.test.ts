// 言語の切り替え: t('…') の日本語がすべて英語の辞書にあるか、差し込みの {名前} が一致しているか、
// 画面に出る文字列で t() に包み忘れたものが無いかを確かめる。
// 実行: npx tsx test/i18n.test.ts
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EN_DICT, tr } from '../src/renderer/src/i18n'

const ROOT = join(import.meta.dirname, '../src/renderer/src')
const files: string[] = []
const walk = (d: string): void => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(f) && !p.includes('i18n')) files.push(p)
  }
}
walk(ROOT)
const CJK = /[\u3040-\u30ff\u4e00-\u9fff]/
// コメントを除く（行番号がずれないよう、複数行のコメントは改行だけ残す）
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/^[ \t]*\/\/.*$/gm, '') /* \s だと前の空行の改行まで消える */.replace(/([^:'"`])\/\/[^\n'"`]*$/gm, '$1')
const keys = new Map<string, string>() // 日本語 → 使っているファイル
// t('…') と tr(言語, '…') の第 1 の文字列（' で囲んだもの。\' のエスケープも含む）
const T_RE = new RegExp(String.raw`\bt\(\s*'((?:[^'\\\n]|\\.)*)'`, 'g')
const TR_RE = new RegExp(String.raw`\btr\(\s*[^,()]+,\s*'((?:[^'\\\n]|\\.)*)'`, 'g')
// 改行を LF にそろえて読む（CRLF のままだとコメントを除くときに改行まで消え、行番号がずれる）
const readLf = (f: string): string => readFileSync(f, 'utf-8').replace(/\r\n/g, '\n')
for (const f of files) {
  const s = stripComments(readLf(f))
  for (const m of s.matchAll(T_RE)) keys.set(m[1].replace(/\\'/g, "'"), f)
  for (const m of s.matchAll(TR_RE)) keys.set(m[1].replace(/\\'/g, "'"), f)
}
// 1. 辞書に無いもの
const missing = [...keys.keys()].filter((k) => CJK.test(k) && !(k in EN_DICT))
// 2. 差し込みの名前の不一致
const names = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
const badVars = Object.entries(EN_DICT).filter(([ja, en]) => names(ja) !== names(en))
// 3. 英語に日本語が残っているもの
const jaInEn = Object.entries(EN_DICT).filter(([, en]) => CJK.test(en))
for (const k of missing) console.log(`辞書に無い: 「${k}」（${keys.get(k)!.replace(ROOT, '')}）`)
for (const [ja, en] of badVars) console.log(`差し込みの名前が違う: 「${ja}」→「${en}」`)
for (const [ja, en] of jaInEn) console.log(`英語に日本語が残っている: 「${ja}」→「${en}」`)
// 4. 画面に出る文字列で t() に包み忘れたもの（UI と描画のファイル。ログ・コメント・内容の生成は除く）
const UI_FILES = new RegExp(String.raw`[\\/](ui|render)[\\/]`)
// 文字列リテラル（'…' "…" `…`）と JSX のテキスト（>…<）
const STR_RE = new RegExp(String.raw`'([^'\n]*)'|"([^"\n]*)"|` + '`([^`\\n]*)`' + String.raw`|>([^<>{}\n]+)<`, 'g')
const unwrapped: string[] = []
for (const f of files.filter((f) => UI_FILES.test(f))) {
  const raw = readLf(f)
  const rawLines = raw.split('\n')
  const lines = stripComments(raw).split('\n')
  lines.forEach((ln, i) => {
    // ログと、名前の表など「表示するところで t() に包む」行（// i18n-ignore を付ける）は除く
    if (/console\.(log|warn|error)/.test(ln) || /i18n-ignore/.test(rawLines[i] ?? '')) return
    for (const m of ln.matchAll(STR_RE)) {
      const s = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
      if (!CJK.test(s)) continue
      const before = ln.slice(0, m.index)
      if (/\bt\(\s*$|\btr\(\s*[^,()]+,\s*$/.test(before)) continue
      unwrapped.push(`${f.replace(ROOT, '')}:${i + 1}  ${s.trim().slice(0, 60)}`)
    }
  })
}
for (const u of unwrapped) console.log(`t() に包まれていない: ${u}`)
console.log(`t() のキー ${keys.size} 個 / 辞書 ${Object.keys(EN_DICT).length} 語`)
assert.equal(tr('en', '{n} 件', { n: 3 }), EN_DICT['{n} 件'] ? EN_DICT['{n} 件'].replace('{n}', '3') : '3 件')
assert.deepEqual(missing, [], '辞書に無いものがある')
assert.deepEqual(badVars, [], '差し込みの名前が違うものがある')
assert.deepEqual(jaInEn, [], '英語に日本語が残っているものがある')
assert.deepEqual(unwrapped, [], 't() に包まれていない文字列がある')
// レイヤーの既定の名前は、どちらの言語で作ったものでも今の言語で表示する。自分で付けた名前はそのまま
{
  const { layerName } = await import('../src/renderer/src/ui/layerName')
  const { setLang } = await import('../src/renderer/src/i18n')
  setLang('en')
  assert.equal(layerName('メイン'), EN_DICT['メイン'])
  assert.equal(layerName('サイバー風メーター'), EN_DICT['サイバー風メーター'])
  assert.equal(layerName('視点 3'), EN_DICT['視点 {n}'].replace('{n}', '3'))
  assert.equal(layerName('自分のカメラ'), '自分のカメラ')
  setLang('ja')
  assert.equal(layerName(EN_DICT['メイン']), 'メイン')
  assert.equal(layerName(EN_DICT['自車（挙動の乱れ）']), '自車（挙動の乱れ）')
  assert.equal(layerName('View 2'), '視点 2')
  assert.equal(layerName('My camera'), 'My camera')
}
console.log('i18n.test: OK')
