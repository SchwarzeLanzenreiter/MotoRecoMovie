// 継ぎ目の距離の選び方（動的なつなぎ合わせ）。
//
// GPU で求めた「方位のビン × 距離の候補」ごとの不一致（0 = 完全に一致）から、各ビンの距離を選ぶ。
//   ・模様の少ないビン（空・のっぺりした路面）は一致の度合いが当てにならないので、隣と前のフレームに任せる
//   ・隣どうしで距離が急に変わらないように（継ぎ目に沿って滑らか）
//   ・前のフレームから急に変わらないように（ちらつき防止）。連続したフレームでは少しずつ近づける
//   ・同じくらい一致するなら遠い方（視差の補正が小さい方）を選ぶ
//   ・ただし水平より下を向く方位は、地面より遠くは見えない。地面までの距離（カメラの高さ ÷ 見下ろす角の sin）を
//     その方位の候補に加え、目安にする（地面より遠い候補は強く嫌い、近い候補は一致度がはっきり良いときだけ選ぶ）。
//     カメラを横倒しに付けて継ぎ目が路面を斜めに横切るとき、模様の少ないアスファルトで距離がビンごとにばらつき、
//     白線がギザギザに折れるのを防ぐ
//   ・どの距離でも一致が悪いビンは、一致度の差をその分だけ当てにしない（隣と前のフレームに任せる）。
//     明るい空との境目や、模様の弱いコンクリートなどで、いちばん近い候補だけがたまたま少し良くなることがある。
//     そのビンだけ近い距離になると、継ぎ目から少し離れた所（片方のレンズだけが見える所）の景色がそのビンの幅だけ引っ張られ、
//     壁の縁などのまっすぐな線に小さな三角の段差ができる（そこでは継ぎ目に沿ってぼかした距離を使う。blurSeamQ）

export interface SeamDepthState {
  /** 前のフレームの距離の逆数（ビンごと） */
  q: Float32Array
  frame: number
}

const LAMBDA = 0.025 // 隣のビンとの差の重み（ビンが細かいので弱め。欄干の横木など細いものにも距離を合わせられるように）
const MU = 0.04 // 前のフレームとの差の重み
const FAR_BIAS = 0.01 // 遠い方を好む重み（候補の番号あたり）
const MIN_TEXTURE = 0.04 // これより模様が弱いビンは一致度を使わない
const FOLLOW = 0.15 // 連続したフレームで新しい値へ近づける割合（小さいほどゆっくり変わる。50fps で約 0.3 秒）
/** 路面からカメラまでの高さ [m]（おおよそ。地面までの距離の目安に使う） */
export const SEAM_CAM_HEIGHT = 1.5
const BEYOND_GROUND = 0.5 // 地面より遠い候補の重み（距離の逆数の差あたり。坂や高さの誤差を見込み、地面の 0.8 倍までは許す）
const NEARER_THAN_GROUND = 0.15 // 地面より近い候補の重み（自車・ライダー・すぐ横の物は一致度がはっきり良ければ選ばれる）
// 地面が見えるビンで一致度を使うのは、いちばん良い候補の不一致がこれより小さいときだけ。
// 路面（アスファルト）はレンズの縁で細かい模様がぼけ、どの距離でも一致が悪く（0.3〜0.6）、その差はばらつきでしかない
const GROUND_TRUST = 0.2
/** 継ぎ目から離れた所で使う、継ぎ目に沿ったぼかしの幅（σ、ビンの数。1 ビン = 1.4°） */
export const SEAM_BLUR_SIGMA = 3
// 一致度を当てにする度合い: いちばん良い候補の不一致が TRUST_LO 以下なら全部、TRUST_HI 以上なら使わない（間は直線）。
// 実データでは、はっきり写っている物は 0.2 未満（0919 の欄干 0.05〜0.18、自車 0.01〜0.06）、
// たまたまの一致は 0.24〜0.4（0830 3:04.66 のトンネルの壁の縁）
const TRUST_LO = 0.1
const TRUST_HI = 0.35

/**
 * 方位のビンごとの、地面までの距離の逆数 [1/m]（水平より上は 0）。
 * e1・e2 は継ぎ目の方位の基準（リグ座標）、down は重力の下向き（リグ座標）
 */
