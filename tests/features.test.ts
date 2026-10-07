import { expect, test } from 'bun:test'

import {
  applySnoozes,
  changesMarkdown,
  conversationMarkdown,
  digestPrompt,
  extraChips,
  mergeConfig,
  owedReplies,
  parseConfigFile,
  repliesPrompt,
  rerequestable,
  rowKey,
  staleness,
  threadsChip,
  threadMarkdown,
  threadPages,
  tomorrowMorning,
  toRow,
} from '../src/lib/lib'
import type { ChangesData, Conversation, RawPr, RowOptions, ThreadDetail, ThreadSummary } from '../src/lib/lib'

const PLAIN: RowOptions = { automated: null, ticket: null, flakyChecks: [] }
const NOW = Date.parse('2026-10-07T12:00:00Z')

function raw(over: Partial<RawPr>): RawPr {
  return {
    number: 425,
    repo: 'PsHohe/pmc-aba-app',
    title: 'PD-901 single timeframe',
    url: 'https://github.com/PsHohe/pmc-aba-app/pull/425',
    author: { login: 'me' },
    headRefName: 'feature/PD-901',
    headRefOid: 'ccccccc1',
    baseRefName: 'develop',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    reviewRequests: [],
    statusCheckRollup: [],
    comments: [],
    reviews: [],
    commits: [{ authors: [{ login: 'me' }], committedDate: '2026-10-05T08:00:00Z' }],
    ...over,
  }
}

test('merge_method is read from the config and defaults to a merge commit', () => {
  expect(mergeConfig([]).mergeMethod).toBe('merge')
  expect(mergeConfig([parseConfigFile('---\nmerge_method: squash\n---\n')]).mergeMethod).toBe('squash')
  expect(mergeConfig([parseConfigFile('---\nmerge_method: fast\n---\n')]).mergeMethod).toBe('merge')
})

