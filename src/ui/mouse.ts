import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { useEffect, useRef } from 'react'

// `y` is the screen row, counting from 1.
export type MouseEvent = { kind: 'click' | 'wheelUp' | 'wheelDown'; y: number }

const ON = '\x1b[?1000h\x1b[?1006h'
const OFF = '\x1b[?1000l\x1b[?1006l'
// SGR reports: ESC [ < button ; x ; y, then M for a press or m for a release.
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
const PARTIAL = /\x1b\[<[\d;]*$/
const events = new EventEmitter()

// Ink drops mouse reports before `useInput`, so it reads from this stream instead: stdin without them.
// Only presses count (left button and the wheel); modifiers are ignored.
export function mouseStdin(): NodeJS.ReadStream {
  const stdin = process.stdin
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (isOn: boolean) => {
      stdin.setRawMode(isOn)

      return input
    },
    ref: () => stdin.ref(),
    unref: () => stdin.unref(),
  })
  let held = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    let text = held + chunk
    held = text.match(PARTIAL)?.[0] ?? ''
    text = text.slice(0, text.length - held.length).replace(REPORT, (_, code: string, _x: string, y: string, end: string) => {
      const button = Number(code) & ~(4 | 8 | 16)
      const kind = button === 0 ? 'click' : button === 64 ? 'wheelUp' : button === 65 ? 'wheelDown' : null
      if (kind && end === 'M') {
        events.emit('mouse', { kind, y: Number(y) } satisfies MouseEvent)
      }

      return ''
    })
    if (text) {
      input.write(text)
    }
  })
  process.stdout.write(ON)
  process.on('exit', () => process.stdout.write(OFF))

  return input as unknown as NodeJS.ReadStream
}

// Calls the latest `handler` for each mouse press.
export function useMouse(handler: (event: MouseEvent) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const listener = (event: MouseEvent) => latest.current(event)
    events.on('mouse', listener)

    return () => {
      events.off('mouse', listener)
    }
  }, [])
}
