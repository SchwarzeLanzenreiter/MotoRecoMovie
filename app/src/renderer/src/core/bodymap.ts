// 自車の継ぎ目の型（自車の部分を AI で作り込んだ、動画の区間ごとのつなぎ合わせ）。
//
// カメラをトップケースの後ろなどに付けると、トップケース・ナンバープレート・カメラの台が継ぎ目の真上に来る。
// これらは 0.3〜1m と近く、片方のレンズにしか写らない物（カメラの台）もあるので、2 つのレンズの像はどの距離でも合わない。
// フレームごとにつなぎ目の位置や距離を選ぶと、物の一部が欠けたり、走行中にパラパラ動いたりする（docs/insv-x6-format.md）。
//
// ただし、これらはカメラと一緒に動くので、レンズの画像の中では止まっている。そこで区間（約 30 秒）ごとに 1 回だけ時間をかけて:
//   1. 継ぎ目の付近を帯の画像（方位 φ × 光軸からの角度 θ）にして、区間のキーフレームの中央値をとる。走っていれば流れる路面は消え、
//      自車の部分だけが残る（型）。時間で変わらない所 = 自車の部分（MAD が小さい所）
//   2. 2 つのレンズが両方写す重なり（θ 79〜101°）で、レンズ0 の型の各画素がレンズ1 の型のどこに当たるかを
//      AI のオプティカルフロー（NeuFlow v2）で求める。前向きと逆向きのフローが一致する所だけ使い、それ以外はずらさない
//   3. つなぎ目の行を列ごとに、型の像の差が小さい所に決める（パノラマのつなぎ目探しと同じ考え方。90° から離れるほど嫌い、
//      隣の列となめらかに）。どちらの側もそれぞれのレンズで描く（どちらのレンズが正しいかは決めない）
//   4. どちらのレンズでも描けない所（穴）があれば、AI の画像の補完（LaMa / MI-GAN）で埋める
// 毎フレームの描画では、自車の部分はこの対応（つなぎ目とずれ）で、そのときの映像を貼る（明るさや影は、そのときの映像のまま）。
// それ以外（路面・景色）は、これまでどおりフレームごとの距離の推定とつなぎ目の処理で描く。
//
// 帯の座標: 列 x → 方位 φ = (x + 0.5) / BAND_W · 360°（seamBasis の e1 から e2 の向きへ）、
//           行 y → レンズ0 の光軸からの角度 θ = BAND_TH0 + (y + 0.5) · BAND_STEP（継ぎ目は θ = 90°）

/** 帯の大きさ [px] と、1 画素の角度 [deg] */
export const BAND_STEP = 0.15
export const BAND_W = 2400
export const BAND_H = 288
/** 帯の始まりの、レンズ0 の光軸からの角度 [deg]（帯は 68.4〜111.6°） */
export const BAND_TH0 = 90 - (BAND_H * BAND_STEP) / 2

/** 帯の行 y（小数）→ レンズ0 の光軸からの角度 [deg] */
export const bandTheta = (y: number): number => BAND_TH0 + (y + 0.5) * BAND_STEP
/** レンズ0 の光軸からの角度 [deg] → 帯の行（小数） */
export const bandRow = (thetaDeg: number): number => (thetaDeg - BAND_TH0) / BAND_STEP - 0.5

/** オプティカルフローを求める重なりの行（θ 79〜101°）と、モデルの入力の大きさ（NeuFlow v2: 432×768） */
export const OV_Y0 = Math.round((79 - BAND_TH0) / BAND_STEP)
export const OV_Y1 = Math.round((101 - BAND_TH0) / BAND_STEP)
export const FLOW_W = 768
export const FLOW_H = 432

/** レンズが写す範囲の端（レンズ0 はこれより小さい θ、レンズ1 は大きい θ）。つなぎ目はこの内側に置く */
const LENS0_MAX = 99.5
const LENS1_MIN = 80.5

/** 区間ごとの型（レンズごと） */
export interface BandStats {
  /** 中央値の色（RGB, BAND_W×BAND_H×3） */
  med: Uint8Array
  /** 明るさの時間のばらつき（中央値からの差の中央値, 0〜1） */
  mad: Float32Array
  /** そのレンズの写る範囲の内か */
  valid: Uint8Array
  /**
   * 時間で変わらない度合い（0〜1）。模様のある所は、各フレームと型の局所的な相関（7×7、明るさの変化によらない）の中央値で、
   * 模様の無い所は明るさのばらつきの小ささで。明るさのばらつき（mad）だけだと、日の当たり方で明るさの変わるアルミのトップケースを
   * 「変わる」としてしまい、反射板の所でつなぎ目に段差が残った
   */
  stat: Float32Array
}

