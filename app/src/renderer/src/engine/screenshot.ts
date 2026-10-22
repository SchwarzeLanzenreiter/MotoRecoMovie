// Screenshot (Print Screen): the frame on screen drawn as in the export (export size, with the gauges, signs and mosaic) saved as PNG
// next to the video, named after the video and the time in it
import type { Player } from './player'

/** Time in the video for a file name: 12m34.567s, 1h02m03.000s (no characters Windows does not allow) */
export function shotStamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0')
  return h ? `${h}h${String(m).padStart(2, '0')}m${s}s` : `${m}m${s}s`
}

/** File name of a screenshot of video insvName (with or without the extension) at sec; n > 1 when that name is taken */
export function shotName(insvName: string, sec: number, n = 1): string {
  return `${insvName.replace(/\.insv$/i, '')}_${shotStamp(sec)}${n > 1 ? `_${n}` : ''}.png`
}

/**
 * Saves the frame on screen of player at w×h into dir (the folder of the video unless given; never overwrites).
 * Returns the path written, or null when no frame is shown yet
 */
export async function saveScreenshot(player: Player, insvPath: string, w: number, h: number, videoTime: (frame: number) => number, dir?: string): Promise<string | null> {
  const shot = await player.snapshot(w, h)
  if (!shot) return null
  const { basename, dirname, join } = window.api.path
  const folder = dir ?? dirname(insvPath)
  const sec = videoTime(shot.frame)
  let out = join(folder, shotName(basename(insvPath), sec))
  for (let n = 2; await window.api.exists(out); n++) out = join(folder, shotName(basename(insvPath), sec, n))
  await window.api.writeBinary(out, shot.png)
  return out
}
