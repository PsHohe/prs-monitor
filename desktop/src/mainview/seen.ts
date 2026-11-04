import { useEffect, useRef } from 'react'

import type { Snapshot } from '../../../src/monitor'
import type { PrRow } from '../../../src/types'
import { bun } from './bridge'

// Long enough that stepping through the list with the keyboard marks nothing.
const LOOK_MS = 1500

// Marks a PR's new activity as seen once I have looked at it for a moment with the window in front. It is written when
// I move on or leave the window, so the row does not change groups while I read it, and only up to the activity I was
// shown, so anything newer stays new.
export function useMarkSeen(pr: PrRow | null, isReading: boolean, onSeen: (snapshot: Snapshot) => void) {
  const lookedAt = useRef<PrRow | null>(null)
  const isNew = !!pr?.isNew

  useEffect(() => {
    if (!pr || !isNew || !isReading) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const look = () => {
      clearTimeout(timer)
      if (document.hasFocus()) {
        timer = setTimeout(() => (lookedAt.current = pr), LOOK_MS)
      }
    }
    const write = () => {
      clearTimeout(timer)
      const seen = lookedAt.current
      lookedAt.current = null
      if (seen) {
        // On a failure it just stays new.
        void bun.markSeen({ pr: seen }).then(onSeen, () => {})
      }
    }
    look()
    window.addEventListener('focus', look)
    window.addEventListener('blur', write)

    return () => {
      window.removeEventListener('focus', look)
      window.removeEventListener('blur', write)
      write()
    }
  }, [pr?.number, pr?.repo, pr?.lastOtherAt, isNew, isReading])
}