export function groundPrior(e1: ArrayLike<number>, e2: ArrayLike<number>, down: ArrayLike<number>, bins: number, camHeight = SEAM_CAM_HEIGHT): Float32Array {
  const out = new Float32Array(bins)
  const c1 = e1[0] * down[0] + e1[1] * down[1] + e1[2] * down[2]
  const c2 = e2[0] * down[0] + e2[1] * down[1] + e2[2] * down[2]
  for (let b = 0; b < bins; b++) {
    const ph = ((b + 0.5) / bins) * Math.PI * 2 // シェーダーのビンの中心と同じ
    out[b] = Math.max(0, Math.cos(ph) * c1 + Math.sin(ph) * c2) / camHeight
  }
  return out
}

/**
 * @param cost ビン b・候補 k の不一致（cost[k * bins + b]、0〜1）
 * @param texture ビンごとの模様の強さ（0〜1）
 * @param cand 候補の距離の逆数 [1/m]（小さい順）
 * @param ground ビンごとの地面までの距離の逆数（groundPrior。null なら使わない）
 */
export function chooseSeamDepth(
  cost: Float32Array,
  texture: Float32Array,
  cand: number[],
  bins: number,
  prev: SeamDepthState | null,
  frame: number,
  ground: Float32Array | null = null
): SeamDepthState {
  const K0 = cand.length
  // 候補: 共通の K0 個 + （地面が見えるビンは）地面までの距離
  const K = K0 + 1
  const candQ = (b: number, k: number): number => (k < K0 ? cand[k] : ground ? ground[b] : 0)
  const continuous = !!prev && Math.abs(frame - prev.frame) === 1
  const qPrev = continuous ? prev!.q : null
  // ビンごとの評価（一致度 + 遠さ・地面の好み + 前のフレームとの差）
  const unary = new Float32Array(bins * K)
  for (let b = 0; b < bins; b++) {
    const g = ground ? ground[b] : 0
    let minCost = Infinity
    for (let k = 0; k < K0; k++) minCost = Math.min(minCost, cost[k * bins + b])
    const textured = texture[b] >= MIN_TEXTURE && !(g > 0 && minCost >= GROUND_TRUST)
    const trust = Math.max(0, Math.min(1, (TRUST_HI - minCost) / (TRUST_HI - TRUST_LO)))
    for (let k = 0; k < K; k++) {
      const q = candQ(b, k)
      if (k === K0 && !(g > 0)) {
        unary[b * K + k] = Infinity // 水平より上: 地面の候補は無い
        continue
      }
      let c: number
      if (!textured || trust === 0) c = 0.5
      else if (k < K0) c = 0.5 + (cost[k * bins + b] - 0.5) * trust
      else {
        // 地面の候補の一致度は、前後の候補から補間する
        let j = 0
        while (j < K0 - 2 && cand[j + 1] < q) j++
        const f = Math.max(0, Math.min(1, (q - cand[j]) / (cand[j + 1] - cand[j])))
        c = 0.5 + (cost[j * bins + b] * (1 - f) + cost[(j + 1) * bins + b] * f - 0.5) * trust
      }
      let u = c
      if (g > 0) u += BEYOND_GROUND * Math.max(0, 0.8 * g - q) + NEARER_THAN_GROUND * Math.max(0, q - g)
      else u += FAR_BIAS * k
      if (qPrev) u += MU * Math.abs(q - qPrev[b])
      unary[b * K + k] = u
    }
  }
  // 最初はビンごとの最小、その後は隣との滑らかさを入れて数回見直す（環状）
  const pick = new Int32Array(bins)
  for (let b = 0; b < bins; b++) {
    let best = 0
    for (let k = 1; k < K; k++) if (unary[b * K + k] < unary[b * K + best]) best = k
    pick[b] = best
  }
  for (let pass = 0; pass < 6; pass++) {
    for (let b = 0; b < bins; b++) {
      const bl = (b + bins - 1) % bins
      const br = (b + 1) % bins
      const l = candQ(bl, pick[bl])
      const r = candQ(br, pick[br])
      let best = pick[b]
      let bestV = Infinity
      for (let k = 0; k < K; k++) {
        const q = candQ(b, k)
        const v = unary[b * K + k] + LAMBDA * (Math.abs(q - l) + Math.abs(q - r))
        if (v < bestV) {
          bestV = v
          best = k
        }
      }
      pick[b] = best
    }
  }
  const q = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    const raw = candQ(b, pick[b])
    q[b] = qPrev ? qPrev[b] + (raw - qPrev[b]) * FOLLOW : raw
  }
  return { q, frame }
}