/** 1 チャンネルの帯の (2r+1) 四方の平均（方位は一周でつながる、行は端で打ち切る） */
function boxBand(a: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(a.length)
  const out = new Float32Array(a.length)
  const n = 2 * r + 1
  for (let y = 0; y < BAND_H; y++) {
    const o = y * BAND_W
    let s = 0
    for (let k = -r; k <= r; k++) s += a[o + ((k + BAND_W) % BAND_W)]
    for (let x = 0; x < BAND_W; x++) {
      tmp[o + x] = s / n
      s += a[o + ((x + r + 1) % BAND_W)] - a[o + ((x - r + BAND_W) % BAND_W)]
    }
  }
  for (let x = 0; x < BAND_W; x++) {
    for (let y = 0; y < BAND_H; y++) {
      let s = 0
      let c = 0
      for (let k = Math.max(0, y - r); k <= Math.min(BAND_H - 1, y + r); k++) {
        s += tmp[k * BAND_W + x]
        c++
      }
      out[y * BAND_W + x] = s / c
    }
  }
  return out
}

const STAT_R = 3 // 局所的な相関の窓（7×7）
const STAT_TEX_LO = 0.01 // 窓の明るさの標準偏差がこれ以下は「模様が無い」、+0.02 で「模様がある」
const STAT_NCC_LO = 0.5 // 相関の中央値がこれ以下は「変わる」、+0.3 で「変わらない」
const STAT_FLAT_MAD = 0.015 // 模様の無い所で、明るさのばらつきがこれより小さければ「変わらない」

/** 時間で変わらない度合い（BandStats.stat）。lums = 各フレームの明るさ（0〜1）、med = その中央値 */
function staticness(lums: Float32Array[], med: Float32Array, mad: Float32Array): Float32Array {
  const N = med.length
  const mm = boxBand(med, STAT_R)
  const sq = new Float32Array(N)
  for (let i = 0; i < N; i++) sq[i] = med[i] * med[i]
  const vm = boxBand(sq, STAT_R)
  for (let i = 0; i < N; i++) vm[i] = Math.max(0, vm[i] - mm[i] * mm[i])
  const nccs = lums.map((l) => {
    const ml = boxBand(l, STAT_R)
    const t = new Float32Array(N)
    for (let i = 0; i < N; i++) t[i] = l[i] * l[i]
    const vl = boxBand(t, STAT_R)
    for (let i = 0; i < N; i++) t[i] = l[i] * med[i]
    const c = boxBand(t, STAT_R)
    const out = new Float32Array(N)
    for (let i = 0; i < N; i++) out[i] = (c[i] - ml[i] * mm[i]) / Math.sqrt(Math.max((vl[i] - ml[i] * ml[i]) * vm[i], 1e-8))
    return out
  })
  const n = lums.length
  const v = new Float32Array(n)
  const stat = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < n; k++) v[k] = nccs[k][i]
    v.sort()
    const ncc = n % 2 ? v[(n - 1) >> 1] : 0.5 * (v[n / 2 - 1] + v[n / 2])
    const tex = Math.min(1, Math.max(0, (Math.sqrt(vm[i]) - STAT_TEX_LO) / 0.02))
    stat[i] = tex * Math.min(1, Math.max(0, (ncc - STAT_NCC_LO) / 0.3)) + (1 - tex) * (mad[i] < STAT_FLAT_MAD ? 1 : 0)
  }
  return stat
}

