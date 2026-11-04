import { expect, test } from 'bun:test'

import {
  ciChip,
  detailOf,
  DEFAULT_CONFIG,
  extraChips,
  linkRows,
  mergeConfig,
  formatDate,
  fromGraphql,
  isRateLimited,
  parseCache,
  pauseAfter,
  parseConfigFile,
  reportPrompt,
  summarizeCi,
  toRow,
} from '../src/lib/lib'
import type { RawPr, RowOptions } from '../src/lib/lib'

const PROJECT = `---
poll_interval: 2m
on_new_review: ask   # auto-ask
automated_comments: "^(🚀|Tests fallaron en Jenkins)"
ticket_pattern: "PD-\\d+"
twin_bases: prod, develop
flaky_checks: [jenkins/e2e-tests]
---
Intro text that belongs to no section.

## Opinion
Red CI from known flaky tests is not a blocker.

## Cleanup
Move the PD ticket to Done.
`

const PLAIN: RowOptions = { automated: null, ticket: null, flakyChecks: [] }
const PMC: RowOptions = { automated: null, ticket: /PD-\d+/i, flakyChecks: ['jenkins/e2e-tests'] }

test('project frontmatter and sections override the defaults', async () => {
  const user = parseConfigFile('---\nreport_model: haiku\npoll_interval: 10\n---\n## Report focus\nBe short.\n')
  const config = mergeConfig([user, parseConfigFile(PROJECT)])

  expect(config.pollMinutes).toBe(2)
  expect(config.onNewReview).toBe('ask')
  expect(config.reportModel).toBe('haiku')
  expect(config.automatedComments).toBe('^(🚀|Tests fallaron en Jenkins)')
  expect(config.ticketPattern).toBe('PD-\\d+')
  expect(config.twinBases).toEqual(['prod', 'develop'])
  expect(config.flakyChecks).toEqual(['jenkins/e2e-tests'])
  expect(config.sections.opinion).toBe('Red CI from known flaky tests is not a blocker.')
  expect(config.sections['report focus']).toBe('Be short.')
})

test('a key left empty with only a comment reads as empty', async () => {
  const config = mergeConfig([parseConfigFile('---\nflaky_checks:     # e.g. jenkins/e2e-tests, other\n---\n')])

  expect(config.flakyChecks).toEqual([])
})

test('no files means defaults', () => {
  expect(mergeConfig([])).toEqual(DEFAULT_CONFIG)
})

test('CI summary counts pending checks and names failing ones', async () => {
  expect(summarizeCi(null).ci).toBe('none')
  expect(summarizeCi([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }])).toEqual({
    ci: 'running',
    done: 1,
    total: 2,
    failing: [],
  })
  const failed = summarizeCi([{ name: 'backend', status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }])
  expect(failed.ci).toBe('fail')
  expect(failed.failing).toEqual(['backend'])
})

