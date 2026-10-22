// Types and colors shared by the overlay drawing code (meter, map, floating signs).
// This file used to hold the individual meters (speedometer, tachometer, gear, lean angle, front/back G, outside air temperature) and a
// "meter set" that rearranged them by riding state; both were removed in favor of one round meter (2026-10-20), now drawn in the design
// theme (render/meter.ts, render/theme.ts)
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
