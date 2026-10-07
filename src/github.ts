import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrRow } from './types'
import { isRateLimited, parseCache } from './lib/lib'
import type { ChangesData, GqlPr, MergedPr, PrThreads, ReviewThread, SharedCache, Snooze, ThreadSummary } from './lib/lib'

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export async function run(argv: string[], cwd?: string): Promise<RunResult> {
  try {
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 30000 })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    return { exitCode, stdout, stderr }
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

export function gh(args: string[], cwd?: string): Promise<RunResult> {
  return run(['gh', ...args], cwd)
}

// Asks only for what the rows read: about 2 GraphQL points, where `gh pr list --json` with the same fields costs 32.
const REFRESH_QUERY = `fragment row on PullRequest {
  number title url author { login } headRefName headRefOid baseRefName state isDraft reviewDecision mergeable mergeStateStatus
  updatedAt repository { nameWithOwner }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  latest: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    ... on StatusContext { context state }
    ... on CheckRun { name status conclusion }
  } } } } } }
  commits(last: 20) { nodes { commit { committedDate author { user { login } } } } }
  comments(last: 30) { nodes { author { login } body createdAt } }
  reviews(last: 30) { nodes { author { login } state submittedAt commit { oid } } }
  reviewThreads(first: 100) { nodes { isResolved } }
}
query($open: String!, $merged: String!, $limit: Int!, $owner: String!, $name: String!, $branch: String!,
      $withOpen: Boolean!, $withMerged: Boolean!, $withBranch: Boolean!) {
  viewer { login }
  rateLimit { remaining resetAt }
  open: search(query: $open, type: ISSUE, first: $limit) @include(if: $withOpen) { nodes { ...row } }
  merged: search(query: $merged, type: ISSUE, first: $limit) @include(if: $withMerged) {
    nodes { ... on PullRequest { number title headRefName baseRefName repository { nameWithOwner } } }
  }
  repository(owner: $owner, name: $name) @include(if: $withBranch) {
    pullRequests(headRefName: $branch, first: 1, states: [OPEN, MERGED, CLOSED], orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { ...row }
    }
  }
}`

export type Rate = { remaining: number; resetAt: string }
export type Fetched = { me: string; open: GqlPr[]; merged: MergedPr[]; branchPr: GqlPr | null; rate: Rate | null }
export type FetchFailure = { failure: string; isLimited: boolean }

export type FetchRequest = {
  // owner/name to limit the searches to; null searches every repo.
  searchRepo: string | null
  withOpen: boolean
  withMerged: boolean
  // The repo and branch whose PR to look up; null skips it.
  branch: { repo: string; name: string } | null
}

