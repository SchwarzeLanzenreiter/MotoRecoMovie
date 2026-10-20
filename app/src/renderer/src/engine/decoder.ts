// 1本の映像トラックを WebCodecs でデコードし、任意のフレーム番号を取り出す。
// 近い先のフレームなら続きからデコードし、離れていれば直前のキーフレームからやり直す。
import { keyframeBefore, type FileReader, type Track } from '../core/mp4'
import { t } from '../i18n'

const FRAME_US = 20000 // タイムスタンプ（フレーム番号 × 20ms）。実時刻は使わない
const READY_MAX = 12 // 出力済みで、まだ使われていないフレームを持っておく上限

export class TrackDecoder {
  private dec: VideoDecoder | null = null
  private next = 0 // 次に投入するサンプル
  private lastOut = -1 // 最後に出力されたフレーム番号
  private wanted = -1 // いま求められているフレーム番号（これより前のフレームはもう使わない）
  private ready = new Map<number, VideoFrame>()
  private waiters = new Map<number, (f: VideoFrame) => void>()
  private lock: Promise<unknown> = Promise.resolve()
  private error: unknown = null
  /** 確認用の集計: キーフレームからやり直した回数・投入したサンプル数・出力されて使われなかったフレーム数 */
  stats = { resets: 0, fed: 0, dropped: 0, outOfOrder: 0, why: {} as Record<string, number> }

  constructor(
    private f: FileReader,
    readonly track: Track
  ) {}

  private config(): VideoDecoderConfig {
    return {
      codec: this.track.codec,
      description: this.track.description ?? undefined,
      codedWidth: this.track.width,
      codedHeight: this.track.height,
      hardwareAcceleration: 'prefer-hardware'
    }
  }

  private reset(at: number): void {
    this.stats.resets++
    this.dec?.close()
    for (const fr of this.ready.values()) fr.close()
    this.ready.clear()
    this.error = null
    this.dec = new VideoDecoder({
      output: (fr) => {
        const i = Math.round(fr.timestamp / FRAME_US)
        if (i < this.lastOut) this.stats.outOfOrder++
        this.lastOut = i
        const w = this.waiters.get(i)
        if (w) {
          this.waiters.delete(i)
          w(fr)
        } else {
          this.ready.set(i, fr)
          // もう使わないフレーム（求められている位置より前）は早めに解放する（ハードウェアデコーダーのバッファが詰まるため）。
          // 以前は「出力された位置より 2 枚以上前」を捨てていたが、ハードウェアデコーダーは何枚かまとめて出力することがあり、
          // 使う側が少し遅れていると（最初の書き出しのシェーダーの準備など）これから使うフレームまで捨ててしまい、
          // キーフレームからのやり直しが連鎖して書き出しが極端に遅くなっていた（1 フレーム 235ms）
          for (const k of [...this.ready.keys()]) if (k < this.wanted) (this.ready.get(k)!.close(), this.ready.delete(k), this.stats.dropped++)
          // 念のため、溜まりすぎたら古いものから解放する
          while (this.ready.size > READY_MAX) {
            const k = Math.min(...this.ready.keys())
            this.ready.get(k)!.close()
            this.ready.delete(k)
            this.stats.dropped++
          }
        }
      },
      error: (e) => {
        this.error = e
      }
    })
    this.dec.configure(this.config())
    this.next = keyframeBefore(this.track, at)
    this.lastOut = this.next - 1
  }

  private async feed(upTo: number): Promise<void> {
    const t = this.track
    while (this.next <= upTo && this.next < t.sizes.length) {
      const i = this.next++
      this.stats.fed++
      const data = await this.f.read(t.offsets[i], t.sizes[i])
      this.dec!.decode(new EncodedVideoChunk({ type: t.keyframes[i] ? 'key' : 'delta', timestamp: i * FRAME_US, data }))
      while (this.dec!.decodeQueueSize > 6) await new Promise((r) => setTimeout(r, 0))
    }
  }

