import { useEffect, useState } from 'react'

import { rowKey } from '../../../src/lib/lib'
import type { PrRow } from '../../../src/types'

export type Failure = { failure: string }

// Per kind and PR, with what the PR looked like when fetched, so moving back to a PR does not ask GitHub again.
const cache = new Map<string, { stamp: string; data: unknown }>()

// What the PR looked like: a change means new activity, so what was fetched about it is out of date.
export const stampOf = (pr: PrRow) => [pr.headOid, pr.lastOtherAt, pr.unresolved, pr.review].join('|')

// Fetches something about a PR once it stays selected for a moment, so stepping through the
// list with the keyboard does not ask GitHub about every PR passed.
export function useRemote<T extends object>(kind: string, pr: PrRow, load: (pr: PrRow) => Promise<T | Failure>, isEnabled = true) {
  const key = `${kind}:${rowKey(pr)}`
  const stamp = stampOf(pr)
  const [data, setData] = useState<T | Failure | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    if (!isEnabled) {
      return
    }
    // What is on screen stays while a newer version loads.
    const cached = cache.get(key)
    if (cached) {
      setData(cached.data as T)
    }
    if (cached?.stamp === stamp) {
      setIsLoading(false)

      return
    }
    let isCurrent = true
    setIsLoading(true)
    const timer = setTimeout(async () => {
      const loaded = await load(pr).catch((err: unknown): Failure => ({ failure: err instanceof Error ? err.message : String(err) }))
      if (!('failure' in loaded)) {
        cache.set(key, { stamp, data: loaded })
      }
      if (isCurrent) {
        setData(loaded)
        setIsLoading(false)
      }
    }, 300)

    return () => {
      isCurrent = false
      clearTimeout(timer)
    }
  }, [key, stamp, reloads, isEnabled])

  return {
    data: data && !('failure' in data) ? data : null,
    failure: data && 'failure' in data ? data.failure : null,
    isLoading,
    reload: () => {
      cache.delete(key)
      setReloads(n => n + 1)
    },
  }
}
