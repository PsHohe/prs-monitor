import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { Screen } from 'electrobun/main'

import { savedFrame } from '../shared/frame'
import type { Frame } from '../shared/frame'

// Its own file, so a resize never races the repo list's writes to desktop.json.
const PATH = join(homedir(), '.claude', 'pr-monitor', 'window.json')

export async function readFrame(): Promise<Frame> {
  const text = await Bun.file(PATH)
    .text()
    .catch(() => '')

  return savedFrame(
    text,
    Screen.getAllDisplays().map(display => display.workArea),
  )
}

let timer: ReturnType<typeof setTimeout> | null = null

// Dragging an edge fires many resizes; only where it settles is written.
export function writeFrame(frame: Frame): void {
  if (timer) {
    clearTimeout(timer)
  }
  timer = setTimeout(async () => {
    await mkdir(dirname(PATH), { recursive: true })
    await Bun.write(PATH, JSON.stringify(frame))
  }, 500)
}
