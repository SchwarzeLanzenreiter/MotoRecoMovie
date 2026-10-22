// Display language: checks that every English string in t('…') / tr(lang, '…') has a Japanese translation,
// that the {name} placeholders match, and that no Japanese is left in the source outside the Japanese dictionaries.
// Run: npx tsx test/i18n.test.ts
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { JA_DICT, LANG_NAMES, tr } from '../src/renderer/src/i18n'
import { JA_ENGINE } from '../src/renderer/src/i18n/ja-engine'
import { JA_MENU } from '../src/renderer/src/i18n/ja-menu'
import { JA_PANEL } from '../src/renderer/src/i18n/ja-panel'
import { JA_RENDER } from '../src/renderer/src/i18n/ja-render'
import { JA_UI } from '../src/renderer/src/i18n/ja-ui'

const APP = join(import.meta.dirname, '..')
const ROOT = join(APP, 'src/renderer/src')
const walk = (d: string, out: string[]): string[] => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(f)) out.push(p)
  }
  return out
}
const CJK = /[\u3040-\u30ff\u4e00-\u9fff]/
// Read with LF line endings so that line numbers match
const readLf = (f: string): string => readFileSync(f, 'utf-8').replace(/\r\n/g, '\n')
const isDict = (f: string): boolean => /[\\/]i18n[\\/]ja-\w+\.ts$/.test(f)
const renderer = walk(ROOT, []).filter((f) => !/[\\/]i18n[\\/]/.test(f))
const keys = new Map<string, string>() // English key -> file that uses it
// The first string argument of t('…') and tr(lang, '…') (single quotes, including \' escapes)
const T_RE = new RegExp(String.raw`\bt\(\s*'((?:[^'\\\n]|\\.)*)'`, 'g')
const TR_RE = new RegExp(String.raw`\btr\(\s*[^,()]+,\s*'((?:[^'\\\n]|\\.)*)'`, 'g')
for (const f of renderer) {
  const s = readLf(f)
  for (const m of s.matchAll(T_RE)) keys.set(m[1].replace(/\\'/g, "'"), f)
  for (const m of s.matchAll(TR_RE)) keys.set(m[1].replace(/\\'/g, "'"), f)
}
// 1. Keys without a Japanese translation
const missing = [...keys.keys()].filter((k) => !(k in JA_DICT))
// 2. Placeholder names that differ
const names = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
const badVars = Object.entries(JA_DICT).filter(([en, ja]) => names(en) !== names(ja))
// 3. Japanese left in a key
const jaInKey = Object.keys(JA_DICT).filter((en) => CJK.test(en))
// 4. Japanese anywhere in the committed source outside the Japanese dictionaries
const sources = [...walk(join(APP, 'src'), []), ...walk(join(APP, 'test'), []), ...walk(join(APP, 'tools'), [])].filter((f) => !isDict(f))
const jaInSource: string[] = []
for (const f of sources) {
  // Path regexes that match Japanese file names and test data names are allowed with // i18n-ignore
  readLf(f)
    .split('\n')
    .forEach((ln, i) => {
      if (CJK.test(ln) && !/i18n-ignore/.test(ln)) jaInSource.push(`${f.replace(APP, '')}:${i + 1}  ${ln.trim().slice(0, 60)}`)
    })
}
for (const k of missing) console.log(`No Japanese translation: "${k}" (${keys.get(k)!.replace(ROOT, '')})`)
for (const [en, ja] of badVars) console.log(`Placeholder names differ: "${en}" -> "${ja}"`)
for (const en of jaInKey) console.log(`Japanese in a key: "${en}"`)
for (const s of jaInSource) console.log(`Japanese in source: ${s}`)
console.log(`${keys.size} t() keys / ${Object.keys(JA_DICT).length} dictionary entries`)
assert.equal(tr('ja', 'View {n}', { n: 3 }), JA_DICT['View {n}'].replace('{n}', '3'))
assert.equal(tr('en', 'View {n}', { n: 3 }), 'View 3')
assert.deepEqual(missing, [], 'some keys have no Japanese translation')
assert.deepEqual(badVars, [], 'some placeholder names differ')
assert.deepEqual(jaInKey, [], 'some keys contain Japanese')
assert.deepEqual(jaInSource, [], 'Japanese is left in the source')
// 5. One English key in two dictionaries with different Japanese: the later one in the merge wins and silently changes the other's text
const dicts: [string, Record<string, string>][] = [['ja-ui', JA_UI], ['ja-panel', JA_PANEL], ['ja-render', JA_RENDER], ['ja-engine', JA_ENGINE], ['ja-menu', JA_MENU]]
const clashes: string[] = []
for (let i = 0; i < dicts.length; i++)
  for (let j = i + 1; j < dicts.length; j++)
    for (const [en, ja] of Object.entries(dicts[i][1]))
      if (en in dicts[j][1] && dicts[j][1][en] !== ja) clashes.push(`"${en}": ${dicts[i][0]} "${ja}" vs ${dicts[j][0]} "${dicts[j][1][en]}"`)
for (const c of clashes) console.log(`Dictionary clash: ${c}`)
assert.deepEqual(clashes, [], 'the same English key has different Japanese in two dictionaries')
// The language selector names each language in its own language
assert.deepEqual(LANG_NAMES, [['ja', '日本語'], ['en', 'English']]) // i18n-ignore
// Default layer names are shown in the current language whichever language created them. Custom names stay as they are
{
  const { layerName } = await import('../src/renderer/src/ui/layerName')
  const { setLang } = await import('../src/renderer/src/i18n')
  setLang('en')
  assert.equal(layerName(JA_DICT['Main']), 'Main')
  assert.equal(layerName(JA_DICT['Gauges']), 'Gauges')
  assert.equal(layerName(JA_DICT['View {n}'].replace('{n}', '3')), 'View 3')
  assert.equal(layerName('My camera'), 'My camera')
  setLang('ja')
  assert.equal(layerName('Main'), JA_DICT['Main'])
  assert.equal(layerName('Own bike (disturbance)'), JA_DICT['Own bike (disturbance)'])
  assert.equal(layerName('View 2'), JA_DICT['View {n}'].replace('{n}', '2'))
  assert.equal(layerName('My camera'), 'My camera')
}
console.log('i18n.test: OK')