/** 何枚かの帯の画像（RGBA、アルファ = 写る範囲の内）から、中央値の色と明るさのばらつきを求める */
export function bandStats(frames: ArrayLike<number>[]): BandStats {
  const n = frames.length
  const N = BAND_W * BAND_H
  const med = new Uint8Array(N * 3)
  const mad = new Float32Array(N)
  const valid = new Uint8Array(N)
  const v = new Float32Array(n)
  const lum = new Float32Array(n)
  const sortN = (a: Float32Array): void => {
    for (let i = 1; i < n; i++) {
      const x = a[i]
      let j = i - 1
      while (j >= 0 && a[j] > x) {
        a[j + 1] = a[j]
        j--
      }
      a[j + 1] = x
    }
  }
  const median = (a: Float32Array): number => (n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]))
  for (let p = 0; p < N; p++) {
    valid[p] = frames[0][p * 4 + 3] > 127 ? 1 : 0
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < n; k++) v[k] = frames[k][p * 4 + c]
      sortN(v)
      med[p * 3 + c] = Math.round(median(v))
    }
    for (let k = 0; k < n; k++) lum[k] = (frames[k][p * 4] + frames[k][p * 4 + 1] + frames[k][p * 4 + 2]) / (3 * 255)
    const lm = (() => {
      v.set(lum)
      sortN(v)
      return median(v)
    })()
    for (let k = 0; k < n; k++) v[k] = Math.abs(lum[k] - lm)
    sortN(v)
    mad[p] = median(v)
  }
  // 時間で変わらない度合い（明るさを少しぼかして、カメラの台の揺れによる 1 画素ほどのずれを許す）
  const lums = frames.map((f) => {
    const l = new Float32Array(N)
    for (let p = 0; p < N; p++) l[p] = (f[p * 4] + f[p * 4 + 1] + f[p * 4 + 2]) / (3 * 255)
    return boxBand(l, 1)
  })
  const lmed = new Float32Array(N)
  for (let p = 0; p < N; p++) {
    for (let k = 0; k < n; k++) v[k] = lums[k][p]
    sortN(v)
    lmed[p] = median(v)
  }
  return { med, mad, valid, stat: staticness(lums, lmed, mad) }
}

/** フローのモデルの入力: 型の重なりの行（OV_Y0〜OV_Y1）、列 x0 から FLOW_W 列（一周でつながる）を、縦だけ FLOW_H 行に引き伸ばす（1×3×H×W、0〜1） */
export function flowInput(med: Uint8Array, x0: number): Float32Array {
  const rows = OV_Y1 - OV_Y0
  const out = new Float32Array(3 * FLOW_H * FLOW_W)
  for (let y = 0; y < FLOW_H; y++) {
    const sy = Math.min(rows - 1.001, Math.max(0, ((y + 0.5) * rows) / FLOW_H - 0.5))
    const y0 = Math.floor(sy)
    const fy = sy - y0
    for (let x = 0; x < FLOW_W; x++) {
      const bx = (((x0 + x) % BAND_W) + BAND_W) % BAND_W
      const a = ((OV_Y0 + y0) * BAND_W + bx) * 3
      const b = a + BAND_W * 3
      for (let c = 0; c < 3; c++) out[c * FLOW_H * FLOW_W + y * FLOW_W + x] = (med[a + c] * (1 - fy) + med[b + c] * fy) / 255
    }
  }
  return out
}

/** 帯の画像（Float32 の 1 チャンネル）を (x, y) で双線形に読む（範囲の外は端の値） */
function bil(img: Float32Array, x: number, y: number): number {
  const xc = Math.min(BAND_W - 1.001, Math.max(0, x))
  const yc = Math.min(BAND_H - 1.001, Math.max(0, y))
  const x0 = Math.floor(xc)
  const y0 = Math.floor(yc)
  const ax = xc - x0
  const ay = yc - y0
  const i = y0 * BAND_W + x0
  return img[i] * (1 - ax) * (1 - ay) + img[i + 1] * ax * (1 - ay) + img[i + BAND_W] * (1 - ax) * ay + img[i + BAND_W + 1] * ax * ay
}

/** 1 チャンネルの帯をガウスでぼかす（σ [px]、縦横とも） */
export function blurBand(a: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 2.5)
  const w: number[] = []
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)))
  const tmp = new Float32Array(a.length)
  const out = new Float32Array(a.length)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      let s = 0
      let sw = 0
      for (let k = -r; k <= r; k++) {
        const xx = (((x + k) % BAND_W) + BAND_W) % BAND_W
        s += a[y * BAND_W + xx] * w[k + r]
        sw += w[k + r]
      }
      tmp[y * BAND_W + x] = s / sw
    }
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      let s = 0
      let sw = 0
      for (let k = -r; k <= r; k++) {
        const yy = y + k
        if (yy < 0 || yy >= BAND_H) continue
        s += tmp[yy * BAND_W + x] * w[k + r]
        sw += w[k + r]
      }
      out[y * BAND_W + x] = s / sw
    }
  return out
}

