import { expect, test } from 'bun:test'

import {
  applySnoozes,
  extraChips,
  mergeConfig,
  newCiFailures,
  owedReplies,
  parseConfigFile,
  reportModelLabel,
  rowKey,
  setFrontmatter,
  staleness,
  threadsChip,
  threadPages,
  tomorrowMorning,
  toRow,
} from '../src/lib/lib'
import type { RawPr, RowOptions, ThreadDetail, ThreadSummary } from '../src/lib/lib'
import { announcements } from '../src/monitor'

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

test('report_provider picks Claude or Codex, and each keeps its own model', () => {
  expect(mergeConfig([]).reportProvider).toBe('claude')
  const config = mergeConfig([
    parseConfigFile('---\nreport_provider: codex\ncodex_model: gpt-6-sol\n---\n'),
    parseConfigFile('---\nreport_model: opus\nreport_provider: gpt\n---\n'),
  ])
  expect(config.reportProvider).toBe('codex')
  expect(config.reportModel).toBe('opus')
  expect(reportModelLabel(config)).toBe('codex · gpt-6-sol')
  expect(reportModelLabel({ ...config, codexModel: '' })).toBe('codex · default')
  expect(reportModelLabel({ ...config, reportProvider: 'claude' })).toBe('opus')
})

test('setFrontmatter replaces, adds and removes keys and keeps the rest of the file', () => {
  const file = '---\npoll_interval: 3m\nreport_model: sonnet   # for reports\nnote: a---b\n---\n## Opinion\nBe kind.\n'
  expect(setFrontmatter(file, { report_model: 'opus', report_provider: 'codex' })).toBe(
    '---\npoll_interval: 3m\nreport_model: opus\nnote: a---b\nreport_provider: codex\n---\n## Opinion\nBe kind.\n',
  )
  expect(setFrontmatter(file, { report_model: '', poll_interval: '' })).toBe('---\nnote: a---b\n---\n## Opinion\nBe kind.\n')
  expect(setFrontmatter('## Opinion\nBe kind.\n', { codex_model: 'gpt-6-sol' })).toBe('---\ncodex_model: gpt-6-sol\n---\n## Opinion\nBe kind.\n')
  expect(setFrontmatter('', { report_provider: 'codex' })).toBe('---\nreport_provider: codex\n---\n')
  expect(setFrontmatter('---\n---\nBody\n', { codex_model: '' })).toBe('Body\n')
  const written = setFrontmatter('', { report_provider: 'codex', codex_model: 'gpt-6-sol' })
  expect(mergeConfig([parseConfigFile(written)])).toMatchObject({ reportProvider: 'codex', codexModel: 'gpt-6-sol' })
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

test('reviewers keep each person latest review, without me', () => {
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

test('CI failures notify once per push on my PRs, not for flaky checks, snoozed PRs or the first load', () => {
  const mine = (over: Partial<RawPr>) =>
    toRow(raw({ author: { login: 'me' }, headRefOid: 'a1', ...over }), 'me', {}, { ...PLAIN, flakyChecks: ['e2e'] })
  const failing = (name: string) => [{ name, status: 'COMPLETED', conclusion: 'FAILURE' }]
  const passing = mine({ statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  const broken = mine({ statusCheckRollup: failing('build') })
  const flaky = mine({ statusCheckRollup: failing('e2e') })

  expect(newCiFailures([passing], [broken]).map(pr => pr.number)).toEqual([broken.number])
  expect(newCiFailures([broken], [broken])).toEqual([])
  expect(newCiFailures([broken], [{ ...broken, headOid: 'b2' }])).toHaveLength(1)
  expect(newCiFailures([flaky], [broken])).toHaveLength(1)
  expect(newCiFailures([passing], [flaky])).toEqual([])
  expect(newCiFailures([passing], [{ ...broken, bucket: 'snoozed' }])).toEqual([])
  expect(newCiFailures([], [broken])).toEqual([])
  expect(newCiFailures([{ ...passing, isMine: false }], [{ ...broken, isMine: false }])).toEqual([])
})

test('a refresh announces newly ready PRs, new CI failures and new activity', () => {
  const pr = toRow(raw({ author: { login: 'me' }, headRefOid: 'a1' }), 'me', {}, PLAIN)
  const snap = (rows: (typeof pr)[]) => ({ me: 'me', rows, current: null, checkedAt: 1, pausedUntil: null, error: null })
  const broken = { ...pr, ci: 'fail' as const, failingChecks: ['build'] }

  expect(announcements(snap([pr]), snap([pr]))).toEqual([])
  expect(announcements(snap([pr]), snap([{ ...pr, bucket: 'ready' }]))).toEqual([`#${pr.number} is ready to merge`])
  expect(announcements(snap([pr]), snap([broken]))).toEqual([`#${pr.number} CI failed: build`])
  expect(announcements(snap([pr]), snap([{ ...pr, isNew: true, lastOtherWhat: 'comment' }]))).toEqual([`#${pr.number}: new comment`])
})
