export type Frame = { x: number; y: number; width: number; height: number }

export const DEFAULT_FRAME: Frame = { width: 1280, height: 800, x: 120, y: 120 }

// Smaller than this, the columns no longer fit.
const MIN = { width: 480, height: 320 }

// The saved frame when it still fits on a display; a missing, broken or off-screen one (its monitor was unplugged)
// opens at the default.
export function savedFrame(text: string, workAreas: Frame[]): Frame {
  let value: unknown = null
  try {
    value = JSON.parse(text)
  } catch {}
  const raw = value && typeof value === 'object' ? (value as Partial<Record<keyof Frame, unknown>>) : {}
  const [x, y, width, height] = [raw.x, raw.y, raw.width, raw.height]
  if (![x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n))) {
    return DEFAULT_FRAME
  }
  const frame = { x, y, width: Math.max(width as number, MIN.width), height: Math.max(height as number, MIN.height) } as Frame
  // The title bar must land on some display, or the window could not be dragged back.
  const isReachable = workAreas.some(
    area => frame.y >= area.y && frame.y < area.y + area.height && frame.x + frame.width > area.x + 40 && frame.x < area.x + area.width - 40,
  )

  return isReachable ? frame : DEFAULT_FRAME
}
