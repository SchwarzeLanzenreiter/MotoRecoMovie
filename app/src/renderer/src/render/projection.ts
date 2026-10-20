// 出力画面の投影（シェーダーと空中の標識で共通）。
//
// 画角 135° までは普通の透視投影（直線が直線のまま）。それより広いと、180° にかけて立体射影へ連続的に移る。
// 透視投影は広くなるほど画面の端が引き伸ばされ、立体射影なら 180° 近くまで形が崩れにくいが、画面の中心から離れた直線が弧に曲がる。
//   光軸からの角度 θ と画面上の中心からの距離 r:  r = f·(1+k)·tan(θ / (1+k))
//   k = 0 で透視投影（r = f·tanθ）、k = 1 で立体射影（r = 2f·tan(θ/2)）
// 以前は 120°〜170° で移していたが、よく使う 140°（自動生成の前方）で k = 0.35 になり、画面の左下のトップケースの反射板の線が
// 左右で 57px ずれて段差に見えた（1920 幅）。135°〜180° にして、140° では k = 0.03（線のずれ 7px 程度。端の引き伸ばしは横端で 2.6 倍）、
// 165°（自動生成の側方・後方）では k = 0.74（以前は 0.97）
export const WIDE_FROM = 135
export const WIDE_TO = 180

/** 画角 [deg] から投影の度合い k（0 = 透視投影 … 1 = 立体射影） */
export function wideK(fovDeg: number): number {
  const x = Math.max(0, Math.min(1, (fovDeg - WIDE_FROM) / (WIDE_TO - WIDE_FROM)))
  return x * x * (3 - 2 * x)
}

/** 幅 widthPx の画面で水平画角 fovDeg になる焦点距離 [px] */
export function focalFor(widthPx: number, fovDeg: number, kOverride?: number): number {
  const k = kOverride ?? wideK(fovDeg)
  return widthPx / 2 / ((1 + k) * Math.tan((fovDeg * Math.PI) / 360 / (1 + k)))
}

/** カメラ座標（x 右, y 下, z 前）の点を、画面中心からのずれ [px] へ。写らない向きなら null */
export function projectPoint(p: ArrayLike<number>, focal: number, k: number): [number, number] | null {
  const rxy = Math.hypot(p[0], p[1])
  const th = Math.atan2(rxy, p[2])
  const a = th / (1 + k)
  if (a > Math.PI / 2 - 0.02) return null
  if (rxy < 1e-9) return [0, 0]
  const r = focal * (1 + k) * Math.tan(a)
  return [(p[0] / rxy) * r, (p[1] / rxy) * r]
}
