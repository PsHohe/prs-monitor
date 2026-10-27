import { useSyncExternalStore } from 'react'

import { rowKey } from '../../../src/lib/lib'
import type { PrRow } from '../../../src/types'
import { bun, pushed } from './bridge'
import { stampOf } from './remote'

// stamp is what the PR looked like when the report started, so a later change shows it is out of date.
export type Report = { stamp: string; at: string; text: string; model: string; isDone: boolean; failure: string | null }

// For this run of the app; a report keeps being written while another PR is open.
const reports = new Map<string, Report>()
const listeners = new Set<() => void>()

const changed = () => listeners.forEach(listener => listener())

pushed.onReport = ({ key, ...update }) => {
  const report = reports.get(key)
  if (report) {
    reports.set(key, { ...report, ...update })
    changed()
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

export function useReport(pr: PrRow): Report | null {
  const key = rowKey(pr)

  return useSyncExternalStore(subscribe, () => reports.get(key) ?? null)
}

export function startReport(pr: PrRow): void {
  reports.set(rowKey(pr), { stamp: stampOf(pr), at: new Date().toISOString(), text: '', model: '', isDone: false, failure: null })
  changed()
  void bun.startReport({ pr })
}

export function cancelReport(pr: PrRow): void {
  const key = rowKey(pr)
  reports.delete(key)
  changed()
  void bun.cancelReport({ key })
}
