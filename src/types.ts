import type { ThreadSummary } from './lib/lib'

export type PrCi = 'pass' | 'fail' | 'running' | 'none'

export type PrBucket = 'ready' | 'me' | 'others' | 'snoozed'

export type PrRow = {
  number: number
  // owner/name; empty when unknown.
  repo: string
  title: string
  url: string
  author: string
  headRef: string
  headOid: string | null
  baseRef: string
  state: string
  isMine: boolean
  isDraft: boolean
  review: string
  approvals: number
  // Everyone but me who reviewed, with their latest review.
  reviewers: { login: string; state: string; at: string }[]
  ci: PrCi
  ciDone: number
  ciTotal: number
  failingChecks: string[]
  isFlakyOnly: boolean
  hasConflicts: boolean
  isBehind: boolean
  unresolved: number | null
  // Unresolved review threads waiting for my reply; null when their details were not loaded.
  replies: ThreadSummary[] | null
  isRequestedFromMe: boolean
  ticket: string | null
  stackedOn: number | null
  twin: { number: number; state: string } | null
  hasMyActivity: boolean
  hasLastWord: boolean
  lastOtherAt: string | null
  lastOtherWhat: string | null
  isNew: boolean
  // Someone else's PR that changed since our last review; null when there is nothing to re-review.
  rereview: PrRereview | null
  // We are asked to review and never have.
  needsFirstReview: boolean
  bucket: PrBucket
}

export type PrRereview = {
  at: string
  state: string
  oid: string | null
  commits: number
  isReplied: boolean
}