export async function fetchPrs(request: FetchRequest): Promise<Fetched | FetchFailure> {
  const scope = request.searchRepo ? ` repo:${request.searchRepo}` : ''
  const [owner = '', name = ''] = (request.branch?.repo ?? '').split('/')
  const result = await gh([
    'api',
    'graphql',
    '-f',
    `query=${REFRESH_QUERY}`,
    '-f',
    `open=involves:@me is:pr is:open${scope}`,
    '-f',
    `merged=involves:@me is:pr is:merged${scope}`,
    '-F',
    `limit=${request.searchRepo ? 30 : 50}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-f',
    `branch=${request.branch?.name ?? ''}`,
    '-F',
    `withOpen=${request.withOpen}`,
    '-F',
    `withMerged=${request.withMerged}`,
    '-F',
    `withBranch=${!!request.branch}`,
  ])
  if (result.exitCode !== 0) {
    const text = `${result.stderr}\n${result.stdout}`

    return { failure: result.stderr.trim() || 'gh api graphql failed', isLimited: isRateLimited(text) }
  }
  type Data = {
    viewer: { login: string }
    rateLimit: Rate | null
    open?: { nodes: GqlPr[] }
    merged?: { nodes: MergedPr[] }
    repository?: { pullRequests: { nodes: GqlPr[] } } | null
  }
  const data = (JSON.parse(result.stdout) as { data: Data }).data
  const isPr = (node: { number?: number }) => typeof node.number === 'number'

  return {
    me: data.viewer.login,
    open: (data.open?.nodes ?? []).filter(isPr),
    merged: (data.merged?.nodes ?? []).filter(isPr),
    branchPr: data.repository?.pullRequests.nodes[0] ?? null,
    rate: data.rateLimit,
  }
}

// Shared with the pr-monitor plugin: a repo's file has the same name and shape, so either one reuses the other's fetch.
const STATE_DIR = join(homedir(), '.claude', 'pr-monitor')

export function cachePath(repo: string | null): string {
  return join(STATE_DIR, 'cache', `${repo ? repo.replace('/', '__') : '_all'}.json`)
}

export async function readCache(path: string): Promise<SharedCache | null> {
  try {
    return parseCache(await Bun.file(path).text())
  } catch {
    return null
  }
}

export async function writeCache(path: string, cache: SharedCache): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, JSON.stringify(cache))
  } catch {
    // The next run simply fetches for itself.
  }
}

// What the CLI remembers between runs; the plugin keeps its own copy in its plugin store.
// The unresolved threads of the given PRs (repo#number keys), in one query of about 2 points per PR.
export async function fetchThreadSummaries(keys: string[]): Promise<Record<string, PrThreads> | null> {
  const targets = keys.slice(0, 20).flatMap(key => {
    const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(key)

    return match ? [{ key, owner: match[1] ?? '', name: match[2] ?? '', number: Number(match[3]) }] : []
  })
  if (targets.length === 0) {
    return {}
  }
  const fields = `updatedAt reviewThreads(first: 100) { nodes {
    isResolved isOutdated path line originalLine
    first: comments(first: 1) { nodes { author { login } } }
    last: comments(last: 1) { nodes { author { login } body createdAt url } }
  } }`
  const query = `query { ${targets
    .map((one, index) => `p${index}: repository(owner: ${JSON.stringify(one.owner)}, name: ${JSON.stringify(one.name)}) { pullRequest(number: ${one.number}) { ${fields} } }`)
    .join('\n')} }`
  const result = await gh(['api', 'graphql', '-f', `query=${query}`])
  if (result.exitCode !== 0) {
    return null
  }
  type Author = { login?: string } | null
  type Thread = {
    isResolved: boolean
    isOutdated: boolean
    path: string
    line: number | null
    originalLine: number | null
    first: { nodes: { author: Author }[] }
    last: { nodes: { author: Author; body: string; createdAt: string; url: string }[] }
  }
  type Pr = { updatedAt: string; reviewThreads: { nodes: Thread[] } } | null
  const data = (JSON.parse(result.stdout) as { data: Record<string, { pullRequest: Pr } | null> }).data
  const out: Record<string, PrThreads> = {}
  targets.forEach((one, index) => {
    const pr = data[`p${index}`]?.pullRequest
    if (!pr) {
      return
    }
    const unresolved: ThreadSummary[] = pr.reviewThreads.nodes
      .filter(thread => !thread.isResolved)
      .map(thread => {
        const last = thread.last.nodes[0]

        return {
          path: thread.path,
          line: thread.line ?? thread.originalLine,
          isOutdated: thread.isOutdated,
          starter: thread.first.nodes[0]?.author?.login ?? '',
          last: last?.author?.login ?? '',
          body: (last?.body ?? '').slice(0, 500),
          at: last?.createdAt ?? '',
          url: last?.url ?? '',
        }
      })
    out[one.key] = { updatedAt: pr.updatedAt, unresolved }
  })

  return out
}

export type CliState = {
  seen: Record<string, string>
  collapsed: string[]
  // Where each repo was last seen on disk (owner/name → root), so --all can read its config.
  repos: Record<string, string>
  snoozed: Record<string, Snooze>
}

const STATE_PATH = join(STATE_DIR, 'cli-state.json')

export async function readState(): Promise<CliState> {
  try {
    const value = JSON.parse(await Bun.file(STATE_PATH).text()) as Partial<CliState>
    const isMap = (one: unknown): one is Record<string, string> => !!one && typeof one === 'object' && !Array.isArray(one)

    return {
      seen: isMap(value.seen) ? value.seen : {},
      collapsed: Array.isArray(value.collapsed) ? value.collapsed : ['others', 'snoozed'],
      repos: isMap(value.repos) ? value.repos : {},
      snoozed: value.snoozed && typeof value.snoozed === 'object' ? value.snoozed : {},
    }
  } catch {
    return { seen: {}, collapsed: ['others', 'snoozed'], repos: {}, snoozed: {} }
  }
}

// Merged over the file, so what another terminal saved meanwhile is kept. A null snooze removes it.
export async function updateState(patch: Partial<Omit<CliState, 'snoozed'>> & { snoozed?: Record<string, Snooze | null> }): Promise<CliState> {
  const stored = await readState()
  const snoozed = { ...stored.snoozed }
  for (const [key, one] of Object.entries(patch.snoozed ?? {})) {
    if (one) {
      snoozed[key] = one
    } else {
      delete snoozed[key]
    }
  }
  const next: CliState = {
    seen: { ...stored.seen, ...patch.seen },
    collapsed: patch.collapsed ?? stored.collapsed,
    repos: { ...stored.repos, ...patch.repos },
    snoozed,
  }
  await mkdir(STATE_DIR, { recursive: true })
  await Bun.write(STATE_PATH, JSON.stringify(next))

  return next
}

// Fetched when Re-review is pressed: our threads with their replies, and our last review's summary.
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviews(last: 30) { nodes { author { login } state body submittedAt } }
      reviewThreads(first: 100) { nodes {
        isResolved isOutdated path line originalLine
        comments(first: 20) { nodes { author { login } body createdAt } }
      } }
    }
  }
}`

export type Threads = {
  headOid: string
  reviews: { author: string; body: string; at: string }[]
  threads: ReviewThread[]
}

export async function fetchThreads(repo: string, number: number): Promise<Threads | null> {
  const [owner = '', name = ''] = repo.split('/')
  const result = await gh(['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`])
  if (result.exitCode !== 0) {
    return null
  }
  type Author = { login?: string } | null
  type Data = {
    headRefOid: string
    reviews: { nodes: { author: Author; state: string; body: string; submittedAt: string }[] }
    reviewThreads: {
      nodes: {
        isResolved: boolean
        isOutdated: boolean
        path: string
        line: number | null
        originalLine: number | null
        comments: { nodes: { author: Author; body: string; createdAt: string }[] }
      }[]
    }
  }
  const data = (JSON.parse(result.stdout) as { data: { repository: { pullRequest: Data } } }).data.repository.pullRequest

  return {
    headOid: data.headRefOid,
    reviews: data.reviews.nodes.map(r => ({ author: r.author?.login ?? '', body: r.body, at: r.submittedAt })),
    threads: data.reviewThreads.nodes.map(thread => ({
      path: thread.path,
      line: thread.line ?? thread.originalLine,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      comments: thread.comments.nodes.map(c => ({ author: c.author?.login ?? 'someone', body: c.body, at: c.createdAt })),
    })),
  }
}

// Commits and files since my last review, for the changes view. Fetched only when asked.
export async function fetchChanges(pr: PrRow, offsetMinutes: number): Promise<ChangesData | { failure: string }> {
  const since = pr.rereview
  if (!since) {
    return { failure: 'No review of mine to compare against' }
  }
  const [owner = '', name = ''] = pr.repo.split('/')
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      headRefOid
      commits(last: 100) { nodes { commit { oid messageHeadline committedDate parents { totalCount } author { name user { login } } } } }
    } }
  }`
  const result = await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr.number}`])
  if (result.exitCode !== 0) {
    return { failure: result.stderr.trim() || 'gh api graphql failed' }
  }
  type Node = { commit: { oid: string; messageHeadline: string; committedDate: string; parents: { totalCount: number }; author: { name?: string; user: { login?: string } | null } | null } }
  const data = (JSON.parse(result.stdout) as { data: { repository: { pullRequest: { headRefOid: string; commits: { nodes: Node[] } } } } }).data.repository.pullRequest
  const commits = data.commits.nodes.map(({ commit }) => ({
    oid: commit.oid,
    headline: commit.messageHeadline,
    author: commit.author?.user?.login ?? commit.author?.name ?? 'someone',
    at: commit.committedDate,
    isMerge: commit.parents.totalCount > 1,
  }))

  let files: ChangesData['files'] = null
  if (since.oid) {
    const [compared, prFiles] = await Promise.all([
      gh(['api', `repos/${pr.repo}/compare/${since.oid}...${data.headRefOid}`, '--jq', '.files[] | {path: .filename, status, additions, deletions}']),
      gh(['api', `repos/${pr.repo}/pulls/${pr.number}/files`, '--paginate', '--jq', '.[].filename']),
    ])
    if (compared.exitCode === 0) {
      files = compared.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as NonNullable<ChangesData['files']>[number])
    }

    return { pr, since: { at: since.at, oid: since.oid }, commits, files, prFiles: prFiles.stdout.split('\n').filter(Boolean), offsetMinutes }
  }

  return { pr, since: { at: since.at, oid: since.oid }, commits, files, prFiles: [], offsetMinutes }
}