  /**
   * フレーム i を返す（呼び出し側で close() すること）。
   * ahead は先読みの投入枚数だが、デコード済みフレームを溜めるとハードウェアデコーダーの
   * 出力バッファが詰まって大幅に遅くなる（実測 115fps → 13fps）ので、通常は 0 のまま使う。
   */
  get(i: number, ahead = 0): Promise<VideoFrame> {
    const run = async (): Promise<VideoFrame> => {
      this.wanted = i
      const last = this.track.sizes.length - 1
      const have = this.ready.get(i)
      if (have) {
        this.ready.delete(i)
        await this.feed(Math.min(i + ahead, last))
        return have
      }
      // 続きから届く範囲か: まだ出力されておらず（後戻りでない）、投入位置から遠すぎない
      const reachable = this.dec && !this.error && i > this.lastOut && i - this.next < 60
      if (!reachable) {
        const why = !this.dec ? 'なし' : this.error ? `エラー: ${String(this.error).slice(0, 80)}` : i <= this.lastOut ? `後戻り(i=${i}, 出力済み=${this.lastOut})` : `遠い(${i - this.next})`
        const key = why.replace(/\d+/g, '#')
        this.stats.why[key] = (this.stats.why[key] ?? 0) + 1
        this.reset(i)
      }
      const box: { fr: VideoFrame | null } = { fr: null }
      this.waiters.set(i, (fr) => (box.fr = fr))
      await this.feed(Math.min(i + ahead, last))
      // ハードウェアデコーダーは数枚ためてから出力するので、出てくるまで後続を1枚ずつ足す。
      // （flush() するとキーフレームからしか再開できなくなるので、末尾以外では使わない）
      const t0 = performance.now()
      while (!box.fr) {
        if (this.error) throw this.error
        if (this.next <= last) {
          if (this.dec!.decodeQueueSize === 0) await this.feed(this.next)
        } else {
          // 末尾: 残りを吐き出させる。以後は作り直しが必要
          await this.dec!.flush()
          this.dec!.close()
          this.dec = null
          if (!box.fr) throw new Error(t('フレーム {i} がデコードされませんでした', { i }))
          break
        }
        if (!box.fr) await new Promise((r) => setTimeout(r, 2))
        if (performance.now() - t0 > 10000) throw new Error(t('フレーム {i} のデコードがタイムアウトしました', { i }))
      }
      return box.fr!
    }
    const r = this.lock.then(run, run)
    this.lock = r.catch(() => undefined)
    return r
  }

  close(): void {
    this.dec?.close()
    this.dec = null
    for (const fr of this.ready.values()) fr.close()
    this.ready.clear()
  }
}

/**
 * 複数のトラックのキーフレームだけを順にデコードし、同じフレーム番号の組ができるたびに onFrames を呼ぶ
 * （onFrames は非同期でもよい。終わった後でフレームを閉じる）。キーフレームは単独でデコードできるので、間のフレームは読まない。
 * 動画全体をざっと調べる用（車線の判定・車の検出など）
 */
export async function decodeKeyframes(
  f: FileReader,
  tracks: Track[],
  indices: number[],
  onFrames: (i: number, frames: VideoFrame[]) => void | Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const got = tracks.map(() => new Map<number, VideoFrame>())
  const complete: number[] = [] // すべてのトラックがそろったフレーム番号
  let error: unknown = null
  const decs = tracks.map((track, k) => {
    const d = new VideoDecoder({
      output: (fr) => {
        const i = Math.round(fr.timestamp / FRAME_US)
        got[k].set(i, fr)
        if (got.every((m) => m.has(i))) complete.push(i)
      },
      error: (e) => {
        error = e
      }
    })
    d.configure({ codec: track.codec, description: track.description ?? undefined, codedWidth: track.width, codedHeight: track.height, hardwareAcceleration: 'prefer-hardware' })
    return d
  })
  const drain = async (): Promise<void> => {
    while (complete.length) {
      const i = complete.shift()!
      const frs = got.map((m) => m.get(i)!)
      got.forEach((m) => m.delete(i))
      try {
        await onFrames(i, frs)
      } finally {
        frs.forEach((fr) => fr.close())
      }
    }
  }
  try {
    for (const i of indices) {
      if (error) throw error
      if (signal?.aborted) throw new Error(t('中止しました'))
      for (let k = 0; k < tracks.length; k++) {
        const tr = tracks[k]
        const data = await f.read(tr.offsets[i], tr.sizes[i])
        decs[k].decode(new EncodedVideoChunk({ type: 'key', timestamp: i * FRAME_US, data }))
      }
      await drain()
      // 投入しすぎない（ハードウェアデコーダーのバッファが詰まる）
      while (!error && (decs.some((d) => d.decodeQueueSize > 2) || got.some((m) => m.size > 3))) {
        await new Promise((r) => setTimeout(r, 1))
        await drain()
      }
    }
    await Promise.all(decs.map((d) => d.flush()))
    await drain()
    if (error) throw error
  } finally {
    decs.forEach((d) => d.state !== 'closed' && d.close())
    got.forEach((m) => m.forEach((fr) => fr.close()))
  }
}