/** 二値の帯を正方形で縮める（erode）・広げる（dilate）。r [px] */
function morph(a: Uint8Array, r: number, dilate: boolean): Uint8Array {
  const tmp = new Uint8Array(a.length)
  const out = new Uint8Array(a.length)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      let v = dilate ? 0 : 1
      for (let k = -r; k <= r; k++) {
        const b = a[y * BAND_W + ((((x + k) % BAND_W) + BAND_W) % BAND_W)]
        v = dilate ? v | b : v & b
      }
      tmp[y * BAND_W + x] = v
    }
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      let v = dilate ? 0 : 1
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(BAND_H - 1, Math.max(0, y + k))
        const b = tmp[yy * BAND_W + x]
        v = dilate ? v | b : v & b
      }
      out[y * BAND_W + x] = v
    }
  return out
}

/** フローのモデルの出力（1×2×FLOW_H×FLOW_W, 単位はモデルの入力の画素）を、列 x0 から始まる帯の重なりの行へ戻して足し込む */
export function flowToBand(flow: Float32Array, x0: number, fx: Float32Array, fy: Float32Array, wsum: Float32Array): void {
  const rows = OV_Y1 - OV_Y0
  const S = rows / FLOW_H
  for (let y = OV_Y0; y < OV_Y1; y++) {
    const sy = Math.min(FLOW_H - 1, Math.max(0, Math.round((y - OV_Y0 + 0.5) / S - 0.5)))
    for (let x = 0; x < FLOW_W; x++) {
      // タイルの端ほど軽く（隣のタイルと重なる所で、真ん中に近い方を使う）
      const w = 1e-3 + Math.min(x + 1, FLOW_W - x)
      const bx = (((x0 + x) % BAND_W) + BAND_W) % BAND_W
      const i = y * BAND_W + bx
      fx[i] += flow[sy * FLOW_W + x] * w
      fy[i] += flow[FLOW_H * FLOW_W + sy * FLOW_W + x] * S * w
      wsum[i] += w
    }
  }
}

/** 区間の自車の継ぎ目（描画に渡す値。どれも BAND_W×BAND_H） */
export interface BodyStitch {
  /** 自車の部分の度合い（0〜1。1 = この型で描く、0 = これまでの処理で描く） */
  m: Float32Array
  /** レンズ1 で描く割合（0 = レンズ0、1 = レンズ1。つなぎ目で 0.6° かけて切り替える） */
  w1: Float32Array
  /** レンズ1 を読む位置のずれ [帯の画素]（列・行）。つなぎ目から離れるほど 0 へ */
  dx: Float32Array
  dy: Float32Array
  /** つなぎ目の行（列ごと、確認用） */
  cut: Float32Array
}

const FB_OK = 2 // 前向きと逆向きのフローの食い違いがこれ以下なら信頼する [px]
const CUT_RES = 3 // つなぎ目の行の、像の差の重み
const CUT_CENTER = 0.04 // 90° から離れるほど嫌う重み（1° あたり）
const CUT_SMOOTH = 0.2 // 隣の列との行の差の重み（1 行あたり）
const CUT_UNALIGNED = 0.01 // レンズ1 で描く、合わせられない自車の部分の重み（1 行あたり）
const WARP_DECAY = 40 // 重なりの外で、レンズ1 のずれをこの行数（6°）で弱める
const BLEND_ROWS = 4 // つなぎ目の切り替えの幅 [行]（0.6°）

/**
 * 型とフローから、区間の自車の継ぎ目を決める。
 * fwd = レンズ0 → レンズ1 のフロー、bwd = レンズ1 → レンズ0 のフロー（どちらも flowToBand で帯へ戻して重みで割ったもの。重なりの行の外は 0）
 */