test('reviewers keep each person latest review, without me, and re-request skips approvals', () => {
  const row = toRow(
    raw({
      reviews: [
        { author: { login: 'ana' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-05T10:00:00Z' },
        { author: { login: 'ana' }, state: 'COMMENTED', submittedAt: '2026-10-06T10:00:00Z' },
        { author: { login: 'bo' }, state: 'APPROVED', submittedAt: '2026-10-06T11:00:00Z' },
        { author: { login: 'cy' }, state: 'DISMISSED', submittedAt: '2026-10-06T12:00:00Z' },
        { author: { login: 'me' }, state: 'COMMENTED', submittedAt: '2026-10-06T13:00:00Z' },
      ],
    }),
    'me',
    {},
    PLAIN,
  )

  expect(row.reviewers.map(r => `${r.login}:${r.state}`)).toEqual(['ana:COMMENTED', 'bo:APPROVED', 'cy:DISMISSED'])
  expect(rerequestable(row)).toEqual(['ana', 'cy'])
  expect(rerequestable({ ...row, isMine: false })).toEqual([])
  expect(rerequestable({ ...row, state: 'MERGED' })).toEqual([])
})

test('a snooze holds until new activity or its time, and hides the PR from alerts', () => {
  const row = toRow(
    raw({ comments: [{ author: { login: 'ana' }, body: 'question', createdAt: '2026-10-06T10:00:00Z' }] }),
    'me',
    {},
    PLAIN,
  )
  const key = rowKey(row)
  expect(key).toBe('PsHohe/pmc-aba-app#425')

  const [held] = applySnoozes([row], { [key]: { lastOtherAt: row.lastOtherAt, until: null } }, NOW)
  expect(held?.bucket).toBe('snoozed')
  expect(held?.isNew).toBe(false)

  const [woken] = applySnoozes([row], { [key]: { lastOtherAt: '2026-10-01T00:00:00Z', until: null } }, NOW)
  expect(woken?.bucket).toBe(row.bucket)

  const [expired] = applySnoozes([row], { [key]: { lastOtherAt: row.lastOtherAt, until: NOW - 1 } }, NOW)
  expect(expired?.bucket).toBe(row.bucket)

  const [merged] = applySnoozes([{ ...row, state: 'MERGED' }], { [key]: { lastOtherAt: row.lastOtherAt, until: null } }, NOW)
  expect(merged?.bucket).not.toBe('snoozed')
})

test('tomorrow morning is 9:00 local on the next day', () => {
  const at = new Date(tomorrowMorning(NOW))
  const next = new Date(NOW)
  next.setDate(next.getDate() + 1)

  expect(at.getDate()).toBe(next.getDate())
  expect([at.getHours(), at.getMinutes()]).toEqual([9, 0])
})

test('only PRs waiting on me go stale: yellow after a day, red after three', () => {
  const row = { ...toRow(raw({}), 'me', {}, PLAIN), bucket: 'me' as const }
  const ago = (hours: number) => new Date(NOW - hours * 3600000).toISOString()

  expect(staleness({ ...row, lastOtherAt: ago(5) }, NOW)).toBeNull()
  expect(staleness({ ...row, lastOtherAt: ago(30) }, NOW)).toBe('warning')
  expect(staleness({ ...row, lastOtherAt: ago(80) }, NOW)).toBe('error')
  expect(staleness({ ...row, lastOtherAt: ago(80), bucket: 'others' }, NOW)).toBeNull()
})

test('changes since my review list newer commits and only the PR own files', () => {
  const pr = {
    ...toRow(raw({ author: { login: 'dev' } }), 'me', {}, PLAIN),
    rereview: { at: '2026-10-06T11:28:00Z', state: 'COMMENTED', oid: 'aaaaaaa1', commits: 2, isReplied: false },
  }
  const data: ChangesData = {
    pr,
    since: { at: '2026-10-06T11:28:00Z', oid: 'aaaaaaa1' },
    commits: [
      { oid: 'aaaaaaa1', headline: 'reviewed one', author: 'dev', at: '2026-10-06T09:00:00Z', isMerge: false },
      { oid: 'bbbbbbb2', headline: 'Merge branch develop', author: 'dev', at: '2026-10-07T12:00:00Z', isMerge: true },
      { oid: 'ccccccc3', headline: 'fix the 422', author: 'dev', at: '2026-10-07T12:51:00Z', isMerge: false },
    ],
    files: [
      { path: 'app/Models/Plan.php', status: 'modified', additions: 12, deletions: 3 },
      { path: 'tests/PlanTest.php', status: 'added', additions: 40, deletions: 0 },
      { path: 'app/Unrelated.php', status: 'modified', additions: 5, deletions: 5 },
    ],
    prFiles: ['app/Models/Plan.php', 'tests/PlanTest.php'],
    offsetMinutes: 0,
  }
  const text = changesMarkdown(data)

  expect(text).toContain('**Commits** (2)')
  expect(text).not.toContain('reviewed one')
  expect(text).toContain('Merge branch develop (merge)')
  expect(text).toContain('**Files** (2)')
  expect(text).toContain('tests/PlanTest.php `+40 −0` (new)')
  expect(text).not.toContain('Unrelated.php')
  expect(text).toContain('1 more files changed only by what was merged in from develop')

  expect(changesMarkdown({ ...data, files: null })).toContain('no longer in the history')
})

test('the digest prompt groups PRs by bucket, describes them and leaves snoozed ones out', () => {
  const mine = { ...toRow(raw({ number: 1, mergeable: 'CONFLICTING' }), 'me', {}, PLAIN) }
  const theirs = toRow(
    raw({
      number: 2,
      author: { login: 'ana' },
      reviewRequests: [{ login: 'me' }],
      commits: [{ authors: [{ login: 'ana' }], committedDate: '2026-10-06T08:00:00Z' }],
    }),
    'me',
    {},
    PLAIN,
  )
  const snoozed = { ...toRow(raw({ number: 3 }), 'me', {}, PLAIN), bucket: 'snoozed' as const }
  const text = digestPrompt([mine, theirs, snoozed], { me: 'me', now: NOW, offsetMinutes: 0 }, 'Hotfixes first.')

  expect(text).toContain('Today is 10/07/2026 12:00. I am me.')
  expect(text).toContain('## Waiting on me')
  expect(text).toContain('PsHohe/pmc-aba-app#1')
  expect(text).toContain('merge conflicts')
  expect(text).toContain('my review is requested')
  expect(text).not.toContain('#3 ')
  expect(text).toContain('(1 snoozed PRs left out on purpose.)')
  expect(text.endsWith('## What to focus on\nHotfixes first.')).toBe(true)
})

function thread(over: Partial<ThreadSummary>): ThreadSummary {
  return {
    path: 'app/Models/Bip/Plan.php',
    line: 282,
    isOutdated: false,
    starter: 'ana',
    last: 'ana',
    body: 'Why exclude here?',
    at: '2026-10-07T15:52:10Z',
    url: 'https://github.com/PsHohe/pmc-aba-app/pull/425#discussion_r1',
    ...over,
  }
}

test('threads wait for me on my PR when someone else wrote last, and on others when I started them', () => {
  const askedMe = thread({})
  const iAnswered = thread({ last: 'me' })
  const myQuestionAnswered = thread({ starter: 'me', last: 'dev' })
  const theirOwnTalk = thread({ starter: 'ana', last: 'dev' })
  const myBotLast = thread({ starter: 'ana', last: 'me', body: '🚀 deployed' })
  const all = [askedMe, iAnswered, myQuestionAnswered, theirOwnTalk, myBotLast]

  expect(owedReplies(all, 'me', true, /^🚀/)).toEqual([askedMe, myQuestionAnswered, theirOwnTalk, myBotLast])
  expect(owedReplies(all, 'me', false, /^🚀/)).toEqual([myQuestionAnswered])
  expect(owedReplies(all, 'me', true, null)).toEqual([askedMe, myQuestionAnswered, theirOwnTalk])
})

test('a reply owed puts the PR in waiting on me with a chip, and no unresolved threads means none owed', () => {
  const owing = toRow(raw({}), 'me', {}, PLAIN, 1, [thread({})])
  expect(owing.replies).toHaveLength(1)
  expect(owing.bucket).toBe('me')
  expect(threadsChip(owing)).toEqual({ text: '↩1', color: 'warning' })
  expect(extraChips(owing).map(chip => chip.text)).not.toContain('↩1')

  expect(toRow(raw({}), 'me', {}, PLAIN, 0).replies).toEqual([])
  expect(toRow(raw({}), 'me', {}, PLAIN, 2).replies).toBeNull()
})

test('the replies prompt lists the owed threads', () => {
  const pr = toRow(raw({}), 'me', {}, PLAIN, 1, [thread({ isOutdated: true })])
  const prompt = repliesPrompt(pr, { ...mergeConfig([]), sections: { opinion: 'Be kind.' } })
  expect(prompt).toContain('1. app/Models/Bip/Plan.php:282 (outdated), last from ana: "Why exclude here?"')
  expect(prompt).toContain('Do not post or push anything until I approve.')
  expect(prompt?.endsWith('Project guidance:\nBe kind.')).toBe(true)
  expect(repliesPrompt({ ...pr, replies: [] }, mergeConfig([]))).toBeNull()
})

test('the PR view shows the description, then comments, reviews and threads in order', () => {
  const data: Conversation = {
    pr: toRow(raw({ author: { login: 'ana' } }), 'me', {}, PLAIN, 1),
    body: '<!-- template -->\nAdds a timeframe.',
    createdAt: '2026-10-05T10:00:00Z',
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    commits: 4,
    comments: [{ author: 'bob', body: 'Ping', at: '2026-10-07T09:00:00Z' }],
    reviews: [
      { author: 'me', state: 'CHANGES_REQUESTED', body: 'A few things', at: '2026-10-06T10:00:00Z' },
      { author: 'me', state: 'COMMENTED', body: '', at: '2026-10-06T10:00:00Z' },
      { author: 'me', state: 'PENDING', body: '', at: null },
    ],
    threads: [
      {
        path: 'app/Plan.php',
        line: 282,
        isResolved: false,
        isOutdated: true,
        at: '2026-10-06T10:00:00Z',
        comments: [
          { author: 'me', body: 'Why exclude here?', at: '2026-10-06T10:00:00Z' },
          { author: 'ana', body: 'Legacy rows.', at: '2026-10-06T12:00:00Z' },
        ],
      },
    ],
    offsetMinutes: 0,
  }
  const text = conversationMarkdown(data)
  expect(text).toContain('**ana** wants to merge `feature/PD-901` into `develop` · opened 10/05/2026 10:00')
  expect(text).toContain('`+12 −3` in 2 files · 4 commits')
  expect(text).toContain('## Description\n  Adds a timeframe.')
  expect(text).not.toContain('template')
  expect(text).toContain('## Conversation (3 · 1 unresolved threads)')
  expect(text).toContain('**me** on `app/Plan.php:282` · 10/06/2026 10:00 · unresolved, outdated\n  Why exclude here?\n  ↳ **ana** · 10/06/2026 12:00\n    Legacy rows.')
  expect(text.indexOf('requested changes')).toBeLessThan(text.indexOf('**bob** commented'))
  expect(text).not.toContain('**me** reviewed')
})

function detail(over: Partial<ThreadDetail>): ThreadDetail {
  return {
    id: 'T1',
    path: 'app/Plan.php',
    line: 282,
    isResolved: false,
    isOutdated: false,
    comments: [
      { author: 'me', body: 'Why exclude here?', at: '2026-10-06T10:00:00Z' },
      { author: 'ana', body: 'Fixed in abc.', at: '2026-10-07T15:52:00Z' },
    ],
    diffHunk: '@@ -1,3 +1,3 @@\n context\n-old\n+new',
    url: 'https://github.com/o/r/pull/1#discussion_r1',
    canReply: true,
    canResolve: true,
    ...over,
  }
}

test('the threads panel puts the threads waiting on me first and leaves resolved ones out', () => {
  const mineAnswered = detail({ id: 'A', url: 'a' })
  const iWroteLast = detail({ id: 'B', url: 'b', comments: [{ author: 'me', body: 'Done', at: '2026-10-07T10:00:00Z' }] })
  const resolved = detail({ id: 'C', url: 'c', isResolved: true })
  const pages = threadPages([iWroteLast, resolved, mineAnswered], { me: 'me', isMine: false, automated: null })
  expect(pages.map(one => [one.thread.id, one.isOwed])).toEqual([
    ['A', true],
    ['B', false],
  ])
})

test('a thread page says why it waits, shows the code and every comment', () => {
  const text = threadMarkdown({ thread: detail({ isOutdated: true }), isOwed: true }, 'me', 0)
  expect(text).toContain('**app/Plan.php:282** (outdated: the code changed since)\n↩ Waiting on you: ana replied to your thread')
  expect(text).toContain('```diff\n context\n-old\n+new\n```')
  expect(text).toContain('**you** · 10/06/2026 10:00\n  Why exclude here?')
  expect(text).toContain('**ana** · 10/07/2026 15:52\n  Fixed in abc.')

  const theirs = threadMarkdown({ thread: detail({ comments: [{ author: 'bob', body: 'Hm', at: '2026-10-07T10:00:00Z' }] }), isOwed: true }, 'me', 0)
  expect(theirs).toContain('↩ Waiting on you: bob commented on your PR')
  expect(threadMarkdown({ thread: detail({}), isOwed: false }, 'me', 0)).toContain('Not waiting on you · last from ana')
})
