// 重ね表示の描画で共通に使う型と色（クロノグラフ風・サイバー風のメーター、地図、浮遊標識）。
// 以前はここに個別のメーター（速度計・回転計・ギア・リーンアングル・前後 G・外気温）と、それらを走行状態で並べ替える
// 「メーター一式」もあったが、クロノグラフ風・サイバー風に任せて削除した（2026-10-20）
import type { ChannelKey } from '../core/telemetry'

export type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
export type Values = Partial<Record<ChannelKey, number>>

export const COLORS = {
  panel: 'rgba(12, 14, 18, 0.62)',
  text: '#ffffff',
  sub: 'rgba(255,255,255,0.62)',
  accel: '#3ddc84',
  brake: '#ff4b4b',
  lean: '#36b4ff',
  rpm: '#ffcc33',
  red: '#ff3b30',
  temp: '#ffb347'
}
