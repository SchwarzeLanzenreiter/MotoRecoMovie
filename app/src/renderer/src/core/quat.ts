// Small utilities for quaternions and 3×3 matrices.
// Quaternions are [x, y, z, w] (same order as scipy). The composition a*b of rotations applies "b first".

export type Quat = [number, number, number, number]
export type Vec3 = [number, number, number]
/** Row-major 3×3 matrix */
export type Mat3 = Float64Array

export const qIdentity = (): Quat => [0, 0, 0, 1]

export function qMul(a: ArrayLike<number>, b: ArrayLike<number>): Quat {
  const [ax, ay, az, aw] = [a[0], a[1], a[2], a[3]]
  const [bx, by, bz, bw] = [b[0], b[1], b[2], b[3]]
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ]
}

export const qConj = (q: ArrayLike<number>): Quat => [-q[0], -q[1], -q[2], q[3]]

export function qNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3])
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

export function qFromRotvec(x: number, y: number, z: number): Quat {
  const a = Math.hypot(x, y, z)
  if (a < 1e-12) return [x / 2, y / 2, z / 2, 1]
  const s = Math.sin(a / 2) / a
  return [x * s, y * s, z * s, Math.cos(a / 2)]
}

export function qToRotvec(q: ArrayLike<number>): Vec3 {
  let [x, y, z, w] = [q[0], q[1], q[2], q[3]]
  if (w < 0) {
    x = -x
    y = -y
    z = -z
    w = -w
  }
  const s = Math.hypot(x, y, z)
  if (s < 1e-12) return [2 * x, 2 * y, 2 * z]
  const a = 2 * Math.atan2(s, w)
  return [(x / s) * a, (y / s) * a, (z / s) * a]
}

export function qSlerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number): Quat {
  let [bx, by, bz, bw] = [b[0], b[1], b[2], b[3]]
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw
  if (d < 0) {
    d = -d
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  if (d > 0.9995) {
    return qNormalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t])
  }
  const th = Math.acos(d)
  const s = Math.sin(th)
  const wa = Math.sin((1 - t) * th) / s
  const wb = Math.sin(t * th) / s
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb]
}

export function qToMat(q: ArrayLike<number>): Mat3 {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]]
  return new Float64Array([
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
  ])
}

export function matToQ(m: ArrayLike<number>): Quat {
  const tr = m[0] + m[4] + m[8]
  let q: Quat
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    q = [(m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s, s / 4]
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2
    q = [s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s]
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2
    q = [(m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s, (m[2] - m[6]) / s]
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2
    q = [(m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4, (m[3] - m[1]) / s]
  }
  return qNormalize(q)
}

export function qRotate(q: ArrayLike<number>, v: ArrayLike<number>): Vec3 {
  const m = qToMat(q)
  return matVec(m, v)
}

export function matMul(a: ArrayLike<number>, b: ArrayLike<number>): Mat3 {
  const r = new Float64Array(9)
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return r
}

export function matT(a: ArrayLike<number>): Mat3 {
  return new Float64Array([a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]])
}

export function matVec(m: ArrayLike<number>, v: ArrayLike<number>): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ]
}

/** Rotation by angle a [rad] about axis axis (unit vector) */
export const qAxisAngle = (axis: ArrayLike<number>, a: number): Quat => qFromRotvec(axis[0] * a, axis[1] * a, axis[2] * a)

/** Same as scipy's Rotation.from_euler("YX", [yaw, pitch], degrees=True) (intrinsic: Y first, then X) */
export function qYawPitch(yawDeg: number, pitchDeg: number): Quat {
  const r = Math.PI / 180
  return qMul(qFromRotvec(0, yawDeg * r, 0), qFromRotvec(pitchDeg * r, 0, 0))
}