/**
 * 継ぎ目に沿ってぼかした距離の逆数（環状。ガウスの重み、σ はビンの数）。
 * 継ぎ目から少し離れた所（片方のレンズだけが見える所）の補正に使う。そこではビンごとの距離の差は位置合わせに要らず、
 * そのまま使うと、1 ビンだけ近い距離のとき（細い近い物・たまたまの一致）にまっすぐな線が三角に折れる
 */
export function blurSeamQ(q: Float32Array, sigma = SEAM_BLUR_SIGMA): Float32Array {
  const n = q.length
  const r = Math.ceil(sigma * 2.5)
  const w: number[] = []
  let sw = 0
  for (let j = -r; j <= r; j++) {
    w.push(Math.exp((-0.5 * j * j) / (sigma * sigma)))
    sw += w[j + r]
  }
  const out = new Float32Array(n)
  for (let b = 0; b < n; b++) {
    let a = 0
    for (let j = -r; j <= r; j++) a += w[j + r] * q[(b + j + n) % n]
    out[b] = a / sw
  }
  return out
}

// ---- つなぎ目の位置と切り替えの幅 ----
//
// 2 つのレンズの像は、近い物（ナンバープレート・トップケース・すぐ横の物）では距離をどう合わせても重ならないことがある
// （物によって距離が違う・片方のレンズにだけ写る物がある）。幅の広いクロスフェードのままだと、その物が二重に透けて見える。
// そこで、像が合わない方位では
//   ・切り替えの幅を狭め（二重に見えるのは切り替えの間だけなので）
//   ・つなぎ目の位置を ±8° の範囲で、両レンズの像の差が小さい所（路面など、切り替わっても目立たない所）へずらす
// 像がよく合う方位は、これまでどおり幾何学的な継ぎ目で、幅の広いなめらかな切り替えのまま（明るさや細部の違いが目立たないように）

/** つなぎ目の位置の候補 [deg]（幾何学的な継ぎ目からレンズ0の側へ） */
export const CUT_OFFS = [-8, -6, -4, -2, 0, 2, 4, 6, 8]

export interface SeamCutState {
  /** ビンごとのつなぎ目の位置 [deg] */
  off: Float32Array
  /** ビンごとの切り替えの幅の倍率（1 = 通常） */
  width: Float32Array
  /** ビンごとの「像が合わない」度合い（0〜1。確認用） */
  ghost: Float32Array
  /** 時間でならした像の差（avgDiff[j * bins + b]）と、ならす前の合わない度合い（次のフレームでならすため） */
  avgDiff?: Float32Array
  avgG0?: Float32Array
  frame: number
}

// 像が合わない度合い: 選んだ距離での不一致（相関から。0〜1）と、継ぎ目の位置での像の差（0〜1）の両方が大きいとき
const CUT_M_LO = 0.2
const CUT_M_HI = 0.4
const CUT_D_LO = 0.12
const CUT_D_HI = 0.3
const NARROW = 0.25 // 合わない所の幅の倍率（12° → 3°）
const CUT_CENTER = 0.06 // ずらすほど嫌う重み（8° あたり）
const CUT_KEEP = 0.6 // 像が合う方位を幾何学的な継ぎ目に留める重み（8° あたり）
const CUT_SMOOTH = 0.1 // 隣のビンとの位置の差の重み（2° あたり）。小さいとつなぎ目がジグザグに折れて、物の縁に段差ができる
const CUT_FOLLOW = 0.25 // 連続したフレームで新しい値へ近づける割合
// 像の差と合わない度合いを時間でならす割合（1 フレームに 3%、50fps で約 0.7 秒）。
// つなぎ目の上の近い物（トップケース・ナンバープレート・カメラの台）はカメラと一緒に動くので、良いつなぎ目の位置はほとんど変わらない。
// フレームごとの像の差は、後ろへ流れる路面で揺れ、離れた候補（−8° と +6° など）の間で選び直してしまう。
// 出力の位置だけをならしても、候補の間を行き来する途中でケースの縁やプレートを横切り、走行中にケースの角やプレートの一部がパラパラと欠けて見えた
const CUT_AVG = 0.03

const ramp = (x: number, lo: number, hi: number): number => Math.max(0, Math.min(1, (x - lo) / (hi - lo)))

/**
 * @param diff ビン b・位置の候補 j の像の差（diff[j * bins + b]、0〜1。1 = 写る範囲の外）
 * @param cost 距離の候補ごとの不一致（chooseSeamDepth と同じ）
 * @param q ビンごとに選んだ距離の逆数
 */
