import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isRateLimited, parseCache } from './lib/lib'
import type { GqlPr, MergedPr, SharedCache } from './lib/lib'

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
  repository { nameWithOwner }
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
export type CliState = { seen: Record<string, string>; collapsed: string[] }

const STATE_PATH = join(STATE_DIR, 'cli-state.json')

export async function readState(): Promise<CliState> {
  try {
    const value = JSON.parse(await Bun.file(STATE_PATH).text()) as Partial<CliState>

    return {
      seen: value.seen && typeof value.seen === 'object' ? value.seen : {},
      collapsed: Array.isArray(value.collapsed) ? value.collapsed : ['others'],
    }
  } catch {
    return { seen: {}, collapsed: ['others'] }
  }
}

export async function writeState(state: CliState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  await Bun.write(STATE_PATH, JSON.stringify(state))
}
