// .insv（MP4コンテナ）の最小限のデマルチプレクサ。
// moov のサンプル表だけを読み、各サンプル（フレーム）の位置・サイズ・時刻を引けるようにする。
// 34GB級のファイルでも moov を読むだけなので、開くのは一瞬で済む。

export interface FileReader {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export interface Track {
  id: number
  kind: 'video' | 'audio' | 'other'
  timescale: number
  duration: number
  width: number
  height: number
  codec: string // WebCodecs 用のコーデック文字列（hvc1.* / mp4a.40.2）
  description: Uint8Array | null // hvcC / esds の DecoderSpecificInfo
  sampleRate: number
  channels: number
  offsets: Float64Array // ファイル内の位置（2^53 未満なので double で十分）
  sizes: Uint32Array
  dts: Float64Array // timescale 単位
  cts: Float64Array // 表示時刻（timescale 単位）
  keyframes: Uint8Array // 1 = キーフレーム
}

class Box {
  constructor(
    public type: string,
    public data: DataView,
    public start: number, // data 内でのペイロード開始
    public end: number
  ) {}
}

function* children(dv: DataView, start: number, end: number): Generator<Box> {
  let p = start
  while (p + 8 <= end) {
    let size = dv.getUint32(p)
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7))
    let hdr = 8
    if (size === 1) {
      size = Number(dv.getBigUint64(p + 8))
      hdr = 16
    } else if (size === 0) {
      size = end - p
    }
    if (size < hdr || p + size > end) break
    yield new Box(type, dv, p + hdr, p + size)
    p += size
  }
}

function find(dv: DataView, start: number, end: number, path: string[]): Box | null {
  let cur: Box | null = null
  let s = start
  let e = end
  for (const name of path) {
    cur = null
    for (const b of children(dv, s, e)) {
      if (b.type === name) {
        cur = b
        break
      }
    }
    if (!cur) return null
    s = cur.start
    e = cur.end
  }
  return cur
}

/** ファイル直下のボックスを走査して moov を読み込む */
async function readMoov(f: FileReader): Promise<DataView> {
  let p = 0
  while (p + 8 <= f.size) {
    const h = await f.read(p, 16)
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    let size = dv.getUint32(0)
    const type = String.fromCharCode(h[4], h[5], h[6], h[7])
    if (size === 1) size = Number(dv.getBigUint64(8))
    else if (size === 0) size = f.size - p
    if (type === 'moov') {
      const m = await f.read(p, size)
      return new DataView(m.buffer, m.byteOffset, m.byteLength)
    }
    if (size < 8) break
    p += size
  }
  throw new Error('moov ボックスが見つかりません')
}

function fullBoxBody(b: Box): number {
  return b.start + 4 // version(1) + flags(3)
}

/** hvcC から WebCodecs のコーデック文字列を作る（ISO/IEC 14496-15 Annex E） */
function hevcCodecString(hvcc: Uint8Array): string {
  const profileSpace = hvcc[1] >> 6
  const tier = (hvcc[1] >> 5) & 1
  const profileIdc = hvcc[1] & 0x1f
  const compat = (hvcc[2] << 24) | (hvcc[3] << 16) | (hvcc[4] << 8) | hvcc[5]
  // 互換フラグはビットを反転した順で16進表記
  let rev = 0
  for (let i = 0; i < 32; i++) if (compat & (1 << i)) rev |= 1 << (31 - i)
  const constraint: number[] = []
  for (let i = 6; i < 12; i++) constraint.push(hvcc[i])
  while (constraint.length && constraint[constraint.length - 1] === 0) constraint.pop()
  const level = hvcc[12]
  const space = ['', 'A', 'B', 'C'][profileSpace]
  let s = `hvc1.${space}${profileIdc}.${(rev >>> 0).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}`
  for (const c of constraint) s += '.' + c.toString(16).toUpperCase()
  return s
}

function parseEsds(b: Box): Uint8Array | null {
  // ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo（タグ5）を探す
  const dv = b.data
  let p = fullBoxBody(b)
  const end = b.end
  const readLen = (): number => {
    let len = 0
    for (let i = 0; i < 4; i++) {
      const c = dv.getUint8(p++)
      len = (len << 7) | (c & 0x7f)
      if (!(c & 0x80)) break
    }
    return len
  }
  while (p < end) {
    const tag = dv.getUint8(p++)
    const len = readLen()
    if (tag === 3) {
      p += 2
      const flags = dv.getUint8(p++)
      if (flags & 0x80) p += 2
      if (flags & 0x40) p += 1 + dv.getUint8(p)
      if (flags & 0x20) p += 2
    } else if (tag === 4) {
      p += 13
    } else if (tag === 5) {
      return new Uint8Array(dv.buffer.slice(dv.byteOffset + p, dv.byteOffset + p + len))
    } else {
      p += len
    }
  }
  return null
}

