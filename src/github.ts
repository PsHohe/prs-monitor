import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrRow } from './types'
import { isRateLimited, parseCache } from './lib/lib'
import type { ChangesData, Conversation, GqlPr, MergedPr, PrThreads, SharedCache, Snooze, TeamPr, ThreadDetail, ThreadSummary } from './lib/lib'

export type RunResult = { exitCode: number; stdout: string; stderr: string }

// input is written to the command's stdin.
export async function run(argv: string[], cwd?: string, input?: string): Promise<RunResult> {
  try {
    const proc = Bun.spawn(argv, { cwd, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe', timeout: 30000 })
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

// Fetched when Re-review is pressed or the threads are viewed: the threads with their replies, and the reviews' summaries.
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviews(last: 30) { nodes { author { login } state body submittedAt } }
      reviewThreads(first: 100) { nodes {
        id isResolved isOutdated path line originalLine viewerCanReply viewerCanResolve
        hunk: comments(first: 1) { nodes { diffHunk } }
        comments(first: 20) { nodes { author { login } body createdAt url } }
      } }
    }
  }
}`

export type Threads = {
  headOid: string
  reviews: { author: string; body: string; at: string }[]
  threads: ThreadDetail[]
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
        id: string
        isResolved: boolean
        isOutdated: boolean
        path: string
        line: number | null
        originalLine: number | null
        viewerCanReply: boolean
        viewerCanResolve: boolean
        hunk: { nodes: { diffHunk: string }[] }
        comments: { nodes: { author: Author; body: string; createdAt: string; url: string }[] }
      }[]
    }
  }
  const data = (JSON.parse(result.stdout) as { data: { repository: { pullRequest: Data } } }).data.repository.pullRequest

  return {
    headOid: data.headRefOid,
    reviews: data.reviews.nodes.map(r => ({ author: r.author?.login ?? '', body: r.body, at: r.submittedAt })),
    threads: data.reviewThreads.nodes.map(thread => ({
      id: thread.id,
      path: thread.path,
      line: thread.line ?? thread.originalLine,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      comments: thread.comments.nodes.map(c => ({ author: c.author?.login ?? 'someone', body: c.body, at: c.createdAt })),
      diffHunk: thread.hunk.nodes[0]?.diffHunk ?? '',
      url: thread.comments.nodes.at(-1)?.url ?? '',
      canReply: thread.viewerCanReply,
      canResolve: thread.viewerCanResolve,
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

// The PR's description and whole discussion, for the PR view. Fetched only when asked, about 1 point.
const CONVERSATION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      body createdAt additions deletions changedFiles commits { totalCount }
      comments(first: 100) { nodes { author { login } body createdAt } }
      reviews(first: 100) { nodes { author { login } state body submittedAt } }
      reviewThreads(first: 100) { nodes {
        isResolved isOutdated path line originalLine
        comments(first: 50) { nodes { author { login } body createdAt } }
      } }
    }
  }
}`

export async function fetchConversation(pr: PrRow, offsetMinutes: number): Promise<Conversation | { failure: string }> {
  const [owner = '', name = ''] = pr.repo.split('/')
  const result = await gh(['api', 'graphql', '-f', `query=${CONVERSATION_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr.number}`])
  if (result.exitCode !== 0) {
    return { failure: result.stderr.trim() || 'gh api graphql failed' }
  }
  type Author = { login?: string } | null
  type Comment = { author: Author; body: string; createdAt: string }
  type Data = {
    body: string
    createdAt: string
    additions: number
    deletions: number
    changedFiles: number
    commits: { totalCount: number }
    comments: { nodes: Comment[] }
    reviews: { nodes: { author: Author; state: string; body: string; submittedAt: string | null }[] }
    reviewThreads: { nodes: { isResolved: boolean; isOutdated: boolean; path: string; line: number | null; originalLine: number | null; comments: { nodes: Comment[] } }[] }
  }
  const data = (JSON.parse(result.stdout) as { data: { repository: { pullRequest: Data } } }).data.repository.pullRequest
  const comment = (c: Comment) => ({ author: c.author?.login ?? 'someone', body: c.body, at: c.createdAt })

  return {
    pr,
    body: data.body,
    createdAt: data.createdAt,
    additions: data.additions,
    deletions: data.deletions,
    changedFiles: data.changedFiles,
    commits: data.commits.totalCount,
    comments: data.comments.nodes.map(comment),
    reviews: data.reviews.nodes.map(r => ({ author: r.author?.login ?? 'someone', state: r.state, body: r.body, at: r.submittedAt })),
    threads: data.reviewThreads.nodes.map(thread => ({
      path: thread.path,
      line: thread.line ?? thread.originalLine,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      comments: thread.comments.nodes.map(comment),
      at: thread.comments.nodes[0]?.createdAt ?? '',
    })),
    offsetMinutes,
  }
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

export async function replyToThread(threadId: string, body: string): Promise<Done> {
  const query = 'mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }'

  return done(await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `id=${threadId}`, '-f', `body=${body}`]), 'Reply posted')
}

