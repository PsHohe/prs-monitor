import { expect, test } from 'bun:test'

import type { PrRow } from '../../src/types'
import { reasonsOf } from '../src/shared/attention'

const BASE: PrRow = {
  number: 1,
  repo: 'acme/api',
  title: 'Fix it',
  url: 'https://github.com/acme/api/pull/1',
  author: 'alice',
  headRef: 'fix',
  headOid: null,
  baseRef: 'main',
  state: 'OPEN',
  isMine: false,
  isDraft: false,
  review: '',
  approvals: 0,
  reviewers: [],
  ci: 'pass',
  ciDone: 1,
  ciTotal: 1,
  failingChecks: [],
  isFlakyOnly: false,
  hasConflicts: false,
  isBehind: false,
  canMerge: false,
  unresolved: 0,
  replies: [],
  isRequestedFromMe: false,
  ticket: null,
  stackedOn: null,
  twin: null,
  hasMyActivity: false,
  hasLastWord: false,
  lastOtherAt: null,
  lastOtherWhat: null,
  isNew: false,
  rereview: null,
  needsFirstReview: false,
  bucket: 'me',
}

const thread = (last: string) => ({ path: 'a.ts', line: 1, isOutdated: false, starter: 'me', last, body: '', at: '', url: '' })

test('ready PRs say so and nothing else', () => {
  expect(reasonsOf({ ...BASE, bucket: 'ready', isMine: true })).toEqual(['Approved and green, ready to merge'])
})

test('owed replies name who is waiting, once each', () => {
  const pr = { ...BASE, replies: [thread('bob'), thread('bob'), thread('carol')] }
  expect(reasonsOf(pr)).toEqual(['3 threads waiting for your reply (bob, carol)'])
})

test('my blocking CI and conflicts both show, flaky CI does not', () => {
  const pr = { ...BASE, isMine: true, ci: 'fail' as const, failingChecks: ['lint'], hasConflicts: true }
  expect(reasonsOf(pr)).toEqual(['CI failing: lint', 'Merge conflicts with main'])
  expect(reasonsOf({ ...pr, isFlakyOnly: true, hasConflicts: false })).toEqual([])
})

test('review requests tell a first review from a re-review', () => {
  const asked = { ...BASE, isRequestedFromMe: true }
  expect(reasonsOf({ ...asked, needsFirstReview: true })).toEqual(['alice asked for your review'])
  const rereview = { at: '', state: 'COMMENTED', oid: null, isReplied: false }
  expect(reasonsOf({ ...asked, rereview: { ...rereview, commits: 1 } })).toEqual(['1 new commit since your review'])
  expect(reasonsOf({ ...asked, rereview: { ...rereview, commits: 0 } })).toEqual(['New replies since your review'])
  expect(reasonsOf({ ...asked, hasLastWord: true })).toEqual([])
})

test('new activity is the fallback reason', () => {
  expect(reasonsOf({ ...BASE, isNew: true, lastOtherWhat: 'comment by bob' })).toEqual(['New comment by bob'])
})
