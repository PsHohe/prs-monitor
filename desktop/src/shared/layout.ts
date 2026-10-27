// The narrowest the PR detail between the side panels may get.
export const MIN_DETAIL = 420
export const LIST = { min: 260, max: 560 }
export const ACTIONS = { min: 220, max: 480 }
// A finding's explanation, which takes the actions' place while open.
export const EXPLAIN = { min: 320, max: 760 }
const SPLITTER = 1

export type Layout = { listWidth: number; actionsWidth: number; explainWidth: number; isListOpen: boolean; isActionsOpen: boolean }

// The widths shown (null when hidden) and how far each splitter may go. With an explanation open, actions is its
// width and actionsMax its limit.
export type Fitted = { list: number | null; actions: number | null; listMax: number; actionsMax: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

// The list is kept first; the actions panel narrows, then hides, so the detail keeps its width. The widths asked for
// are kept, so widening the window brings them back.
export function fitLayout(windowWidth: number, wanted: Layout, isExplaining = false): Fitted {
  const room = windowWidth - MIN_DETAIL
  const list = wanted.isListOpen ? clamp(wanted.listWidth, LIST.min, Math.min(LIST.max, room - SPLITTER)) : null
  const left = room - (list === null ? 0 : list + SPLITTER) - SPLITTER
  const side = isExplaining ? EXPLAIN : ACTIONS
  const isOpen = isExplaining || wanted.isActionsOpen
  const actions = isOpen && left >= side.min ? clamp(isExplaining ? wanted.explainWidth : wanted.actionsWidth, side.min, Math.min(side.max, left)) : null

  return {
    list,
    actions,
    listMax: Math.min(LIST.max, room - SPLITTER - (actions === null ? 0 : actions + SPLITTER)),
    actionsMax: Math.min(side.max, left),
  }
}
