import { expect, test } from 'bun:test'

import { fitLayout, MIN_DETAIL } from '../src/shared/layout'

const wanted = { listWidth: 360, actionsWidth: 260, explainWidth: 440, isListOpen: true, isActionsOpen: true }
const detailOf = (windowWidth: number, { list, actions }: { list: number | null; actions: number | null }) =>
  windowWidth - (list === null ? 0 : list + 1) - (actions === null ? 0 : actions + 1)

test('a wide window shows both panels as asked', () => {
  expect(fitLayout(1400, wanted)).toMatchObject({ list: 360, actions: 260 })
})

test('a narrower window narrows, then hides, the actions before the detail gets too narrow', () => {
  const narrowed = fitLayout(1050, wanted)
  expect(narrowed).toMatchObject({ list: 360, actions: 260 })
  expect(detailOf(1050, narrowed)).toBeGreaterThanOrEqual(MIN_DETAIL)

  const squeezed = fitLayout(1020, wanted)
  expect(squeezed.actions).toBe(238)
  expect(detailOf(1020, squeezed)).toBe(MIN_DETAIL)

  expect(fitLayout(723, wanted)).toMatchObject({ list: 302, actions: null })
})

test('with the list hidden the actions panel gets its room', () => {
  expect(fitLayout(723, { ...wanted, isListOpen: false })).toMatchObject({ list: null, actions: 260 })
})

test('each splitter stops before the other panel or the detail is squeezed', () => {
  const fitted = fitLayout(1200, wanted)
  expect(fitted.listMax).toBe(1200 - MIN_DETAIL - 1 - 261)
  expect(fitted.actionsMax).toBe(1200 - MIN_DETAIL - 361 - 1)
  expect(fitLayout(1200, { ...wanted, isActionsOpen: false }).listMax).toBe(560)
})

test('an open explanation takes the actions panel place, even when the actions are hidden', () => {
  expect(fitLayout(1400, wanted, true)).toMatchObject({ list: 360, actions: 440 })
  expect(fitLayout(1400, { ...wanted, isActionsOpen: false }, true)).toMatchObject({ actions: 440 })
  // Without room for its narrowest, it shows in the detail's place instead.
  expect(fitLayout(1000, wanted, true)).toMatchObject({ list: 360, actions: null })
})
