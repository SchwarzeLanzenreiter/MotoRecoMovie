// Screenshot file names (engine/screenshot.ts): the video's name and the time in it, without characters Windows does not allow.
// Run: npx tsx test/screenshot.test.ts
import assert from 'node:assert/strict'
import { shotName, shotStamp } from '../src/renderer/src/engine/screenshot'

assert.equal(shotStamp(0), '0m00.000s')
assert.equal(shotStamp(754.5674), '12m34.567s')
assert.equal(shotStamp(3723), '1h02m03.000s')
assert.equal(shotStamp(59.9996), '1m00.000s', 'rounded to the millisecond, carried into the minutes')
assert.equal(shotName('VID_20261011_092151_00_002.insv', 600), 'VID_20261011_092151_00_002_10m00.000s.png')
assert.equal(shotName('VID_20261011_092151_00_002.INSV', 600, 2), 'VID_20261011_092151_00_002_10m00.000s_2.png')
for (const s of [0, 1.5, 754.5674, 3723]) assert.ok(!/[<>:"/\\|?*]/.test(shotName('a.insv', s)), 'allowed in a Windows file name')
console.log('screenshot.test: OK')