export type Done = { ok: boolean; text: string }

function done(result: RunResult, success: string): Done {
  return result.exitCode === 0 ? { ok: true, text: success } : { ok: false, text: result.stderr.trim().split('\n')[0] || 'gh failed' }
}

export async function mergePr(pr: PrRow, method: 'merge' | 'squash' | 'rebase'): Promise<Done> {
  return done(await gh(['pr', 'merge', String(pr.number), '--repo', pr.repo, `--${method}`]), `Merged #${pr.number} into ${pr.baseRef}`)
}

export async function updateBranch(pr: PrRow): Promise<Done> {
  return done(await gh(['pr', 'update-branch', String(pr.number), '--repo', pr.repo]), `Updated #${pr.number} with ${pr.baseRef}`)
}

export async function checkoutPr(pr: PrRow, root: string): Promise<Done> {
  return done(await gh(['pr', 'checkout', String(pr.number)], root), `Checked out #${pr.number} (${pr.headRef})`)
}

export async function rerequestReview(pr: PrRow, logins: string[]): Promise<Done> {
  const reviewers = logins.flatMap(login => ['-f', `reviewers[]=${login}`])

  return done(
    await gh(['api', '-X', 'POST', `repos/${pr.repo}/pulls/${pr.number}/requested_reviewers`, ...reviewers, '--silent']),
    `Asked ${logins.join(', ')} to review #${pr.number} again`,
  )
}
