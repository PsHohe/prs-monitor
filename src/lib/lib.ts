import type { PrBucket, PrCi, PrRow } from '../types'

export type Config = {
  pollMinutes: number
  onNewReview: 'notify' | 'ask'
  reportModel: string
  automatedComments: string | null
  ticketPattern: string | null
  twinBases: string[]
  flakyChecks: string[]
  mergeMethod: 'merge' | 'squash' | 'rebase'
  sections: Record<string, string>
}

export const DEFAULT_CONFIG: Config = {
  pollMinutes: 3,
  onNewReview: 'notify',
  reportModel: 'sonnet',
  automatedComments: null,
  ticketPattern: null,
  twinBases: [],
  flakyChecks: [],
  mergeMethod: 'merge',
  sections: {},
}

type ConfigFile = { values: Record<string, string>; sections: Record<string, string> }

function unquote(raw: string): string {
  const value = raw.trim()
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
    return value.slice(1, value.lastIndexOf(quote))
  }

  return value.replace(/(^|\s+)#.*$/, '').trim()
}

export function parseConfigFile(text: string): ConfigFile {
  const values: Record<string, string> = {}
  let body = text
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (front) {
    body = text.slice(front[0].length)
    for (const line of (front[1] ?? '').split(/\r?\n/)) {
      const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
      if (pair?.[1]) {
        values[pair[1]] = unquote(pair[2] ?? '')
      }
    }
  }

  const sections: Record<string, string> = {}
  const parts = body.split(/^##\s+(.+)$/m)
  for (let i = 1; i < parts.length; i += 2) {
    const heading = (parts[i] ?? '').trim().toLowerCase()
    const content = (parts[i + 1] ?? '').trim()
    if (heading && content) {
      sections[heading] = content
    }
  }

  return { values, sections }
}

function minutes(raw: string | undefined): number | null {
  const match = raw ? /^(\d+(?:\.\d+)?)\s*(m|min|minutes?)?$/i.exec(raw) : null

  return match ? Math.max(1, Number(match[1])) : null
}

function list(raw: string | undefined): string[] | null {
  if (raw === undefined) {
    return null
  }

  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(item => unquote(item))
    .filter(Boolean)
}

export function mergeConfig(files: ConfigFile[]): Config {
  return files.reduce<Config>((config, file) => {
    const v = file.values
    const review = v.on_new_review
    const merge = v.merge_method

    return {
      pollMinutes: minutes(v.poll_interval) ?? config.pollMinutes,
      onNewReview: review === 'ask' || review === 'notify' ? review : config.onNewReview,
      reportModel: v.report_model || config.reportModel,
      automatedComments: v.automated_comments ?? config.automatedComments,
      ticketPattern: v.ticket_pattern ?? config.ticketPattern,
      twinBases: list(v.twin_bases) ?? config.twinBases,
      flakyChecks: list(v.flaky_checks) ?? config.flakyChecks,
      mergeMethod: merge === 'merge' || merge === 'squash' || merge === 'rebase' ? merge : config.mergeMethod,
      sections: { ...config.sections, ...file.sections },
    }
  }, DEFAULT_CONFIG)
}

type Author = { login?: string } | null | undefined
type RawComment = { author: Author; body: string; createdAt: string }
type RawReview = { author: Author; state: string; submittedAt: string; body?: string; commitOid?: string | null }
type RawCommit = { authors: { login?: string }[]; committedDate: string }
export type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string }
export type RawPr = {
  number: number
  repo?: string
  title: string
  url?: string
  author: Author
  headRefName?: string
  headRefOid?: string
  baseRefName?: string
  state?: string
  isDraft: boolean
  reviewDecision: string | null
  mergeable?: string
  mergeStateStatus?: string
  reviewRequests?: { login?: string; name?: string }[]
  statusCheckRollup: Check[] | null
  comments: RawComment[]
  reviews: RawReview[]
  commits: RawCommit[]
}
export type MergedPr = {
  number: number
  title: string
  headRefName: string
  baseRefName: string
  repository?: { nameWithOwner: string }
}

// One PR as the monitor's own GraphQL query returns it (see REFRESH_QUERY in register.tsx).
export type GqlPr = {
  number: number
  updatedAt?: string
  repository?: { nameWithOwner: string }
  title: string
  url?: string
  author: Author
  headRefName?: string
  headRefOid?: string
  baseRefName?: string
  state?: string
  isDraft: boolean
  reviewDecision: string | null
  mergeable?: string
  mergeStateStatus?: string
  reviewRequests?: { nodes: { requestedReviewer: Author }[] }
  latest?: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: Check[] } } | null } }[] }
  commits?: { nodes: { commit: { committedDate: string; author: { user: Author } | null } }[] }
  comments?: { nodes: RawComment[] }
  reviews?: { nodes: GqlReview[] }
  reviewThreads?: { nodes: { isResolved: boolean }[] }
}
type GqlReview = { author: Author; state: string; submittedAt: string; body?: string; commit?: { oid: string } | null }