export function buildStitch(s0: BandStats, s1: BandStats, fwd: { fx: Float32Array; fy: Float32Array }, bwd: { fx: Float32Array; fy: Float32Array }): BodyStitch {
  const N = BAND_W * BAND_H
  // 信頼できるフローだけ使う: 前後のフローが FB_OK 以内で一致し、重なりの行の中。それ以外は 0（ずらさない）。なめらかにつなぐ
  const conf = new Float32Array(N)
  for (let y = OV_Y0; y < OV_Y1; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      const ex = fwd.fx[i] + bil(bwd.fx, x + fwd.fx[i], y + fwd.fy[i])
      const ey = fwd.fy[i] + bil(bwd.fy, x + fwd.fx[i], y + fwd.fy[i])
      conf[i] = Math.hypot(ex, ey) < FB_OK ? 1 : 0
    }
  const cb = blurBand(conf, 4)
  const wx = new Float32Array(N)
  const wy = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    wx[i] = fwd.fx[i] * conf[i]
    wy[i] = fwd.fy[i] * conf[i]
  }
  const bx = blurBand(wx, 4)
  const by = blurBand(wy, 4)
  const fx = new Float32Array(N)
  const fy = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const k = Math.min(1, cb[i] * 2) / Math.max(cb[i], 1e-3)
    fx[i] = bx[i] * k
    fy[i] = by[i] * k
  }
  // 型の像の差（レンズ1 をずらして重ねたとき）と、合わない所
  const lum0 = new Float32Array(N)
  const lum1 = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    lum0[i] = (s0.med[i * 3] + s0.med[i * 3 + 1] + s0.med[i * 3 + 2]) / (3 * 255)
    lum1[i] = (s1.med[i * 3] + s1.med[i * 3 + 1] + s1.med[i * 3 + 2]) / (3 * 255)
  }
  const res = new Float32Array(N)
  for (let y = OV_Y0; y < OV_Y1; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      res[i] = Math.abs(lum0[i] - bil(lum1, x + fx[i], y + fy[i]))
    }
  // つなぎ目の行の費用: 縦 7 行・横 3 列の平均の像の差
  const rb = new Float32Array(N)
  for (let y = OV_Y0; y < OV_Y1; y++)
    for (let x = 0; x < BAND_W; x++) {
      let s = 0
      let c = 0
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy
          if (yy < OV_Y0 || yy >= OV_Y1) continue
          s += res[yy * BAND_W + ((x + dx + BAND_W) % BAND_W)]
          c++
        }
      rb[y * BAND_W + x] = s / c
    }
  // 自車の部分: どちらかのレンズで時間で変わらない所。小さな点を消して広げ、ぼかす
  let st: Uint8Array = new Uint8Array(N)
  for (let i = 0; i < N; i++) st[i] = (s0.valid[i] && s0.stat[i] > 0.5) || (s1.valid[i] && s1.stat[i] > 0.5) ? 1 : 0
  // 小さな点（たまたま型と似た路面など）を消してから、すき間（物の縁など）を埋め、少し広げる
  st = morph(morph(st, 2, false), 2, true)
  st = morph(morph(st, 3, true), 3, false)
  st = morph(st, 6, true)
  const stf = new Float32Array(N)
  for (let i = 0; i < N; i++) stf[i] = st[i]
  const m = blurBand(stf, 3)
  const c0 = Math.ceil(bandRow(LENS1_MIN))
  const c1 = Math.floor(bandRow(LENS0_MAX))
  const J = c1 - c0 + 1
  // レンズ1 で描く自車の部分のうち、フローで合わせられない（信頼できない）所の行数。レンズ0 はずらさない基準なので、
  // 合わせられない所はレンズ0 が写せる限りレンズ0 で描く（すぐ近くのトップケースは 2 つのレンズで見える角度が大きく違い、
  // レンズ1 の側へつなぎ目を置くと、反射板のような直線がつなぎ目で折れて見えた）
  const un = new Float32Array(N)
  for (let x = 0; x < BAND_W; x++) {
    let acc = 0
    for (let y = c1; y >= c0; y--) {
      const i = y * BAND_W + x
      acc += m[i] * (1 - Math.min(1, cb[i] * 2))
      un[i] = acc
    }
  }
  const cost = (x: number, j: number): number => CUT_RES * rb[(c0 + j) * BAND_W + x] + CUT_CENTER * Math.abs(bandTheta(c0 + j) - 90) + CUT_UNALIGNED * un[(c0 + j) * BAND_W + x]
  // 列に沿った最短経路（行の差は CUT_SMOOTH/行）。一周のつながりは、2 周して後半を使う
  const acc = new Float32Array(J)
  const from = new Int16Array(BAND_W * 2 * J)
  for (let j = 0; j < J; j++) acc[j] = cost(0, j)
  const best = new Float32Array(J)
  const arg = new Int16Array(J)
  for (let xx = 1; xx < BAND_W * 2; xx++) {
    const x = xx % BAND_W
    for (let j = 0; j < J; j++) {
      best[j] = acc[j]
      arg[j] = j
    }
    for (let j = 1; j < J; j++)
      if (best[j - 1] + CUT_SMOOTH < best[j]) {
        best[j] = best[j - 1] + CUT_SMOOTH
        arg[j] = arg[j - 1]
      }
    for (let j = J - 2; j >= 0; j--)
      if (best[j + 1] + CUT_SMOOTH < best[j]) {
        best[j] = best[j + 1] + CUT_SMOOTH
        arg[j] = arg[j + 1]
      }
    for (let j = 0; j < J; j++) {
      acc[j] = best[j] + cost(x, j)
      from[xx * J + j] = arg[j]
    }
  }
  let jb = 0
  for (let j = 1; j < J; j++) if (acc[j] < acc[jb]) jb = j
  const cutRaw = new Float32Array(BAND_W)
  for (let xx = BAND_W * 2 - 1; xx >= BAND_W; xx--) {
    cutRaw[xx % BAND_W] = c0 + jb
    jb = from[xx * J + jb]
  }
  // 列に沿って少しならす（σ 3 列）
  const cut = new Float32Array(BAND_W)
  for (let x = 0; x < BAND_W; x++) {
    let s = 0
    let sw = 0
    for (let k = -8; k <= 8; k++) {
      const w = Math.exp(-(k * k) / 18)
      s += cutRaw[(x + k + BAND_W) % BAND_W] * w
      sw += w
    }
    cut[x] = s / sw
  }
  const w1 = new Float32Array(N)
  const dx = new Float32Array(N)
  const dy = new Float32Array(N)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      w1[i] = Math.min(1, Math.max(0, (y - cut[x]) / BLEND_ROWS + 0.5))
      // ずれは、つなぎ目からの距離ではなく、フローを信頼できる所ではそのまま使う（物全体を同じように合わせるので、直線が折れない）。
      // つなぎ目から離れるほど弱めると、反射板のような直線がつなぎ目のすぐ先で折れ、長く伸ばすと関係ない所までずれて別の物が写り込んだ。
      // 重なりの外（レンズ1 だけが写す θ > 101°）は、端の値から WARP_DECAY 行で 0 へ
      const yy = Math.min(y, OV_Y1 - 1)
      const k = Math.exp(-Math.max(0, y - cut[x]) / WARP_DECAY)
      dx[i] = fx[yy * BAND_W + x] * k
      dy[i] = fy[yy * BAND_W + x] * k
    }
  return { m, w1, dx, dy, cut }
}