function parseTrak(dv: DataView, trak: Box): Track | null {
  const tkhd = find(dv, trak.start, trak.end, ['tkhd'])!
  const v = dv.getUint8(tkhd.start)
  const id = dv.getUint32(fullBoxBody(tkhd) + (v === 1 ? 16 : 8))
  const mdia = find(dv, trak.start, trak.end, ['mdia'])!
  const mdhd = find(dv, mdia.start, mdia.end, ['mdhd'])!
  const mv = dv.getUint8(mdhd.start)
  const mb = fullBoxBody(mdhd)
  const timescale = dv.getUint32(mb + (mv === 1 ? 16 : 8))
  const duration = mv === 1 ? Number(dv.getBigUint64(mb + 20)) : dv.getUint32(mb + 12)
  const hdlr = find(dv, mdia.start, mdia.end, ['hdlr'])!
  const ht = fullBoxBody(hdlr) + 4
  const handler = String.fromCharCode(dv.getUint8(ht), dv.getUint8(ht + 1), dv.getUint8(ht + 2), dv.getUint8(ht + 3))
  const stbl = find(dv, mdia.start, mdia.end, ['minf', 'stbl'])
  if (!stbl) return null
  const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other'

  // ---- stsd（コーデック設定）----
  const stsd = find(dv, stbl.start, stbl.end, ['stsd'])!
  const entryStart = fullBoxBody(stsd) + 4
  let codec = ''
  let description: Uint8Array | null = null
  let width = 0
  let height = 0
  let sampleRate = 0
  let channels = 0
  for (const e of children(dv, entryStart, stsd.end)) {
    if (kind === 'video') {
      width = dv.getUint16(e.start + 24)
      height = dv.getUint16(e.start + 26)
      for (const c of children(dv, e.start + 78, e.end)) {
        if (c.type === 'hvcC') {
          description = new Uint8Array(dv.buffer.slice(dv.byteOffset + c.start, dv.byteOffset + c.end))
          codec = hevcCodecString(description)
        }
      }
      if (!codec) codec = e.type
    } else if (kind === 'audio') {
      channels = dv.getUint16(e.start + 16)
      sampleRate = dv.getUint32(e.start + 24) >>> 16
      for (const c of children(dv, e.start + 28, e.end)) {
        if (c.type === 'esds') {
          description = parseEsds(c)
          codec = 'mp4a.40.2'
        }
      }
    }
    break
  }

  // ---- サンプル表 ----
  const get = (t: string): Box | null => find(dv, stbl.start, stbl.end, [t])
  const stsz = get('stsz')!
  const fixed = dv.getUint32(fullBoxBody(stsz))
  const n = dv.getUint32(fullBoxBody(stsz) + 4)
  const sizes = new Uint32Array(n)
  for (let i = 0; i < n; i++) sizes[i] = fixed || dv.getUint32(fullBoxBody(stsz) + 8 + i * 4)

  const chunkOffsets: number[] = []
  const stco = get('stco')
  const co64 = get('co64')
  if (co64) {
    const c = dv.getUint32(fullBoxBody(co64))
    for (let i = 0; i < c; i++) chunkOffsets.push(Number(dv.getBigUint64(fullBoxBody(co64) + 4 + i * 8)))
  } else if (stco) {
    const c = dv.getUint32(fullBoxBody(stco))
    for (let i = 0; i < c; i++) chunkOffsets.push(dv.getUint32(fullBoxBody(stco) + 4 + i * 4))
  }
  const stsc = get('stsc')!
  const sc = dv.getUint32(fullBoxBody(stsc))
  const runs: { first: number; per: number }[] = []
  for (let i = 0; i < sc; i++) {
    const b = fullBoxBody(stsc) + 4 + i * 12
    runs.push({ first: dv.getUint32(b) - 1, per: dv.getUint32(b + 4) })
  }
  const offsets = new Float64Array(n)
  let s = 0
  for (let r = 0; r < runs.length; r++) {
    const lastChunk = r + 1 < runs.length ? runs[r + 1].first : chunkOffsets.length
    for (let c = runs[r].first; c < lastChunk && s < n; c++) {
      let off = chunkOffsets[c]
      for (let k = 0; k < runs[r].per && s < n; k++) {
        offsets[s] = off
        off += sizes[s]
        s++
      }
    }
  }

  const dts = new Float64Array(n)
  const stts = get('stts')!
  {
    const c = dv.getUint32(fullBoxBody(stts))
    let t = 0
    let i = 0
    for (let e = 0; e < c; e++) {
      const b = fullBoxBody(stts) + 4 + e * 8
      const cnt = dv.getUint32(b)
      const delta = dv.getUint32(b + 4)
      for (let k = 0; k < cnt && i < n; k++) {
        dts[i++] = t
        t += delta
      }
    }
  }
  const cts = new Float64Array(dts)
  const ctts = get('ctts')
  if (ctts) {
    const ver = dv.getUint8(ctts.start)
    const c = dv.getUint32(fullBoxBody(ctts))
    let i = 0
    for (let e = 0; e < c; e++) {
      const b = fullBoxBody(ctts) + 4 + e * 8
      const cnt = dv.getUint32(b)
      const off = ver === 1 ? dv.getInt32(b + 4) : dv.getUint32(b + 4)
      for (let k = 0; k < cnt && i < n; k++) cts[i++] += off
    }
  }
  const keyframes = new Uint8Array(n)
  const stss = get('stss')
  if (stss) {
    const c = dv.getUint32(fullBoxBody(stss))
    for (let i = 0; i < c; i++) keyframes[dv.getUint32(fullBoxBody(stss) + 4 + i * 4) - 1] = 1
  } else {
    keyframes.fill(1)
  }

  return { id, kind, timescale, duration, width, height, codec, description, sampleRate, channels, offsets, sizes, dts, cts, keyframes }
}

export async function demux(f: FileReader): Promise<Track[]> {
  const dv = await readMoov(f)
  const tracks: Track[] = []
  for (const b of children(dv, 8, dv.byteLength)) {
    if (b.type === 'trak') {
      const t = parseTrak(dv, b)
      if (t) tracks.push(t)
    }
  }
  return tracks
}

/** フレーム i を表示するのに必要な、直前のキーフレームのインデックス */
export function keyframeBefore(t: Track, i: number): number {
  for (let k = i; k >= 0; k--) if (t.keyframes[k]) return k
  return 0
}