export function fromGraphql(node: GqlPr): { raw: RawPr; unresolved: number | null } {
  const contexts = node.latest?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? null
  const raw: RawPr = {
    number: node.number,
    repo: node.repository?.nameWithOwner,
    title: node.title,
    url: node.url,
    author: node.author,
    headRefName: node.headRefName,
    headRefOid: node.headRefOid,
    baseRefName: node.baseRefName,
    state: node.state,
    isDraft: node.isDraft,
    reviewDecision: node.reviewDecision,
    mergeable: node.mergeable,
    mergeStateStatus: node.mergeStateStatus,
    reviewRequests: (node.reviewRequests?.nodes ?? []).map(r => ({ login: r.requestedReviewer?.login })),
    statusCheckRollup: contexts,
    comments: node.comments?.nodes ?? [],
    reviews: (node.reviews?.nodes ?? []).map(({ commit, ...review }) => ({ ...review, commitOid: commit?.oid ?? null })),
    commits: (node.commits?.nodes ?? []).map(({ commit }) => ({
      authors: [{ login: commit.author?.user?.login }],
      committedDate: commit.committedDate,
    })),
  }
  const threads = node.reviewThreads?.nodes

  return { raw, unresolved: threads ? threads.filter(t => !t.isResolved).length : null }
}

// An unresolved review thread: who started it and who wrote last.
export type ThreadSummary = {
  path: string
  line: number | null
  isOutdated: boolean
  starter: string
  last: string
  body: string
  at: string
  url: string
}

// The unresolved threads of one PR as of its updatedAt, so they are fetched again only when the PR changes.
export type PrThreads = { updatedAt: string; unresolved: ThreadSummary[] }

// What one session fetched, shared through a file so the other sessions on the same repo reuse it.
export type SharedCache = {
  at: number
  me: string
  open: GqlPr[]
  merged: MergedPr[]
  pausedUntil: number | null
  // The PR of each branch looked up since this fetch (null: none), so a branch without an open PR
  // is not asked about again until the next fetch.
  branches: Record<string, GqlPr | null>
  // Thread details by repo#number, for PRs with unresolved threads (the plugin does not keep these).
  threads: Record<string, PrThreads>
}

export function parseCache(text: string): SharedCache | null {
  try {
    const value = JSON.parse(text) as Partial<SharedCache>
    if (typeof value.at !== 'number' || typeof value.me !== 'string' || !Array.isArray(value.open)) {
      return null
    }

    return {
      at: value.at,
      me: value.me,
      open: value.open,
      merged: Array.isArray(value.merged) ? value.merged : [],
      pausedUntil: typeof value.pausedUntil === 'number' ? value.pausedUntil : null,
      branches: value.branches && typeof value.branches === 'object' ? value.branches : {},
      threads: value.threads && typeof value.threads === 'object' ? value.threads : {},
    }
  } catch {
    return null
  }
}

// GitHub's GraphQL budget is shared with everything else using gh; stop polling while it is low.
export const RATE_FLOOR = 300
export const RATE_BACKOFF_MS = 15 * 60 * 1000

export function pauseAfter(rate: { remaining: number; resetAt: string } | null, now: number): number | null {
  if (!rate || rate.remaining >= RATE_FLOOR) {
    return null
  }
  const reset = Date.parse(rate.resetAt)

  return Number.isNaN(reset) ? now + RATE_BACKOFF_MS : Math.max(reset, now + 60 * 1000)
}

export function isRateLimited(text: string): boolean {
  return /rate limit/i.test(text)
}

export type RowOptions = {
  automated: RegExp | null
  ticket: RegExp | null
  flakyChecks: string[]
}

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

function isPending(check: Check): boolean {
  return (!!check.status && check.status !== 'COMPLETED') || check.state === 'PENDING' || check.state === 'EXPECTED'
}

function isFailed(check: Check): boolean {
  return FAILED.includes(check.conclusion ?? '') || FAILED.includes(check.state ?? '')
}

export function summarizeCi(checks: Check[] | null): { ci: PrCi; done: number; total: number; failing: string[] } {
  const all = checks ?? []
  const done = all.filter(c => !isPending(c)).length
  const failing = all.filter(isFailed).map(c => c.name ?? c.context ?? 'check')
  if (all.length === 0) {
    return { ci: 'none', done, total: 0, failing }
  }
  if (failing.length > 0) {
    return { ci: 'fail', done, total: all.length, failing }
  }

  return { ci: all.some(isPending) ? 'running' : 'pass', done, total: all.length, failing }
}

type Event = { at: string; what: string }

function latest(events: Event[]): Event | null {
  return events.reduce<Event | null>((best, one) => (!best || one.at > best.at ? one : best), null)
}

// Each author's latest review, skipping pending ones and, unless `withComments`, comment-only ones.
function latestReviews(reviews: RawReview[], withComments: boolean): RawReview[] {
  const byAuthor = new Map<string, RawReview>()
  for (const review of reviews) {
    const login = review.author?.login
    if (!login || review.state === 'PENDING' || (!withComments && review.state === 'COMMENTED')) {
      continue
    }
    const previous = byAuthor.get(login)
    if (!previous || review.submittedAt > previous.submittedAt) {
      byAuthor.set(login, review)
    }
  }

  return [...byAuthor.values()]
}

function countApprovals(reviews: RawReview[]): number {
  return latestReviews(reviews, false).filter(r => r.state === 'APPROVED').length
}

export function ticketOf(text: string, ticket: RegExp | null): string | null {
  return ticket ? (ticket.exec(text)?.[0]?.toUpperCase() ?? null) : null
}

// The key a PR is remembered by (seen state); the repo keeps numbers from different repos apart.
export function rowKey(pr: { number: number; repo?: string }): string {
  return pr.repo ? `${pr.repo}#${pr.number}` : String(pr.number)
}

