// 取り付け姿勢の推定（core/motion.ts の estimateMount）: 前後の向きを「曲がる側へ倒れる」関係で決めるので、
// レンズを後ろや横へ向けて付けても前方が分かることを、合成した IMU で確かめる。
// 実行: npx tsx test/mount.test.ts
import assert from 'node:assert/strict'
import { estimateMount, IMU_TO_RIG } from '../src/renderer/src/core/motion'
import type { Imu } from '../src/renderer/src/core/insv'

/** リグ座標の前・上を与えて、左右へ交互に曲がる走行の IMU（1kHz、10 分）を作る */
function ride(fwd: number[], up: number[], seed = 1): Imu {
  const right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]]
  const n = 600_000
  const ts = new Float64Array(n)
  const acc = new Float32Array(n * 3)
  const gyro = new Float32Array(n * 3)
  let r = seed
  const rnd = (): number => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 2
  for (let i = 0; i < n; i++) {
    const t = i / 1000
    ts[i] = t * 1e6
    // 20 秒周期で右・左へ曲がる。ヨー角速度は上から見て反時計回りが正（右へ曲がる間は負）、
    // リーン角はヨーと逆向き（右へ曲がる間は右へ倒れる = 前方の軸まわりに正）
    const w = 2 * Math.PI / 20
    const yaw = -20 * Math.sin(w * t)
    const rollRate = 30 * w * Math.cos(w * t) // リーン角 30·sin(wt) の微分 [deg/s]
    const pitch = 3 * rnd() // サスペンションなどの細かい揺れ
    const g = [0, 1, 2].map((k) => yaw * up[k] + rollRate * fwd[k] + pitch * right[k])
    const a = up
    // リグ座標 → IMU 座標（IMU_TO_RIG の転置）
    for (let k = 0; k < 3; k++) {
      gyro[i * 3 + k] = IMU_TO_RIG[0 * 3 + k] * g[0] + IMU_TO_RIG[1 * 3 + k] * g[1] + IMU_TO_RIG[2 * 3 + k] * g[2]
      acc[i * 3 + k] = IMU_TO_RIG[0 * 3 + k] * a[0] + IMU_TO_RIG[1 * 3 + k] * a[1] + IMU_TO_RIG[2 * 3 + k] * a[2]
    }
  }
  return { ts, acc, gyro }
}
const fwdOf = (R: Float64Array): number[] => [R[2], R[5], R[8]]
const close = (a: number[], b: number[]): boolean => a.every((v, k) => Math.abs(v - b[k]) < 0.05)

// レンズ1（リグの -z）が前: 前の決め方でも今の決め方でも前
{
  const m = estimateMount(ride([0, 0, -1], [0, -1, 0]))
  assert.ok(close(fwdOf(m.R), [0, 0, -1]), `前向き: ${fwdOf(m.R).map((v) => v.toFixed(2))}`)
  assert.equal(m.by, 'lean')
  assert.ok(m.coupling < -0.5)
  assert.equal(m.flippedFromLens, false)
}
// レンズ1 が後ろ（トップケースの後ろから前を撮る付け方）: 前の決め方ではレンズの向き（後ろ）を前にしていた
{
  const m = estimateMount(ride([0, 0, 1], [0, -1, 0]))
  assert.ok(close(fwdOf(m.R), [0, 0, 1]), `後ろ向き: ${fwdOf(m.R).map((v) => v.toFixed(2))}`)
  assert.equal(m.flippedFromLens, true)
}
// レンズが斜め後ろ・本体が横倒し（上 = リグの x 寄り）
{
  const f = [0.6, 0, 0.8]
  const m = estimateMount(ride(f, [0.8, 0, -0.6]))
  assert.ok(close(fwdOf(m.R), f), `斜め: ${fwdOf(m.R).map((v) => v.toFixed(2))}`)
}
console.log('mount.test: OK')

// ---- 取り付け姿勢の時間変化（core/mount.ts）: 走行中にカメラが前後の軸まわりに 60° 回っていっても、時刻ごとの前・上が分かる ----
{
  const { estimateMountTrack, mountFwdAt, mountUpAt } = await import('../src/renderer/src/core/mount')
  // 10 分かけて、カメラが車体の前後軸まわりに 0 → 60° 回る（リグ座標では、車体の上と右が回っていく）。
  // 前方はリグの -z（レンズ1 の向き）
  const n = 600_000
  const ts = new Float64Array(n)
  const acc = new Float32Array(n * 3)
  const gyro = new Float32Array(n * 3)
  let r = 7
  const rnd = (): number => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 2
  const fwd = [0, 0, -1]
  const upAt = (t: number): number[] => {
    const a = ((60 * t) / 600) * (Math.PI / 180)
    return [Math.sin(a), -Math.cos(a), 0] // t = 0 で上 = リグの −y
  }
  for (let i = 0; i < n; i++) {
    const t = i / 1000
    ts[i] = t * 1e6
    const up = upAt(t)
    const right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]]
    const w = (2 * Math.PI) / 20
    const yaw = -20 * Math.sin(w * t)
    const rollRate = 30 * w * Math.cos(w * t) + 0.1 // + カメラが回っていく分（0.1°/s）
    const pitch = 3 * rnd()
    const g = [0, 1, 2].map((k) => yaw * up[k] + rollRate * fwd[k] + pitch * right[k])
    for (let k = 0; k < 3; k++) {
      gyro[i * 3 + k] = IMU_TO_RIG[k] * g[0] + IMU_TO_RIG[3 + k] * g[1] + IMU_TO_RIG[6 + k] * g[2]
      acc[i * 3 + k] = IMU_TO_RIG[k] * up[0] + IMU_TO_RIG[3 + k] * up[1] + IMU_TO_RIG[6 + k] * up[2]
    }
  }
  const tr = estimateMountTrack({ ts, acc, gyro })
  assert.equal(tr.fixed, false, '時間で変わる取り付け姿勢')
  for (const t of [60, 300, 540]) {
    const u = mountUpAt(tr, t * 1e6)
    const f = mountFwdAt(tr, t * 1e6)
    const eu = (Math.acos(Math.min(1, u[0] * upAt(t)[0] + u[1] * upAt(t)[1] + u[2] * upAt(t)[2])) * 180) / Math.PI
    const ef = (Math.acos(Math.min(1, -f[2])) * 180) / Math.PI
    assert.ok(eu < 3 && ef < 3, `${t} 秒: 上のずれ ${eu.toFixed(1)}° 前のずれ ${ef.toFixed(1)}°`)
  }
  // 動かない取り付けなら 1 つの姿勢
  assert.equal(estimateMountTrack(ride([0, 0, -1], [0, -1, 0])).fixed, true)
}
console.log('mount.test（時間変化）: OK')
