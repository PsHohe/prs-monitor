import { useSyncExternalStore } from 'react'

import { rowKey } from '../../../src/lib/lib'
import type { PrRow } from '../../../src/types'
import type { AddressUpdate } from '../shared/rpc'
import { bun, pushed } from './bridge'
import { stampOf } from './remote'

// stamp is what the PR looked like when the drafts started, so a later change shows they may be out of date.
export type Address = Omit<AddressUpdate, 'key'> & { stamp: string; at: string }

// For this run of the app; the drafts keep coming while another PR is open.
const addresses = new Map<string, Address>()
const listeners = new Set<() => void>()

const changed = () => listeners.forEach(listener => listener())

pushed.onAddress = ({ key, ...update }) => {
  const address = addresses.get(key)
  if (address) {
    addresses.set(key, { ...address, ...update })
    changed()
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

export function useAddress(pr: PrRow): Address | null {
  const key = rowKey(pr)

  return useSyncExternalStore(subscribe, () => addresses.get(key) ?? null)
}

export function startAddress(pr: PrRow): void {
  const address: Address = { stamp: stampOf(pr), at: new Date().toISOString(), model: '', plans: [], count: 0, isBusy: true, failure: null, hasCode: null, activity: null, commitId: null }
  addresses.set(rowKey(pr), address)
  changed()
  void bun.startAddress({ pr })
}

export function cancelAddress(pr: PrRow): void {
  const key = rowKey(pr)
  addresses.delete(key)
  changed()
  void bun.cancelAddress({ key })
}