// The unresolved threads that wait for me: on my PR, any where someone else wrote last; on someone
// else's, the ones I started where someone else wrote last. My automated comments do not count as replies.
export function owedReplies(threads: ThreadSummary[], me: string, isMine: boolean, automated: RegExp | null): ThreadSummary[] {
  return threads.filter(thread => {
    const isMyLast = thread.last === me && !(automated && automated.test(thread.body))

    return !isMyLast && (isMine || thread.starter === me)
  })
}

export function toRow(
  raw: RawPr,
  me: string,
  seen: Record<string, string>,
  options: RowOptions,
  unresolved: number | null = null,
  threads: ThreadSummary[] | null = null,
): PrRow {
  const isMe = (author: Author) => author?.login === me
  const isAutomated = (body: string) => !!options.automated && options.automated.test(body)
  const mine: Event[] = [
    ...raw.comments.filter(c => isMe(c.author) && !isAutomated(c.body)).map(c => ({ at: c.createdAt, what: 'comment' })),
    ...raw.reviews.filter(r => isMe(r.author)).map(r => ({ at: r.submittedAt, what: 'review' })),
    ...raw.commits.filter(c => c.authors.some(a => a.login === me)).map(c => ({ at: c.committedDate, what: 'commit' })),
  ]
  const others: Event[] = [
    ...raw.comments
      .filter(c => c.author?.login && !isMe(c.author))
      .map(c => ({ at: c.createdAt, what: `comment by ${c.author?.login}` })),
    ...raw.reviews
      .filter(r => r.author?.login && !isMe(r.author) && r.state !== 'DISMISSED')
      .map(r => ({ at: r.submittedAt, what: `${r.state.toLowerCase().replace('_', ' ')} review by ${r.author?.login}` })),
    ...raw.commits
      .filter(c => c.authors.length > 0 && !c.authors.some(a => a.login === me))
      .map(c => ({ at: c.committedDate, what: `commit by ${c.authors[0]?.login ?? 'someone'}` })),
  ]
  const myLast = latest(mine)
  const otherLast = latest(others)
  const seenAt = seen[rowKey(raw)]
  const isNew = !!otherLast && !!myLast && otherLast.at > myLast.at && (!seenAt || otherLast.at > seenAt)
  const ci = summarizeCi(raw.statusCheckRollup)
  const isMine = isMe(raw.author)
  const myReview = raw.reviews
    .filter(r => isMe(r.author) && r.state !== 'PENDING')
    .reduce<RawReview | null>((best, one) => (!best || one.submittedAt > best.submittedAt ? one : best), null)
  let rereview: PrRow['rereview'] = null
  if (!isMine && myReview) {
    const since = (at: string) => at > myReview.submittedAt
    const commits = raw.commits.filter(c => since(c.committedDate)).length
    const isReplied = others.some(event => since(event.at) && !event.what.startsWith('commit'))
    rereview =
      commits > 0 || isReplied
        ? { at: myReview.submittedAt, state: myReview.state, oid: myReview.commitOid ?? null, commits, isReplied }
        : null
  }
  const isRequestedFromMe = (raw.reviewRequests ?? []).some(r => r.login === me)
  const isFlaky = (name: string) => options.flakyChecks.some(part => name.includes(part))

  const row: PrRow = {
    number: raw.number,
    repo: raw.repo ?? '',
    title: raw.title,
    url: raw.url ?? '',
    author: raw.author?.login ?? 'unknown',
    headRef: raw.headRefName ?? '',
    headOid: raw.headRefOid ?? null,
    baseRef: raw.baseRefName ?? '',
    state: raw.state ?? 'OPEN',
    isMine,
    isDraft: raw.isDraft,
    review: raw.reviewDecision ?? '',
    approvals: countApprovals(raw.reviews),
    reviewers: latestReviews(raw.reviews, true)
      .filter(r => !isMe(r.author))
      .map(r => ({ login: r.author?.login ?? '', state: r.state, at: r.submittedAt })),
    ci: ci.ci,
    ciDone: ci.done,
    ciTotal: ci.total,
    failingChecks: ci.failing,
    isFlakyOnly: ci.failing.length > 0 && ci.failing.every(isFlaky),
    hasConflicts: raw.mergeable === 'CONFLICTING' || raw.mergeStateStatus === 'DIRTY',
    isBehind: raw.mergeStateStatus === 'BEHIND',
    unresolved,
    replies: unresolved === 0 ? [] : threads && owedReplies(threads, me, isMine, options.automated),
    isRequestedFromMe,
    ticket: ticketOf(`${raw.title} ${raw.headRefName ?? ''}`, options.ticket),
    stackedOn: null,
    twin: null,
    hasMyActivity: !!myLast,
    hasLastWord: !!myLast && (!otherLast || myLast.at >= otherLast.at),
    lastOtherAt: otherLast?.at ?? null,
    lastOtherWhat: otherLast?.what ?? null,
    isNew,
    rereview,
    needsFirstReview: !isMine && isRequestedFromMe && !myReview,
    bucket: 'others',
  }

  return { ...row, bucket: bucketOf(row) }
}