export function chooseSeamCut(
  diff: Float32Array,
  cost: Float32Array,
  texture: Float32Array,
  cand: number[],
  q: Float32Array,
  bins: number,
  prev: SeamCutState | null,
  frame: number
): SeamCutState {
  const J = CUT_OFFS.length
  const j0 = CUT_OFFS.indexOf(0)
  const continuous = !!prev && Math.abs(frame - prev.frame) === 1
  // 像の差は時間でならす（写る範囲の外 = 1 は、ならさずにそのフレームの値で判定する）
  const raw = diff
  if (continuous && prev!.avgDiff && prev!.avgDiff.length === raw.length) {
    const a = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) a[i] = prev!.avgDiff[i] + (raw[i] - prev!.avgDiff[i]) * CUT_AVG
    diff = a
  }
  // 像が合わない度合い（ビンごと）
  const g0 = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    // 選んだ距離での不一致（候補の間は補間）
    let k = 0
    while (k < cand.length - 2 && cand[k + 1] < q[b]) k++
    const f = Math.max(0, Math.min(1, (q[b] - cand[k]) / (cand[k + 1] - cand[k])))
    const m = cost[k * bins + b] * (1 - f) + cost[(k + 1) * bins + b] * f
    g0[b] = texture[b] >= MIN_TEXTURE ? ramp(m, CUT_M_LO, CUT_M_HI) * ramp(diff[j0 * bins + b], CUT_D_LO, CUT_D_HI) : 0
    if (continuous && prev!.avgG0) g0[b] = prev!.avgG0[b] + (g0[b] - prev!.avgG0[b]) * CUT_AVG
  }
  // 物の端まで狭くなるよう、隣の 2 ビンへ広げてからぼかす
  const gMax = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    let v = 0
    for (let d = -2; d <= 2; d++) v = Math.max(v, g0[(b + d + bins) % bins])
    gMax[b] = v
  }
  const ghost = blurSeamQ(gMax, 1.5)
  // つなぎ目の位置: ビンの並びに沿った最短経路（像の差 + ずらす量 + 隣との差）
  const unary = (b: number, j: number): number => {
    const o = Math.abs(CUT_OFFS[j]) / 8
    return ghost[b] * diff[j * bins + b] + (CUT_CENTER + CUT_KEEP * (1 - ghost[b])) * o + (raw[j * bins + b] >= 1 ? 10 : 0)
  }
  const acc = new Float32Array(bins * J)
  const from = new Int8Array(bins * J)
  for (let j = 0; j < J; j++) acc[j] = unary(0, j)
  for (let b = 1; b < bins; b++) {
    for (let j = 0; j < J; j++) {
      let best = Infinity
      let bj = 0
      for (let i = 0; i < J; i++) {
        // 隣のビンへ位置を変えるとき、つなぎ目の線はその間の位置を斜めに横切る。その位置の像の差も数える
        // （差の小さい位置が物の上と下に分かれているとき、その間で乗り換えると物（ナンバープレート）を横切って欠けて見えた）
        let cross = 0
        for (let k = Math.min(i, j) + 1; k < Math.max(i, j); k++) cross += 0.5 * (diff[k * bins + b - 1] + diff[k * bins + b])
        const v = acc[(b - 1) * J + i] + (CUT_SMOOTH * Math.abs(CUT_OFFS[j] - CUT_OFFS[i])) / 2 + 0.5 * (ghost[b - 1] + ghost[b]) * cross
        if (v < best) {
          best = v
          bj = i
        }
      }
      acc[b * J + j] = best + unary(b, j)
      from[b * J + j] = bj
    }
  }
  const pick = new Int8Array(bins)
  let last = 0
  for (let j = 1; j < J; j++) if (acc[(bins - 1) * J + j] < acc[(bins - 1) * J + last]) last = j
  pick[bins - 1] = last
  for (let b = bins - 1; b > 0; b--) pick[b - 1] = from[b * J + pick[b]]
  // 選んだ位置を方位に沿って少しならす（つなぎ目の線がなめらかに曲がるように）
  const picked = new Float32Array(bins)
  for (let b = 0; b < bins; b++) picked[b] = CUT_OFFS[pick[b]]
  const offS = blurSeamQ(picked, 1.5)
  const off = new Float32Array(bins)
  const width = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    const o = offS[b]
    const w = 1 - (1 - NARROW) * ghost[b]
    off[b] = continuous ? prev!.off[b] + (o - prev!.off[b]) * CUT_FOLLOW : o
    width[b] = continuous ? prev!.width[b] + (w - prev!.width[b]) * CUT_FOLLOW : w
  }
  return { off, width, ghost, avgDiff: diff, avgG0: g0, frame }
}