// ---- 穴（どちらのレンズでも描けない所）----
//
// つなぎ目のこちら側を描くレンズが、そこを写す範囲の外のとき（もう一方のレンズの範囲の中へつなぎ目を寄せられない所）。
// AI の画像の補完で、型を埋めた色を使う。
// 「暗く・時間で変わらず・模様が無い所を、手前をふさぐ物（カメラの台）とみなして穴にする」も試したが、
// トップケースの黒い縁やライダーの黒いズボンまで穴にして消してしまったのでやめた。手元の動画（トップケースの後ろの台）では、
// レンズ1 の台はいつもレンズ0 の側（θ < 90°）にあり、レンズ0 で描くので穴は出ない

/** 型とつなぎ目から穴を探す（1 = 穴）。force は確認用（この矩形 [x0, y0, x1, y1] の自車の部分を穴にする） */
export function findHoles(s0: BandStats, s1: BandStats, st: BodyStitch, force: number[] | null = null): Uint8Array {
  const N = BAND_W * BAND_H
  const h = new Uint8Array(N)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      if (st.m[i] < 0.5) continue
      if (force && x >= force[0] && x < force[2] && y >= force[1] && y < force[3]) h[i] = 1
      else if (!(st.w1[i] > 0.5 ? s1 : s0).valid[i] && !(st.w1[i] > 0.5 ? s0 : s1).valid[i]) h[i] = 1
    }
  return h.some((v) => v) ? morph(h, 2, true) : h
}