export function bucketOf(pr: PrRow): PrBucket {
  if (pr.state !== 'OPEN') {
    return 'others'
  }
  const isCiBlocking = pr.ci === 'fail' && !pr.isFlakyOnly
  // A pending review request only needs me while someone else spoke last: a reply that is not a
  // formal review leaves the request open on GitHub, but the ball is in the author's court.
  const isRequestPending = pr.isRequestedFromMe && !pr.hasLastWord
  const owesReply = (pr.replies?.length ?? 0) > 0
  if (pr.isNew || isRequestPending || owesReply || (pr.isMine && (isCiBlocking || pr.hasConflicts))) {
    return 'me'
  }
  const isReady =
    pr.isMine &&
    !pr.isDraft &&
    pr.review === 'APPROVED' &&
    (pr.ci === 'pass' || pr.ci === 'none') &&
    !pr.unresolved &&
    !pr.hasConflicts &&
    pr.stackedOn === null

  return isReady ? 'ready' : 'others'
}

// Links each row to the open PR it is stacked on (its base is that PR's branch) and to its
// twin: the PR for the same ticket against the other twin base (a prod hotfix and its develop copy).
export function linkRows(
  rows: PrRow[],
  open: PrRow[],
  merged: MergedPr[],
  twinBases: string[],
  ticket: RegExp | null,
): PrRow[] {
  const byHead = new Map(open.map(pr => [`${pr.repo}:${pr.headRef}`, pr.number]))
  const candidates = [
    ...open.map(pr => ({ repo: pr.repo, number: pr.number, ticket: pr.ticket, base: pr.baseRef, state: 'OPEN' })),
    ...merged.map(pr => ({
      repo: pr.repository?.nameWithOwner ?? '',
      number: pr.number,
      ticket: ticketOf(`${pr.title} ${pr.headRefName}`, ticket),
      base: pr.baseRefName,
      state: 'MERGED',
    })),
  ]

  return rows.map(pr => {
    const parent = byHead.get(`${pr.repo}:${pr.baseRef}`)
    const stackedOn = parent !== undefined && parent !== pr.number && pr.state === 'OPEN' ? parent : null
    const match =
      pr.ticket && twinBases.includes(pr.baseRef)
        ? candidates.find(
            one =>
              one.repo === pr.repo &&
              one.number !== pr.number &&
              one.ticket === pr.ticket &&
              one.base !== pr.baseRef &&
              twinBases.includes(one.base),
          )
        : undefined
    const linked = { ...pr, stackedOn, twin: match ? { number: match.number, state: match.state } : null }

    return { ...linked, bucket: bucketOf(linked) }
  })
}

