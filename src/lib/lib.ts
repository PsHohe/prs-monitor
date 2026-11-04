import type { PrBucket, PrCi, PrRow } from '../types'

export type Config = {
  pollMinutes: number
  onNewReview: 'notify' | 'ask'
  reportProvider: ReportProvider
  // The Claude model; Codex has its own key so a repo's Claude model never reaches Codex. '' is Codex's default.
  reportModel: string
  codexModel: string
  // The AI review's Claude model and effort, apart from the report's: a full review is worth more thought.
  reviewModel: string
  reviewEffort: Effort
  automatedComments: string | null
  ticketPattern: string | null
  twinBases: string[]
  flakyChecks: string[]
  mergeMethod: 'merge' | 'squash' | 'rebase'
  sections: Record<string, string>
}

export type ReportProvider = 'claude' | 'codex'
export const REPORT_PROVIDERS: ReportProvider[] = ['claude', 'codex']

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

export const DEFAULT_CONFIG: Config = {
  pollMinutes: 3,
  onNewReview: 'notify',
  reportProvider: 'claude',
  reportModel: 'sonnet',
  codexModel: '',
  reviewModel: 'opus',
  reviewEffort: 'high',
  automatedComments: null,
  ticketPattern: null,
  twinBases: [],
  flakyChecks: [],
  mergeMethod: 'merge',
  sections: {},
}

// How each merge method reads in a question: "Merge #12 into main with squash?"
export const MERGE_WORDS = { merge: 'a merge commit', squash: 'squash', rebase: 'rebase' } as const

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

// The file with these frontmatter keys set: each existing line is replaced in place, new keys go at the
// end of the frontmatter (made if missing), and an empty value removes the key.
export function setFrontmatter(text: string, values: Record<string, string>): string {
  const front = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/.exec(text)
  const body = front ? text.slice(front[0].length) : text
  const lines = front?.[1] ? front[1].split(/\r?\n/) : []
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex(line => new RegExp(`^${key}\\s*:`).test(line))
    const line = `${key}: ${value}`
    if (index < 0) {
      if (value) {
        lines.push(line)
      }
    } else if (value) {
      lines[index] = line
    } else {
      lines.splice(index, 1)
    }
  }

  return lines.length > 0 ? `---\n${lines.join('\n')}\n---\n${body}` : body
}

// The model a report uses, as shown next to it.
export function reportModelLabel(config: Config): string {
  return config.reportProvider === 'codex' ? `codex · ${config.codexModel || 'default'}` : config.reportModel
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
    const provider = v.report_provider
    const effort = EFFORTS.find(one => one === v.review_effort)

    return {
      pollMinutes: minutes(v.poll_interval) ?? config.pollMinutes,
      onNewReview: review === 'ask' || review === 'notify' ? review : config.onNewReview,
      reportProvider: provider === 'claude' || provider === 'codex' ? provider : config.reportProvider,
      reportModel: v.report_model || config.reportModel,
      codexModel: v.codex_model ?? config.codexModel,
      reviewModel: v.review_model || config.reviewModel,
      reviewEffort: effort ?? config.reviewEffort,
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
    // UNSTABLE is only checks that are not required failing; GitHub still offers its merge button.
    canMerge: (raw.state ?? 'OPEN') === 'OPEN' && !raw.isDraft && ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(raw.mergeStateStatus ?? ''),
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
    // Passing is the usual case, so it stays quiet and the failures stand out.
    case 'pass':
      return { text: '✓ CI', dim: true }
    case 'fail':
      return pr.isFlakyOnly ? { text: '✗ CI~', color: 'warning' } : { text: '✗ CI', color: pr.isMine ? 'error' : 'warning' }
    case 'running':
      return { text: `◐ ${pr.ciDone}/${pr.ciTotal}`, dim: true }
    default:
      return { text: '– CI', dim: true }
  }
}

// ↩ when every unresolved thread waits for my reply, ⚑ otherwise.
export function threadsChip(pr: PrRow): Chip {
  if (!pr.unresolved) {
    return { text: '·', dim: true }
  }

  return { text: `${isAllOwed(pr) ? '↩' : '⚑'}${pr.unresolved}`, color: 'warning' }
}

function isAllOwed(pr: PrRow): boolean {
  return !!pr.unresolved && pr.replies?.length === pr.unresolved
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
  if (pr.replies && pr.replies.length > 0 && !isAllOwed(pr)) {
    chips.push({ text: `↩${pr.replies.length}`, color: 'warning' })
  }
  if (pr.rereview) {
    const { commits, state } = pr.rereview
    const text = commits > 0 ? `Δ${commits}` : 'Δ replies'
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

// My PRs whose CI started failing since the last refresh: on a check that is not only flaky, or again on a new push.
// Snoozed PRs and PRs not seen before are left out, so the first load stays quiet.
export function newCiFailures(before: PrRow[], next: PrRow[]): PrRow[] {
  const isBlocking = (pr: PrRow) => pr.ci === 'fail' && !pr.isFlakyOnly
  const was = new Map(before.map(pr => [rowKey(pr), pr]))

  return next.filter(pr => {
    const old = was.get(rowKey(pr))

    return pr.isMine && pr.bucket !== 'snoozed' && isBlocking(pr) && !!old && (!isBlocking(old) || old.headOid !== pr.headOid)
  })
}

export type ReviewThread = {
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: { author: string; body: string; at: string }[]
}

// A thread as the threads panel needs it, to show it whole and act on it.
export type ThreadDetail = ReviewThread & { id: string; diffHunk: string; url: string; canReply: boolean; canResolve: boolean }

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

export type Conversation = {
  pr: PrRow
  body: string
  createdAt: string
  additions: number
  deletions: number
  changedFiles: number
  commits: number
  comments: { author: string; body: string; at: string }[]
  reviews: { author: string; state: string; body: string; at: string | null }[]
  threads: (ReviewThread & { at: string })[]
  offsetMinutes: number
}

// The unresolved threads for the threads panel, those waiting for my reply first.
export function threadPages(
  threads: ThreadDetail[],
  context: { me: string; isMine: boolean; automated: RegExp | null },
): { thread: ThreadDetail; isOwed: boolean }[] {
  const open = threads.filter(thread => !thread.isResolved)
  const summary = (thread: ThreadDetail): ThreadSummary => {
    const last = thread.comments.at(-1)

    return {
      path: thread.path,
      line: thread.line,
      isOutdated: thread.isOutdated,
      starter: thread.comments[0]?.author ?? '',
      last: last?.author ?? '',
      body: last?.body ?? '',
      at: last?.at ?? '',
      url: thread.url,
    }
  }
  const owed = new Set(owedReplies(open.map(summary), context.me, context.isMine, context.automated).map(one => one.url))
  const pages = open.map(thread => ({ thread, isOwed: owed.has(thread.url) }))

  return [...pages.filter(one => one.isOwed), ...pages.filter(one => !one.isOwed)]
}