/** 型をつなぎ目で合わせた色（RGB、穴を埋める入力）。レンズ1 はずれの分ずらして読む */
export function stitchedTemplate(s0: BandStats, s1: BandStats, st: BodyStitch): Uint8Array {
  const N = BAND_W * BAND_H
  const out = new Uint8Array(N * 3)
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(N)
    for (let i = 0; i < N; i++) a[i] = s1.med[i * 3 + c]
    return a
  })
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      for (let c = 0; c < 3; c++) {
        const v1 = bil(ch[c], x + st.dx[i], y + st.dy[i])
        out[i * 3 + c] = Math.round(s0.med[i * 3 + c] * (1 - st.w1[i]) + v1 * st.w1[i])
      }
    }
  return out
}

// ---- 動画の区間ごとの型 ----

/** 区間の自車の継ぎ目を、自車の部分の列だけ切り出して小さくしたもの（保存・描画用） */
export interface BodyMapC {
  /** 切り出した列の始まり（一周でつながる）と列の数。行は全部（BAND_H） */
  x0: number
  w: number
  /** 自車の部分の度合い・レンズ1 の割合（0〜255）、レンズ1 のずれ（1/64 画素） */
  m: Uint8Array
  w1: Uint8Array
  dx: Int16Array
  dy: Int16Array
  /** 穴を埋めた色（RGBA、アルファ = 穴の度合い）。穴が無ければ省く */
  fill?: Uint8Array
}

/** 区間 [t0, t1) [s] と、その区間の型（maps の番号。−1 = 自車の部分が無い・作れなかった） */
export interface BodyWindow {
  t0: number
  t1: number
  map: number
}

export interface BodyTrack {
  windows: BodyWindow[]
  maps: BodyMapC[]
}

/** 自車の部分の列だけ切り出す（自車の部分が無ければ null） */
export function compactStitch(st: BodyStitch, holes: Uint8Array | null, fill: Uint8Array | null): BodyMapC | null {
  const col = new Uint8Array(BAND_W)
  for (let y = 0; y < BAND_H; y++) for (let x = 0; x < BAND_W; x++) if (st.m[y * BAND_W + x] > 0.004) col[x] = 1
  // 自車の部分が無い列のいちばん長い並びを除いた、残りの弧
  let bestLen = -1
  let bestStart = 0
  for (let x = 0; x < BAND_W; x++) {
    if (col[x] || !col[(x - 1 + BAND_W) % BAND_W]) continue
    let n = 0
    while (n < BAND_W && !col[(x + n) % BAND_W]) n++
    if (n > bestLen) {
      bestLen = n
      bestStart = x
    }
  }
  if (bestLen < 0) {
    if (!col.some((v) => v)) return null
    bestLen = 0
  }
  const x0 = (bestStart + bestLen) % BAND_W
  const w = BAND_W - bestLen
  const n = w * BAND_H
  const c: BodyMapC = { x0, w, m: new Uint8Array(n), w1: new Uint8Array(n), dx: new Int16Array(n), dy: new Int16Array(n) }
  const hasHoles = !!holes && !!fill && holes.some((v) => v)
  if (hasHoles) c.fill = new Uint8Array(n * 4)
  for (let y = 0; y < BAND_H; y++)
    for (let k = 0; k < w; k++) {
      const i = y * BAND_W + ((x0 + k) % BAND_W)
      const j = y * w + k
      c.m[j] = Math.round(st.m[i] * 255)
      c.w1[j] = Math.round(st.w1[i] * 255)
      c.dx[j] = Math.max(-32767, Math.min(32767, Math.round(st.dx[i] * 64)))
      c.dy[j] = Math.max(-32767, Math.min(32767, Math.round(st.dy[i] * 64)))
      if (c.fill) {
        c.fill[j * 4] = fill![i * 3]
        c.fill[j * 4 + 1] = fill![i * 3 + 1]
        c.fill[j * 4 + 2] = fill![i * 3 + 2]
        c.fill[j * 4 + 3] = holes![i] ? 255 : 0
      }
    }
  return c
}

/**
 * 描画用のテクスチャの中身（BAND_W×BAND_H の RGBA: 自車の部分の度合い・レンズ1 の割合・ずれ x・ずれ y）と、
 * 穴を埋めた色（RGBA8）。map が null なら全部 0
 */
