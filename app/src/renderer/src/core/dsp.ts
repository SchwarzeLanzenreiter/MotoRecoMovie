// Small signal-processing building blocks

/** 2nd-order Butterworth lowpass (bilinear transform) applied forward and backward to remove phase lag (equivalent to scipy's sosfiltfilt) */
export function lowpassFiltfilt(x: Float64Array, fc: number, fs: number): Float64Array {
  const K = Math.tan((Math.PI * fc) / fs)
  const norm = 1 / (1 + Math.SQRT2 * K + K * K)
  const b0 = K * K * norm
  const b1 = 2 * b0
  const b2 = b0
  const a1 = 2 * (K * K - 1) * norm
  const a2 = (1 - Math.SQRT2 * K + K * K) * norm
  const run = (inp: Float64Array): Float64Array => {
    const out = new Float64Array(inp.length)
    // Start from the steady state with the first value to suppress the edge transient
    let x1 = inp[0]
    let x2 = inp[0]
    let y1 = inp[0]
    let y2 = inp[0]
    for (let i = 0; i < inp.length; i++) {
      const y = b0 * inp[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = inp[i]
      y2 = y1
      y1 = y
      out[i] = y
    }
    return out
  }
  const f = run(x)
  f.reverse()
  const b = run(f)
  b.reverse()
  return b
}

/** Gaussian filter (equivalent to scipy.ndimage.gaussian_filter1d, mode='nearest', truncate=3) */
export function gaussianFilter(x: Float64Array, sigmaSamples: number): Float64Array {
  if (sigmaSamples <= 0) return x.slice()
  const r = Math.ceil(3 * sigmaSamples)
  const w = new Float64Array(2 * r + 1)
  let s = 0
  for (let k = -r; k <= r; k++) {
    w[k + r] = Math.exp(-0.5 * (k / sigmaSamples) ** 2)
    s += w[k + r]
  }
  for (let k = 0; k < w.length; k++) w[k] /= s
  const n = x.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let k = -r; k <= r; k++) {
      const j = Math.min(Math.max(i + k, 0), n - 1)
      acc += w[k + r] * x[j]
    }
    out[i] = acc
  }
  return out
}

/** In-place radix-2 complex FFT (inverse for the inverse transform; no 1/n scaling) */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]
        const ai = im[i + k]
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ar + br
        im[i + k] = ai + bi
        re[i + k + len / 2] = ar - br
        im[i + k + len / 2] = ai - bi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/**
 * Cross-correlation c[lag] = Σ a[n+lag]·b[n] (lag = -(len(b)-1) .. len(a)-1).
 * Return index i corresponds to lag = i - (len(b)-1).
 */
export function crossCorrelate(a: Float64Array, b: Float64Array): Float64Array {
  const m = a.length + b.length - 1
  let n = 1
  while (n < m) n <<= 1
  const ar = new Float64Array(n)
  const ai = new Float64Array(n)
  const br = new Float64Array(n)
  const bi = new Float64Array(n)
  ar.set(a)
  br.set(b)
  fft(ar, ai, false)
  fft(br, bi, false)
  // A · conj(B)
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i]
    const im = ai[i] * br[i] - ar[i] * bi[i]
    ar[i] = r
    ai[i] = im
  }
  fft(ar, ai, true)
  const out = new Float64Array(m)
  const L = b.length - 1
  for (let i = 0; i < m; i++) {
    const lag = i - L
    out[i] = ar[(lag + n) % n] / n
  }
  return out
}

export function interp(x: number, xs: Float64Array, ys: Float64Array): number {
  const n = xs.length
  if (x <= xs[0]) return ys[0]
  if (x >= xs[n - 1]) return ys[n - 1]
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (xs[m] <= x) lo = m
    else hi = m
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo])
  return ys[lo] + (ys[hi] - ys[lo]) * t
}

/** Batch linear interpolation for a monotonically increasing x array (fast) */
export function interpSorted(xq: Float64Array, xs: Float64Array, ys: Float64Array): Float64Array {
  const out = new Float64Array(xq.length)
  let j = 0
  for (let i = 0; i < xq.length; i++) {
    const x = xq[i]
    while (j < xs.length - 2 && xs[j + 1] < x) j++
    if (x <= xs[0]) out[i] = ys[0]
    else if (x >= xs[xs.length - 1]) out[i] = ys[ys.length - 1]
    else out[i] = ys[j] + ((ys[j + 1] - ys[j]) * (x - xs[j])) / (xs[j + 1] - xs[j])
  }
  return out
}

/**
 * Approximation of a wide Gaussian filter (3 passes of a box filter. Ends are extended with the nearest value).
 * Cost is proportional to the data length, so it is fast even when σ is hundreds of samples
 */
export function fastGaussian(x: Float64Array, sigmaSamples: number): Float64Array {
  if (sigmaSamples < 1) return x.slice()
  // Odd width at which 3 box passes give variance σ²
  const w = Math.max(1, Math.round(Math.sqrt(4 * sigmaSamples * sigmaSamples + 1)) | 1)
  const r = (w - 1) >> 1
  const n = x.length
  let a = x.slice()
  let b = new Float64Array(n)
  for (let pass = 0; pass < 3; pass++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += a[Math.min(Math.max(k, 0), n - 1)]
    for (let i = 0; i < n; i++) {
      b[i] = sum / w
      sum += a[Math.min(i + r + 1, n - 1)] - a[Math.max(i - r, 0)]
    }
    ;[a, b] = [b, a]
  }
  return a
}