export function compileRegex(pattern: string | null, flags = ''): RegExp | null {
  if (!pattern) {
    return null
  }
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

export function ago(iso: string, now: number): string {
  const minutesAgo = Math.round((now - Date.parse(iso)) / 60000)
  if (minutesAgo < 1) {
    return 'just now'
  }
  if (minutesAgo < 60) {
    return `${minutesAgo}m ago`
  }
  const hours = Math.round(minutesAgo / 60)

  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

// Compact relative age for columns: 5m, 3h, 2d.
export function age(iso: string, now: number): string {
  const minutesAgo = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (minutesAgo < 60) {
    return `${minutesAgo}m`
  }
  const hours = Math.round(minutesAgo / 60)

  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

// One meaning per color: error = blocking me, warning = needs attention, success = good,
// dim = information. Colors are theme keys so they follow the person's light or dark theme.
export type Chip = { text: string; color?: 'error' | 'warning' | 'success' | 'merged'; dim?: boolean }

export function reviewChip(pr: PrRow): Chip {
  if (pr.state === 'MERGED') {
    return { text: 'merged', color: 'merged' }
  }
  if (pr.state === 'CLOSED') {
    return { text: 'closed', dim: true }
  }
  switch (pr.review) {
    case 'APPROVED':
      return { text: `✓ ${pr.approvals || 1}`, color: 'success' }
    case 'CHANGES_REQUESTED':
      return { text: '✗ changes', color: pr.isMine ? 'error' : 'warning' }
    default:
      return { text: pr.approvals > 0 ? `○ ${pr.approvals}` : '○ review', dim: true }
  }
}

export function ciChip(pr: PrRow): Chip {
  switch (pr.ci) {
    case 'pass':
      return { text: '✓ CI', color: 'success' }
    case 'fail':
      return pr.isFlakyOnly ? { text: '✗ CI~', color: 'warning' } : { text: '✗ CI', color: pr.isMine ? 'error' : 'warning' }
    case 'running':
      return { text: `◐ ${pr.ciDone}/${pr.ciTotal}`, dim: true }
    default:
      return { text: '– CI', dim: true }
  }
}

export function threadsChip(pr: PrRow): Chip {
  return pr.unresolved ? { text: `⚑${pr.unresolved}`, color: 'warning' } : { text: '·', dim: true }
}

// The chips that only show when they apply, most urgent first.
export function extraChips(pr: PrRow): Chip[] {
  const chips: Chip[] = []
  if (pr.bucket === 'ready') {
    chips.push({ text: '✓ ready', color: 'success' })
  }
  if (pr.hasConflicts) {
    chips.push({ text: '✗ conflicts', color: 'error' })
  } else if (pr.isBehind) {
    chips.push({ text: '↓ behind', color: 'warning' })
  }
  if (pr.replies && pr.replies.length > 0) {
    chips.push({ text: `↩ ${pr.replies.length}`, color: 'warning' })
  }
  if (pr.rereview) {
    const { commits, state } = pr.rereview
    const text = commits > 0 ? `Δ ${commits} commit${commits === 1 ? '' : 's'}` : 'Δ replies'
    chips.push(state === 'APPROVED' ? { text, dim: true } : { text, color: 'warning' })
  }
  if (pr.isRequestedFromMe) {
    chips.push(pr.hasLastWord ? { text: '◆ requested', dim: true } : { text: '◆ requested', color: 'warning' })
  }
  if (pr.stackedOn !== null) {
    chips.push({ text: `↳#${pr.stackedOn}`, dim: true })
  }
  if (pr.twin) {
    const isLagging = pr.twin.state === 'MERGED' && pr.state === 'OPEN'
    const isAhead = pr.state === 'MERGED' && pr.twin.state === 'OPEN'
    const suffix = pr.twin.state === 'MERGED' ? ' merged' : isAhead ? ' open' : ''
    chips.push(isLagging || isAhead ? { text: `⇄#${pr.twin.number}${suffix}`, color: 'warning' } : { text: `⇄#${pr.twin.number}${suffix}`, dim: true })
  }

  return chips
}

// The detail line of a selected row: what happened last and why CI is red.
export function detailOf(pr: PrRow, now: number): string {
  const parts: string[] = []
  const owed = pr.replies?.length ?? 0
  if (owed > 0) {
    parts.push(`${owed} thread${owed === 1 ? '' : 's'} waiting for your reply`)
  }
  if (pr.lastOtherWhat && pr.lastOtherAt) {
    parts.push(`last: ${pr.lastOtherWhat} · ${age(pr.lastOtherAt, now)} ago`)
  }
  if (pr.failingChecks.length > 0) {
    parts.push(`failing: ${pr.failingChecks.join(', ')}${pr.isFlakyOnly ? ' (flaky)' : ''}`)
  }

  return parts.join('  ·  ') || 'no activity from others yet'
}

export type Alert = { kind: 'new' | 'ready'; pr: PrRow; text: string; more: number }

// The band's second line: the one thing that needs me, if any. New activity beats ready to merge,
// the current branch's PR beats the others, and the rest are counted.
export function alertOf(current: PrRow | null, rows: PrRow[], now: number): Alert | null {
  const activity = (pr: PrRow) =>
    `${pr.lastOtherWhat ?? 'new activity'}${pr.lastOtherAt ? ` · ${age(pr.lastOtherAt, now)} ago` : ''}`
  const fresh = rows.filter(pr => pr.isNew && pr.number !== current?.number)
  if (current?.isNew) {
    return { kind: 'new', pr: current, text: activity(current), more: fresh.length }
  }
  const first = fresh[0]
  if (first) {
    return { kind: 'new', pr: first, text: activity(first), more: fresh.length - 1 }
  }
  const ready = rows.filter(pr => pr.bucket === 'ready' && pr.number !== current?.number)
  const done = ready[0]

  return done ? { kind: 'ready', pr: done, text: 'ready to merge', more: ready.length - 1 } : null
}

function withGuidance(text: string, guidance: string | undefined): string {
  return guidance ? `${text}\n\nProject guidance:\n${guidance}` : text
}

export function askPrompt(pr: PrRow, config: Config, report?: string): string {
  const text = askText(pr, config)

  return report ? `${text}\n\nA quick report I just read, to start from (verify before acting):\n${report}` : text
}

function askText(pr: PrRow, config: Config): string {
  const ref = `PR #${pr.number} (${pr.title})${pr.url ? ` ${pr.url}` : ''}`
  let text: string
  if (pr.isMine) {
    const activity = pr.isNew && pr.lastOtherWhat ? ` There is new activity: ${pr.lastOtherWhat}.` : ''
    text = `Check ${ref}, which we authored.${activity} Look at its current reviews, comments and CI, and give me your opinion on what needs a reply or a fix.`
  } else if (pr.hasMyActivity) {
    text = `Check ${ref}, which we already reviewed. See what the author changed or replied since our last review and give me your opinion.`
  } else {
    text = `Look at ${ref} by ${pr.author}: its reviews, comments and CI, and give me your opinion.`
  }

  return withGuidance(text, config.sections.opinion)
}

export type ReviewThread = {
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: { author: string; body: string; at: string }[]
}

export function reviewPrompt(pr: PrRow, config: Config): string {
  const text = `Review PR #${pr.number} (${pr.title})${pr.url ? ` ${pr.url}` : ''} by ${pr.author} with the github-pr-review skill. Do not post anything until I approve.`

  return withGuidance(text, config.sections.opinion)
}

// A review round scoped to what changed since our last review, starting from our own threads.
export function rereviewPrompt(
  pr: PrRow,
  threads: ReviewThread[],
  context: { me: string; headOid: string | null; reviewBody: string; offsetMinutes: number },
  config: Config,
): string | null {
  const last = pr.rereview
  if (!last) {
    return null
  }
  const short = (oid: string | null) => (oid ? oid.slice(0, 7) : 'unknown')
  const when = formatDate(last.at, context.offsetMinutes)
  const since = last.commits > 0 ? `${last.commits} commit${last.commits === 1 ? '' : 's'} since` : 'no new commits, only replies'
  const lines = [
    `Re-review PR #${pr.number} (${pr.title})${pr.url ? ` ${pr.url}` : ''} by ${pr.author} with the github-pr-review skill, scoped to what changed since our last review.`,
    '',
    `Our last review: ${last.state} on ${when} at commit ${short(last.oid)}. The head is now ${short(context.headOid)} (${since}).`,
  ]
  if (context.reviewBody.trim()) {
    lines.push(`Our review summary said: "${clip(context.reviewBody, 800)}"`)
  }
  const ours = threads.filter(thread => thread.comments[0]?.author === context.me)
  if (ours.length > 0) {
    lines.push('', 'Our review threads:')
    ours.forEach((thread, index) => {
      const where = `${thread.path}${thread.line ? `:${thread.line}` : ''}`
      const status = [thread.isResolved ? 'resolved' : 'unresolved', ...(thread.isOutdated ? ['outdated'] : [])].join(', ')
      const [first, ...replies] = thread.comments
      lines.push(`${index + 1}. ${where} (${status}): "${clip(first?.body, 400)}"`)
      for (const reply of replies) {
        lines.push(`   ↳ ${reply.author} ${formatDate(reply.at, context.offsetMinutes)}: "${clip(reply.body, 300)}"`)
      }
    })
  } else {
    lines.push('', 'We left no inline threads; work from the review summary and the conversation.')
  }
  const oid = last.oid ?? 'our last reviewed commit'
  lines.push(
    '',
    'Steps:',
    '1. For each of our threads, decide whether it is addressed, partly addressed or not addressed, citing the current code.',
    `2. Review only the PR's own changes since ${short(last.oid)}: fetch \`pull/${pr.number}/head\` and compare the PR's diff against ${pr.baseRef || 'its base'} at ${oid} with its diff at the head (for example \`git range-diff\` over the two merge-base ranges), ignoring anything merged in from ${pr.baseRef || 'the base branch'}. If ${short(last.oid)} can no longer be fetched because history was rewritten, say so and review the whole PR.`,
    '3. Draft a reply on each of our threads (for example "✓ addressed in <sha>", or what is still missing) and a review verdict with any new findings. Do not post anything until I approve.',
  )

  return withGuidance(lines.join('\n'), config.sections['re-review'])
}

export function cleanupPrompt(pr: PrRow, config: Config): string | null {
  const steps = config.sections.cleanup
  if (!steps) {
    return null
  }

  return `PR #${pr.number} (${pr.title}, branch ${pr.headRef}) is merged. Run this project's post-merge cleanup:\n\n${steps}`
}

export const REPORT_SYSTEM = [
  'You write an at-a-glance status report of one GitHub pull request for the person who asked.',
  'Be brief and concrete. Markdown, no preamble, no closing remarks. Sections, skipping any that would be empty:',
  '**Status**: one line (state, approvals, mergeability, CI).',
  '**Blocking**: what stops a merge right now.',
  '**Open threads**: who asked for what, and whether it was answered or addressed.',
  '**CI**: failing or pending checks only.',
  '**Next step**: one or two suggested actions.',
  'Dates in the input are already MM/DD/YYYY HH:MM in local time: copy them exactly, never convert them.',
  'Only state causes the timeline shows; when it does not say why something happened, say so plainly.',
  'Quote reviewer wording only when it matters.',
].join('\n')

export type ReportDismissal = { at?: string; actor?: string; message?: string | null; commit?: string | null }

export type ReportData = {
  pr: Record<string, unknown>
  inline: { user?: string; path?: string; line?: number | null; body?: string; created_at?: string }[]
  dismissals: ReportDismissal[]
  now: number
  offsetMinutes: number
}

function clip(text: string | undefined, max: number): string {
  const value = (text ?? '').trim()

  return value.length > max ? `${value.slice(0, max)}…` : value
}

const pad = (n: number) => String(n).padStart(2, '0')

// MM/DD/YYYY HH:MM in the person's local offset, so the model copies dates instead of converting them.
export function formatDate(at: string | number | undefined, offsetMinutes: number, withTime = true): string {
  const ms = typeof at === 'number' ? at : Date.parse(at ?? '')
  if (Number.isNaN(ms)) {
    return '??/??/????'
  }
  const d = new Date(ms + offsetMinutes * 60000)
  const date = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`

  return withTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date
}

// `date +%z` output (-0300) as minutes east of UTC.
export function parseOffset(raw: string): number {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(raw.trim())
  if (!match) {
    return 0
  }
  const minutes = Number(match[2]) * 60 + Number(match[3])

  return match[1] === '-' ? -minutes : minutes
}

type ReportCommit = { oid?: string; messageHeadline?: string; committedDate?: string; authors?: { login?: string; name?: string }[] }

export function reportPrompt(data: ReportData, config: Config): string {
  const pr = data.pr as {
    number?: number
    title?: string
    state?: string
    isDraft?: boolean
    author?: Author
    headRefName?: string
    baseRefName?: string
    reviewDecision?: string | null
    mergeable?: string
    mergeStateStatus?: string
    additions?: number
    deletions?: number
    changedFiles?: number
    statusCheckRollup?: Check[] | null
    reviews?: RawReview[]
    comments?: RawComment[]
    commits?: ReportCommit[]
  }
  const when = (at: string | undefined) => formatDate(at, data.offsetMinutes)
  const events: { at: string; text: string }[] = [
    ...(pr.commits ?? []).map(c => ({
      at: c.committedDate ?? '',
      text: `commit ${(c.oid ?? '').slice(0, 7)} by ${c.authors?.[0]?.login || c.authors?.[0]?.name || 'someone'}: ${clip(c.messageHeadline, 200)}`,
    })),
    ...(pr.reviews ?? []).map(r => ({
      at: r.submittedAt,
      text: `review by ${r.author?.login}, ${r.state}${r.state === 'DISMISSED' ? ' (see the dismissal entry for why)' : ''}: ${clip(r.body, 1500)}`,
    })),
    ...data.dismissals.map(d => ({
      at: d.at ?? '',
      text: d.message
        ? `review dismissed by ${d.actor}: ${clip(d.message, 500)}`
        : d.commit
          ? `review dismissed as stale when ${d.actor} pushed commit ${d.commit.slice(0, 7)} (automatic, no message)`
          : `review dismissed by ${d.actor}, no message`,
    })),
    ...(pr.comments ?? []).map(c => ({ at: c.createdAt, text: `comment by ${c.author?.login}: ${clip(c.body, 1500)}` })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  const lines: string[] = [
    `Today is ${formatDate(data.now, data.offsetMinutes, false)}.`,
    '',
    `PR #${pr.number}: ${pr.title}`,
    `State: ${pr.state}${pr.isDraft ? ' (draft)' : ''} · author ${pr.author?.login} · ${pr.headRefName} → ${pr.baseRefName}`,
    `Review decision: ${pr.reviewDecision || 'none'} · mergeable: ${pr.mergeable} (${pr.mergeStateStatus})`,
    `Size: +${pr.additions} −${pr.deletions} in ${pr.changedFiles} files`,
    '',
    '## Checks',
    ...(pr.statusCheckRollup ?? []).map(c => `- ${c.name ?? c.context}: ${c.conclusion || c.state || c.status}`),
    '',
    '## Timeline (oldest first)',
    ...events.map(e => `- ${when(e.at)} ${e.text}`),
    '',
    '## Inline review comments',
    ...data.inline.map(c => `- ${when(c.created_at)} ${c.user} on ${c.path}:${c.line ?? '?'}: ${clip(c.body, 800)}`),
  ]
  const prompt = clip(lines.join('\n'), 60000)
  const focus = config.sections['report focus']

  return focus ? `${prompt}\n\n## What to focus on\n${focus}` : prompt
}

// A PR put aside until something new happens on it (lastOtherAt moves) or, with `until`, that time passes.
export type Snooze = { lastOtherAt: string | null; until: number | null }

export function isSnoozed(pr: PrRow, snooze: Snooze | undefined, now: number): boolean {
  if (!snooze || pr.state !== 'OPEN') {
    return false
  }
  const isSameActivity = (pr.lastOtherAt ?? null) === snooze.lastOtherAt

  return isSameActivity && (snooze.until === null || snooze.until > now)
}

export function applySnoozes(rows: PrRow[], snoozed: Record<string, Snooze>, now: number): PrRow[] {
  return rows.map(pr => (isSnoozed(pr, snoozed[rowKey(pr)], now) ? { ...pr, isNew: false, bucket: 'snoozed' as const } : pr))
}

// 9:00 tomorrow, local time.
export function tomorrowMorning(now: number): number {
  const at = new Date(now)
  at.setDate(at.getDate() + 1)
  at.setHours(9, 0, 0, 0)

  return at.getTime()
}

// How long a PR has waited on me: warning after a day, error after three.
export function staleness(pr: PrRow, now: number): 'warning' | 'error' | null {
  if (pr.bucket !== 'me' || !pr.lastOtherAt) {
    return null
  }
  const hours = (now - Date.parse(pr.lastOtherAt)) / 3600000

  return hours >= 72 ? 'error' : hours >= 24 ? 'warning' : null
}

// On my open PR: the reviewers whose latest review is not an approval, to ask again after changes.
export function rerequestable(pr: PrRow): string[] {
  if (!pr.isMine || pr.state !== 'OPEN') {
    return []
  }

  return pr.reviewers.filter(r => r.login && r.state !== 'APPROVED').map(r => r.login)
}

export const DIGEST_SYSTEM = [
  'You triage the open pull requests of the person who asked, so they know what to do first today.',
  'Be brief and concrete. Markdown, no preamble, no closing remarks. Sections, skipping any that would be empty:',
  '**Do first**: up to three items, most urgent first, each one line with the PR number and the action.',
  '**Then**: the rest of what waits on them, one line each.',
  '**Ready to merge**: PR numbers only.',
  '**Waiting on others**: one line naming what is stuck and on whom, only if something looks stalled.',
  'Weigh blocking things (red CI on their PRs, conflicts, review requests, replies owed) over nice-to-haves, and older waits over newer ones.',
  'Dates in the input are already MM/DD/YYYY HH:MM in local time: copy them exactly. Only use what the input says.',
].join('\n')

export function digestPrompt(rows: PrRow[], data: { me: string; now: number; offsetMinutes: number }, focus?: string): string {
  const when = (at: string | null) => (at ? formatDate(at, data.offsetMinutes) : 'never')
  const describe = (pr: PrRow) => {
    const facts = [
      pr.isMine ? 'mine' : `by ${pr.author}`,
      `${pr.headRef} → ${pr.baseRef}`,
      `review: ${pr.review || 'none'}, ${pr.approvals} approvals`,
      `CI: ${pr.ci}${pr.failingChecks.length > 0 ? ` (failing: ${pr.failingChecks.join(', ')}${pr.isFlakyOnly ? ', known flaky' : ''})` : ''}`,
      ...(pr.unresolved ? [`${pr.unresolved} unresolved threads`] : []),
      ...(pr.replies && pr.replies.length > 0 ? [`${pr.replies.length} review threads wait for my reply`] : []),
      ...(pr.hasConflicts ? ['merge conflicts'] : pr.isBehind ? ['behind its base'] : []),
      ...(pr.isRequestedFromMe ? [pr.hasLastWord ? 'my review was requested, I spoke last' : 'my review is requested'] : []),
      ...(pr.rereview ? [`changed since my ${pr.rereview.state} review on ${when(pr.rereview.at)}: ${pr.rereview.commits} commits${pr.rereview.isReplied ? ', replies' : ''}`] : []),
      ...(pr.twin ? [`twin #${pr.twin.number} is ${pr.twin.state}`] : []),
      ...(pr.stackedOn !== null ? [`stacked on #${pr.stackedOn}`] : []),
      `last from others: ${pr.lastOtherWhat ?? 'nothing'} (${when(pr.lastOtherAt)})`,
    ]

    return `- ${pr.repo}#${pr.number} "${pr.title}": ${facts.join('; ')}`
  }
  const group = (bucket: PrBucket, title: string) => {
    const some = rows.filter(pr => pr.bucket === bucket)

    return some.length > 0 ? ['', `## ${title}`, ...some.map(describe)] : []
  }
  const lines = [
    `Today is ${formatDate(data.now, data.offsetMinutes)}. I am ${data.me}.`,
    ...group('me', 'Waiting on me'),
    ...group('ready', 'Ready to merge'),
    ...group('others', 'Waiting on others'),
  ]
  const snoozed = rows.filter(pr => pr.bucket === 'snoozed').length
  if (snoozed > 0) {
    lines.push('', `(${snoozed} snoozed PRs left out on purpose.)`)
  }
  const prompt = clip(lines.join('\n'), 60000)

  return focus ? `${prompt}\n\n## What to focus on\n${focus}` : prompt
}

export type ChangesData = {
  pr: PrRow
  since: { at: string; oid: string | null }
  commits: { oid: string; headline: string; author: string; at: string; isMerge: boolean }[]
  // Files changed since the reviewed commit, or null when that commit is gone (history rewritten).
  files: { path: string; status: string; additions: number; deletions: number }[] | null
  prFiles: string[]
  offsetMinutes: number
}

// What changed on a PR since my last review, as markdown: commits, then the PR's files they touched.
export function changesMarkdown(data: ChangesData): string {
  const short = (oid: string | null) => (oid ? oid.slice(0, 7) : 'unknown')
  const when = (at: string) => formatDate(at, data.offsetMinutes)
  const newer = data.commits.filter(c => c.at > data.since.at)
  const lines = [`Since my **${data.pr.rereview?.state ?? 'last'}** review on ${when(data.since.at)} at \`${short(data.since.oid)}\`:`, '']
  lines.push(`**Commits** (${newer.length})`)
  for (const c of newer) {
    lines.push(`- \`${short(c.oid)}\` ${when(c.at)} ${c.author}: ${c.isMerge ? `${c.headline} (merge)` : c.headline}`)
  }
  if (newer.length === 0) {
    lines.push('- none; only replies since')
  }
  lines.push('')
  if (data.files === null) {
    lines.push(`**Files**: \`${short(data.since.oid)}\` is no longer in the history (rebased or force-pushed), so the files since then are unknown.`)

    return lines.join('\n')
  }
  const inPr = new Set(data.prFiles)
  const own = data.files.filter(f => inPr.has(f.path))
  const fromBase = data.files.length - own.length
  lines.push(`**Files** (${own.length})`)
  for (const f of own) {
    lines.push(`- ${f.path} \`+${f.additions} −${f.deletions}\`${f.status === 'added' ? ' (new)' : f.status === 'removed' ? ' (deleted)' : ''}`)
  }
  if (fromBase > 0) {
    lines.push('', `${fromBase} more files changed only by what was merged in from ${data.pr.baseRef || 'the base'}; left out.`)
  }

  return lines.join('\n')
}

function threadWhere(thread: ThreadSummary): string {
  return `${thread.path}${thread.line ? `:${thread.line}` : ''}${thread.isOutdated ? ' (outdated)' : ''}`
}

// The threads waiting for my reply, as markdown for the threads panel.
export function threadsMarkdown(pr: PrRow, offsetMinutes: number): string {
  const owed = pr.replies ?? []
  if (owed.length === 0) {
    return 'No review threads are waiting for your reply.'
  }

  return owed
    .map(thread =>
      [
        `**${threadWhere(thread)}**`,
        `started by ${thread.starter || 'someone'} · last from ${thread.last || 'someone'} on ${formatDate(thread.at, offsetMinutes)}`,
        ...clip(thread.body, 600)
          .split('\n')
          .map(line => `  ${line}`),
      ].join('\n'),
    )
    .join('\n\n')
}

export function repliesPrompt(pr: PrRow, config: Config): string | null {
  const owed = pr.replies ?? []
  if (owed.length === 0) {
    return null
  }
  const lines = [
    `Help me answer the review threads on PR #${pr.number} (${pr.title})${pr.url ? ` ${pr.url}` : ''} that wait for our reply.`,
    'For each one, read the thread and the current code, then draft a reply (and the change, if one is needed). Do not post or push anything until I approve.',
    '',
    'Threads:',
    ...owed.map((thread, index) => `${index + 1}. ${threadWhere(thread)}, last from ${thread.last}: "${clip(thread.body, 400)}"`),
  ]

  return withGuidance(lines.join('\n'), config.sections.opinion)
}