export function bodyTexData(c: BodyMapC | null, out: Float32Array<ArrayBuffer> = new Float32Array(BAND_W * BAND_H * 4), fillOut: Uint8Array<ArrayBuffer> = new Uint8Array(BAND_W * BAND_H * 4)): { map: Float32Array<ArrayBuffer>; fill: Uint8Array<ArrayBuffer> } {
  out.fill(0)
  fillOut.fill(0)
  if (c) {
    for (let y = 0; y < BAND_H; y++)
      for (let k = 0; k < c.w; k++) {
        const i = (y * BAND_W + ((c.x0 + k) % BAND_W)) * 4
        const j = y * c.w + k
        out[i] = c.m[j] / 255
        out[i + 1] = c.w1[j] / 255
        out[i + 2] = c.dx[j] / 64
        out[i + 3] = c.dy[j] / 64
        if (c.fill) for (let q = 0; q < 4; q++) fillOut[i + q] = c.fill[j * 4 + q]
      }
  }
  return { map: out, fill: fillOut }
}

/**
 * 時刻 t [s] に使う 2 つの型と混ぜる割合（区間の真ん中どうしの間を直線で移る。カメラの台がゆっくり回る動画で、
 * つなぎ目とずれが区間の境で急に変わらないように）。型が無ければ −1
 */
export function bodyAt(track: BodyTrack, t: number): { a: number; b: number; mix: number } {
  const ws = track.windows
  if (!ws.length) return { a: -1, b: -1, mix: 0 }
  const mid = (w: BodyWindow): number => (w.t0 + w.t1) / 2
  if (t <= mid(ws[0])) return { a: ws[0].map, b: ws[0].map, mix: 0 }
  for (let k = 0; k + 1 < ws.length; k++) {
    const a = mid(ws[k])
    const b = mid(ws[k + 1])
    if (t < b) return { a: ws[k].map, b: ws[k + 1].map, mix: (t - a) / (b - a) }
  }
  const last = ws[ws.length - 1].map
  return { a: last, b: last, mix: 0 }
}

// ---- 保存（動画の横の .motorecomovie-body.bin。gzip した JSON の見出し + 配列） ----

export const BODY_FILE_VERSION = 1

/** 保存する中身を 1 つのバイト列にする（gzip の前） */
export function encodeBodyTrack(track: BodyTrack, key: string): Uint8Array {
  const parts: Uint8Array[] = []
  const metaMaps = track.maps.map((c) => {
    const arrs = [c.m, c.w1, new Uint8Array(c.dx.buffer, c.dx.byteOffset, c.dx.byteLength), new Uint8Array(c.dy.buffer, c.dy.byteOffset, c.dy.byteLength)]
    if (c.fill) arrs.push(c.fill)
    for (const a of arrs) parts.push(a)
    return { x0: c.x0, w: c.w, fill: !!c.fill }
  })
  const head = new TextEncoder().encode(JSON.stringify({ version: BODY_FILE_VERSION, key, band: [BAND_W, BAND_H, BAND_STEP], windows: track.windows, maps: metaMaps }))
  const total = 4 + head.length + parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  new DataView(out.buffer).setUint32(0, head.length, true)
  out.set(head, 4)
  let o = 4 + head.length
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** encodeBodyTrack の逆（版・帯の大きさ・動画の鍵が違えば null） */
export function decodeBodyTrack(buf: Uint8Array, key: string): BodyTrack | null {
  const hl = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true)
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl)))
  if (head.version !== BODY_FILE_VERSION || head.key !== key || head.band[0] !== BAND_W || head.band[1] !== BAND_H || head.band[2] !== BAND_STEP) return null
  let o = 4 + hl
  const take = (n: number): Uint8Array => {
    const a = buf.slice(o, o + n)
    o += n
    return a
  }
  const maps: BodyMapC[] = head.maps.map((mm: { x0: number; w: number; fill: boolean }) => {
    const n = mm.w * BAND_H
    const c: BodyMapC = { x0: mm.x0, w: mm.w, m: take(n), w1: take(n), dx: new Int16Array(take(n * 2).buffer), dy: new Int16Array(take(n * 2).buffer) }
    if (mm.fill) c.fill = take(n * 4)
    return c
  })
  return { windows: head.windows, maps }
}