test('a review after my last activity is new until seen, and approvals use each reviewer latest state', async () => {
  const pr = raw({
    reviews: [
      { author: { login: 'rev' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-05T10:00:00Z' },
      { author: { login: 'rev' }, state: 'APPROVED', submittedAt: '2026-10-06T10:00:00Z' },
      { author: { login: 'other' }, state: 'COMMENTED', submittedAt: '2026-10-06T11:00:00Z' },
    ],
  })

  const row = toRow(pr, 'me', {}, PLAIN)
  expect(row.isNew).toBe(true)
  expect(row.bucket).toBe('me')
  expect(row.approvals).toBe(1)
  expect(row.lastOtherWhat).toBe('commented review by other')
  expect(toRow(pr, 'me', { '429': '2026-10-06T11:00:00Z' }, PLAIN).isNew).toBe(false)
})

test('automated comments under my account do not count as my activity', async () => {
  const pr = raw({
    commits: [],
    comments: [
      { author: { login: 'rev' }, body: 'Please rename this', createdAt: '2026-10-06T09:00:00Z' },
      { author: { login: 'me' }, body: '🚀 Deployed to QA', createdAt: '2026-10-06T10:00:00Z' },
    ],
    reviews: [{ author: { login: 'me' }, state: 'COMMENTED', submittedAt: '2026-10-05T09:00:00Z' }],
  })

  expect(toRow(pr, 'me', {}, PLAIN).isNew).toBe(false)
  expect(toRow(pr, 'me', {}, { ...PLAIN, automated: /^🚀/ }).isNew).toBe(true)
})

test('an approved green PR is ready until a thread is unresolved or it conflicts', async () => {
  const approved = raw({ reviewDecision: 'APPROVED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] })

  expect(toRow(approved, 'me', {}, PLAIN, 0).bucket).toBe('ready')
  expect(extraChips(toRow(approved, 'me', {}, PLAIN, 0))[0]).toEqual({ text: '✓ ready', color: 'success' })
  expect(toRow(approved, 'me', {}, PLAIN, 2).bucket).toBe('others')
  expect(toRow({ ...approved, mergeable: 'CONFLICTING' }, 'me', {}, PLAIN).bucket).toBe('me')
  expect(toRow(approved, 'someone-else', {}, PLAIN).bucket).toBe('others')
})

test('a review requested from me puts the PR on my plate', async () => {
  const theirs = raw({ author: { login: 'dev' }, commits: [], reviewRequests: [{ login: 'me' }, { name: 'team' }] })

  expect(toRow(theirs, 'me', {}, PLAIN).bucket).toBe('me')
  expect(toRow(theirs, 'me', {}, PLAIN).isRequestedFromMe).toBe(true)
})

test('a PR we reviewed offers a re-review once the author pushes or replies', () => {
  const theirs = (over: Partial<RawPr>) =>
    raw({
      number: 424,
      author: { login: 'dev' },
      commits: [{ authors: [{ login: 'dev' }], committedDate: '2026-10-05T08:00:00Z' }],
      reviews: [{ author: { login: 'me' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-05T10:00:00Z', commitOid: 'a1b2c3d4e5' }],
      ...over,
    })

  expect(toRow(theirs({}), 'me', {}, PLAIN).rereview).toBeNull()

  const pushed = toRow(
    theirs({
      commits: [
        { authors: [{ login: 'dev' }], committedDate: '2026-10-05T08:00:00Z' },
        { authors: [{ login: 'dev' }], committedDate: '2026-10-06T09:00:00Z' },
        { authors: [{ login: 'dev' }], committedDate: '2026-10-06T09:30:00Z' },
      ],
    }),
    'me',
    {},
    PLAIN,
  )
  expect(pushed.rereview).toEqual({ at: '2026-10-05T10:00:00Z', state: 'CHANGES_REQUESTED', oid: 'a1b2c3d4e5', commits: 2, isReplied: false })
  expect(extraChips(pushed)).toContainEqual({ text: 'Δ2', color: 'warning' })

  const replied = toRow(
    theirs({ comments: [{ author: { login: 'dev' }, body: 'fixed', createdAt: '2026-10-06T09:00:00Z' }] }),
    'me',
    {},
    PLAIN,
  )
  expect(replied.rereview?.isReplied).toBe(true)
  expect(extraChips(replied)).toContainEqual({ text: 'Δ replies', color: 'warning' })

  // Our own PR never asks for a re-review; a first review request does.
  const own = raw({ reviews: [{ author: { login: 'dev' }, state: 'APPROVED', submittedAt: '2026-10-06T09:00:00Z' }] })
  expect(toRow(own, 'me', {}, PLAIN).rereview).toBeNull()
  const asked = toRow(raw({ author: { login: 'dev' }, commits: [], reviewRequests: [{ login: 'me' }] }), 'me', {}, PLAIN)
  expect(asked.needsFirstReview).toBe(true)
})

test('a pending review request stops needing me once I spoke last', async () => {
  const theirs = raw({
    author: { login: 'dev' },
    reviewRequests: [{ login: 'me' }],
    commits: [{ authors: [{ login: 'dev' }], committedDate: '2026-10-05T22:31:04Z' }],
    comments: [
      { author: { login: 'me' }, body: 'Tests fallaron en Jenkins.', createdAt: '2026-10-05T23:15:45Z' },
      { author: { login: 'me' }, body: '@dev the red Jenkins is unrelated', createdAt: '2026-10-06T14:07:36Z' },
    ],
  })
  const options = { ...PLAIN, automated: /^Tests fallaron/ }

  const replied = toRow(theirs, 'me', {}, options)
  expect(replied.hasLastWord).toBe(true)
  expect(replied.bucket).toBe('others')
  expect(extraChips(replied)).toContainEqual({ text: '◆ requested', dim: true })

  const answered = toRow(
    { ...theirs, comments: [...theirs.comments, { author: { login: 'dev' }, body: 'ok, rebased', createdAt: '2026-10-06T15:00:00Z' }] },
    'me',
    {},
    options,
  )
  expect(answered.bucket).toBe('me')

  const onlyBots = toRow({ ...theirs, comments: theirs.comments.slice(0, 1) }, 'me', {}, options)
  expect(onlyBots.bucket).toBe('me')
})

test('a failure only in flaky checks is yellow and does not need me', async () => {
  const checks = [{ name: 'jenkins/e2e-tests', status: 'COMPLETED', conclusion: 'FAILURE' }]
  const flaky = toRow(raw({ statusCheckRollup: checks }), 'me', {}, PMC)
  const real = toRow(raw({ statusCheckRollup: [...checks, { name: 'backend', conclusion: 'FAILURE' }] }), 'me', {}, PMC)

  expect(flaky.isFlakyOnly).toBe(true)
  expect(flaky.bucket).toBe('others')
  expect(ciChip(flaky)).toEqual({ text: '✗ CI~', color: 'warning' })
  expect(detailOf(flaky, Date.parse('2026-10-06T12:00:00Z'))).toContain('failing: jenkins/e2e-tests (flaky)')
  expect(real.bucket).toBe('me')
  expect(ciChip(real).color).toBe('error')
})

test('stacked PRs point at their parent and are not ready while it is open', async () => {
  const parent = toRow(raw({ number: 417, headRefName: 'feature/PD-905-x', title: 'PD-905' }), 'me', {}, PMC)
  const child = toRow(
    raw({
      number: 418,
      title: 'PD-907',
      headRefName: 'feature/PD-907-y',
      baseRefName: 'feature/PD-905-x',
      reviewDecision: 'APPROVED',
    }),
    'me',
    {},
    PMC,
    0,
  )
  const [, linked] = linkRows([parent, child], [parent, child], [], ['prod', 'develop'], PMC.ticket)

  expect(linked?.stackedOn).toBe(417)
  expect(linked?.bucket).toBe('others')
  expect(extraChips(linked!).map(chip => chip.text)).toContain('↳#417')
})

test('hotfix twins link across prod and develop, open or merged', async () => {
  const develop = toRow(raw({ number: 402, title: 'fix: PD-888 paste', baseRefName: 'develop' }), 'me', {}, PMC)
  const merged = [{ number: 401, title: 'fix: PD-888 paste', headRefName: 'hotfix/pd-888', baseRefName: 'prod' }]
  const [linked] = linkRows([develop], [develop], merged, ['prod', 'develop'], PMC.ticket)

  expect(linked?.twin).toEqual({ number: 401, state: 'MERGED' })
  expect(extraChips(linked!).find(chip => chip.text.startsWith('⇄'))).toEqual({ text: '⇄#401 merged', color: 'warning' })

  const [alone] = linkRows([develop], [develop], merged, [], PMC.ticket)
  expect(alone?.twin).toBe(null)
})

test('report dates are local MM/DD/YYYY and today is stated', () => {
  expect(formatDate('2026-10-06T01:30:00Z', -180)).toBe('10/05/2026 22:30')
  expect(formatDate(Date.parse('2026-10-06T15:00:00Z'), 0, false)).toBe('10/06/2026')
})

test('the report timeline explains a stale dismissal in order', async () => {
  const prompt = reportPrompt(
    {
      pr: {
        number: 426,
        reviews: [
          { author: { login: 'PsHohe' }, state: 'DISMISSED', submittedAt: '2026-10-06T11:13:01Z', body: 'Approved.' },
          { author: { login: 'PsHohe' }, state: 'APPROVED', submittedAt: '2026-10-06T13:29:48Z', body: 'Confirmed.' },
        ],
        commits: [
          { oid: '0f43b477609b', messageHeadline: 'docs(backend): align RBT attendance', committedDate: '2026-10-06T13:25:03Z', authors: [{ login: 'josealejandroprados' }] },
        ],
        comments: [],
      },
      inline: [],
      dismissals: [{ at: '2026-10-06T13:25:12Z', actor: 'josealejandroprados', message: null, commit: '0f43b477609b' }],
      now: Date.parse('2026-10-06T14:00:00Z'),
      offsetMinutes: -180,
    },
    DEFAULT_CONFIG,
  )

  expect(prompt).toContain('Today is 10/06/2026.')
  expect(prompt).not.toContain('2026-10-06T')
  const timeline = prompt.split('## Timeline (oldest first)')[1] ?? ''
  const order = ['review by PsHohe, DISMISSED', 'commit 0f43b47', 'dismissed as stale when josealejandroprados pushed commit 0f43b47', 'review by PsHohe, APPROVED']
  const positions = order.map(text => timeline.indexOf(text))
  expect(positions.every(at => at >= 0)).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  expect(timeline).toContain('10/06/2026 10:25 commit 0f43b47')
})

function raw(over: Partial<RawPr>): RawPr {
  return {
    number: 429,
    title: 'PD-906 role editor labels',
    url: 'https://github.com/PsHohe/pmc-aba-app/pull/429',
    author: { login: 'me' },
    headRefName: 'feature/PD-906-role-editor-labels',
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

test('a GraphQL PR becomes the same raw row gh pr list gave', () => {
  const { raw, unresolved } = fromGraphql({
    number: 7,
    title: 'PD-1 thing',
    author: { login: 'me' },
    isDraft: false,
    reviewDecision: 'APPROVED',
    reviewRequests: { nodes: [{ requestedReviewer: { login: 'dev' } }, { requestedReviewer: {} }] },
    latest: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: 'backend', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] },
    commits: {
      nodes: [
        { commit: { committedDate: '2026-10-05T08:00:00Z', author: { user: { login: 'dev' } } } },
        { commit: { committedDate: '2026-10-05T09:00:00Z', author: { user: null } } },
      ],
    },
    comments: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] },
  })
  expect(raw.reviewRequests).toEqual([{ login: 'dev' }, { login: undefined }])
  expect(raw.statusCheckRollup).toEqual([{ name: 'backend', status: 'COMPLETED', conclusion: 'SUCCESS' }])
  expect(raw.commits).toEqual([
    { authors: [{ login: 'dev' }], committedDate: '2026-10-05T08:00:00Z' },
    { authors: [{ login: undefined }], committedDate: '2026-10-05T09:00:00Z' },
  ])
  expect(unresolved).toBe(1)
  expect(fromGraphql({ number: 8, title: 'x', author: null, isDraft: false, reviewDecision: null }).raw.statusCheckRollup).toBeNull()
})

test('polling pauses until the reset once the GraphQL budget runs low', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  expect(pauseAfter({ remaining: 4000, resetAt: '2026-10-06T12:30:00Z' }, now)).toBeNull()
  expect(pauseAfter({ remaining: 120, resetAt: '2026-10-06T12:30:00Z' }, now)).toBe(Date.parse('2026-10-06T12:30:00Z'))
  expect(pauseAfter({ remaining: 0, resetAt: 'soon' }, now)).toBe(now + 15 * 60 * 1000)
  expect(isRateLimited('gh: API rate limit already exceeded for user ID 1.')).toBe(true)
  expect(parseCache('{"at":1}')).toBeNull()
  expect(parseCache('{"at":1,"me":"me","open":[]}')).toEqual({ at: 1, me: 'me', open: [], merged: [], pausedUntil: null, branches: {}, threads: {} })
})
