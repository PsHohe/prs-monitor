import { expect, test } from 'bun:test'

import { DEFAULT_FRAME, savedFrame } from '../src/shared/frame'

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 }
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1440 }

test('a missing or broken file opens at the default', () => {
  expect(savedFrame('', [SCREEN])).toEqual(DEFAULT_FRAME)
  expect(savedFrame('{"x": 1, "y": 2, "width": "big"}', [SCREEN])).toEqual(DEFAULT_FRAME)
})

test('a frame on a display opens where it was', () => {
  const frame = { x: 2000, y: 100, width: 1600, height: 1000 }
  expect(savedFrame(JSON.stringify(frame), [SCREEN, RIGHT])).toEqual(frame)
})

test('a frame whose display is gone opens at the default', () => {
  expect(savedFrame(JSON.stringify({ x: 2000, y: 100, width: 1600, height: 1000 }), [SCREEN])).toEqual(DEFAULT_FRAME)
})

test('a tiny frame grows to the minimum', () => {
  expect(savedFrame(JSON.stringify({ x: 10, y: 10, width: 50, height: 50 }), [SCREEN])).toEqual({ x: 10, y: 10, width: 480, height: 320 })
})