// Creates a review on the PR from GitHub's request body (see reviewPayload); url is where it shows on GitHub.
export async function postReview(repo: string, number: number, payload: Record<string, unknown>): Promise<Done & { url: string | null }> {
  // GitHub refuses a review on a commit that is no longer the head; say which commits came since, before trying.
  const head = await gh(['pr', 'view', String(number), '--repo', repo, '--json', 'headRefOid,commits'])
  if (head.exitCode === 0) {
    const pr = JSON.parse(head.stdout) as { headRefOid: string; commits: { oid: string; messageHeadline: string }[] }
    if (pr.headRefOid !== payload.commit_id) {
      const at = pr.commits.findIndex(commit => commit.oid === payload.commit_id)
      const since = at >= 0 ? pr.commits.slice(at + 1) : []
      const listed = since.map(commit => `${commit.oid.slice(0, 7)} ${commit.messageHeadline}`).join('; ')

      return {
        ok: false,
        text: `New commits were pushed after this review${listed ? ` (${listed})` : ''}. Refresh, Re-review them, then draft again.`,
        url: null,
      }
    }
  }
  const result = await run(['gh', 'api', '-X', 'POST', `repos/${repo}/pulls/${number}/reviews`, '--input', '-', '--jq', '.html_url'], undefined, JSON.stringify(payload))
  const isPending = !('event' in payload)
  if (result.exitCode !== 0) {
    // gh prints the API's message, which says why (one pending review per PR, approving my own PR…).
    const message = /"message":\s*"([^"]+)"/.exec(result.stdout)?.[1] ?? (result.stderr.trim().split('\n')[0] || 'gh failed')
    const reason = /"errors":\s*\[\s*"([^"]+)"/.exec(result.stdout)?.[1]

    return { ok: false, text: reason ? `${message}: ${reason}` : message, url: null }
  }

  return { ok: true, text: isPending ? 'Pending review created; finish it on GitHub' : 'Review submitted', url: result.stdout.trim() || null }
}

export async function resolveThread(threadId: string): Promise<Done> {
  const query = 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }'

  return done(await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `id=${threadId}`]), 'Thread resolved')
}

// Every open PR in the given repos, with who is asked to review it and since when, for the team view: about 3 points.
const TEAM_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest {
    number title isDraft createdAt author { __typename login } repository { nameWithOwner }
    reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
    timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent {
      createdAt requestedReviewer { ... on User { login } ... on Team { slug } }
    } } }
    reviews(last: 50) { nodes { author { __typename login } state submittedAt } }
  } } }
}`

type TeamNode = {
  number?: number
  title: string
  isDraft: boolean
  createdAt: string
  author: { __typename: string; login: string } | null
  repository: { nameWithOwner: string }
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[] }
  timelineItems: { nodes: { createdAt?: string; requestedReviewer?: { login?: string; slug?: string } | null }[] }
  reviews: { nodes: { author: { __typename: string; login: string } | null; state: string; submittedAt: string }[] }
}

export async function fetchTeam(repos: string[]): Promise<TeamPr[] | { failure: string }> {
  if (repos.length === 0) {
    return { failure: 'No repository to look at' }
  }
  const query = `is:pr is:open ${repos.map(one => `repo:${one}`).join(' ')}`
  const result = await gh(['api', 'graphql', '-f', `query=${TEAM_QUERY}`, '-f', `q=${query}`])
  if (result.exitCode !== 0) {
    return { failure: result.stderr.trim() || 'gh api graphql failed' }
  }
  const nodes = (JSON.parse(result.stdout) as { data: { search: { nodes: TeamNode[] } } }).data.search.nodes
  // Bots neither review nor need reviewers chased; teams show as @slug.
  const who = (one: { __typename?: string; login?: string; slug?: string } | null | undefined) =>
    !one || one.__typename === 'Bot' ? null : one.slug ? `@${one.slug}` : (one.login ?? null)

  return nodes
    .filter(node => typeof node.number === 'number' && who(node.author))
    .map(node => {
      const asked = node.timelineItems.nodes
      const requested = node.reviewRequests.nodes.flatMap(({ requestedReviewer }) => {
        const login = who(requestedReviewer)
        const event = asked.filter(one => who(one.requestedReviewer) === login).at(-1)

        return login ? [{ login, at: event?.createdAt ?? node.createdAt }] : []
      })

      return {
        repo: node.repository.nameWithOwner,
        number: node.number as number,
        title: node.title,
        author: who(node.author) as string,
        isDraft: node.isDraft,
        createdAt: node.createdAt,
        requested,
        reviews: node.reviews.nodes.flatMap(review => {
          const login = who(review.author)

          return login ? [{ login, state: review.state, at: review.submittedAt }] : []
        }),
      }
    })
}
