// Insta360 のレンズモデル（Mei統一球面 + RadtanPro 13項歪み）。
// リグ座標: +x 右, +y 下, +z 前（レンズ0の光軸）。詳細は docs/insv-x6-format.md。
import type { Calibration } from './insv'
import { matMul, matT, type Mat3 } from './quat'

const rx = (a: number): Mat3 => new Float64Array([1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)])
const ry = (a: number): Mat3 => new Float64Array([Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)])
const rz = (a: number): Mat3 => new Float64Array([Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1])

/** メーカー定義の world→camera 回転 */
function vendorRotation(yprDeg: [number, number, number], lensIndex: number, numLenses: number): Mat3 {
  const [yaw, pitch, roll] = yprDeg.map((v) => (v * Math.PI) / 180)
  let r = matMul(matMul(ry(pitch + Math.PI / 2), rz(yaw)), rx(roll))
  if (lensIndex === 0 && numLenses === 2) r = matMul(r, rz(Math.PI))
  return r
}

export interface LensModel {
  xi: number
  fx: number
  fy: number
  cx: number // 映像（ピクチャ）座標での主点
  cy: number
  d: Float64Array
  /** キャリブ空間 → 映像の一様スケール */
  scale: number
  /** リグ座標の光線 → カメラ座標の光線 */
  camFromRig: Mat3
  pictureSize: number
  /**
   * 縁の角度の補正 [rad]（継ぎ目の合わせ込み、core/seamfit.ts）。光軸からの角度 θ を
   * θ + edge·(θ/90°)³ として投影する（中心はほぼそのまま、縁ほど効く）
   */
  edge?: number
  /** レンズの位置 [m]（リグ座標。2 つのレンズの中点が原点）。継ぎ目の視差の補正に使う */
  pos: [number, number, number]
}

/** 縁の角度の補正をカメラ座標の光線にかける（シェーダーの projectLens と同じ式） */
export function edgeCorrect(c: [number, number, number], edge: number): [number, number, number] {
  if (!edge) return c
  const n = Math.hypot(c[0], c[1], c[2])
  const z = c[2] / n
  const rxy = Math.hypot(c[0], c[1]) / n
  if (rxy < 1e-9) return c
  const t = Math.acos(Math.max(-1, Math.min(1, z)))
  const t2 = t + edge * (t / (Math.PI / 2)) ** 3
  const k = Math.sin(t2) / rxy / n
  return [c[0] * k, c[1] * k, Math.cos(t2)]
}

export function makeRig(cal: Calibration, pictureSize: number): LensModel[] {
  const n = cal.lenses.length
  const base = vendorRotation([0, 0, 90], 0, n)
  // レンズの位置: キャリブレーションの tx, ty, tz はレンズ0のカメラ座標（z = 光軸）で表された並進で、
  // 投影の中心はその符号を反転した位置として扱う（レンズ1の投影の中心はレンズ0の光軸方向に 32.8mm 前）。
  // 前玉の配置とは逆に見えるが、魚眼の投影の中心は前玉の位置とは限らない。符号は実データで確かめた:
  // 3:22 の橋の欄干は、この向きでだけ近い距離にすると一致し、逆ではどの距離でも悪化する。
  // リグ座標へは x_rig = (camFromRig0)ᵀ · x_cam0。2 つの中点を原点にする
  const cam0 = matMul(vendorRotation(cal.lenses[0].yprDeg, 0, n), matT(base))
  const posRig = cal.lenses.map((c) => {
    const t = c.tM ?? [0, 0, 0]
    return [0, 1, 2].map((r) => -(cam0[r] * t[0] + cam0[3 + r] * t[1] + cam0[6 + r] * t[2]))
  })
  const mid = [0, 1, 2].map((k) => posRig.reduce((s, p) => s + p[k], 0) / n)
  return cal.lenses.map((c, i) => {
    const frameW = c.width / n
    const scale = pictureSize / frameW
    return {
      xi: c.xi,
      fx: c.fx,
      fy: c.fy,
      cx: c.cx - frameW * i,
      cy: c.cy,
      d: new Float64Array(c.d),
      scale,
      camFromRig: matMul(vendorRotation(c.yprDeg, i, n), matT(base)),
      pictureSize,
      pos: [posRig[i][0] - mid[0], posRig[i][1] - mid[1], posRig[i][2] - mid[2]]
    }
  })
}

/** カメラ座標の光線 → 映像の画素（検証用。描画はシェーダーで同じ式を使う） */
export function projectCam(L: LensModel, c0: [number, number, number]): [number, number] {
  const c = L.edge ? edgeCorrect(c0, L.edge) : c0
  const n = Math.hypot(c[0], c[1], c[2])
  const x = c[0] / n
  const y = c[1] / n
  const z = c[2] / n
  const den = z + L.xi
  const mx = x / den
  const my = y / den
  const d = L.d
  const r2 = mx * mx + my * my
  const r4 = r2 * r2
  const R = 1 + d[0] * r2 + d[1] * r4 + d[2] * r4 * r2 + d[3] * r4 * r4 + d[4] * r4 * r4 * r2
  const a = d[5] + d[7] * r2
  const b = d[6] + d[8] * r2
  const xd = mx * R + (r2 + 2 * mx * mx) * a + 2 * mx * my * b + d[9] * r2 + d[11] * r4
  const yd = my * R + (r2 + 2 * my * my) * b + 2 * mx * my * a + d[10] * r2 + d[12] * r4
  return [(L.fx * xd + L.cx) * L.scale, (L.fy * yd + L.cy) * L.scale]
}
