import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PrBucket, PrRow } from './types'
import { cachePath, fetchPrs, fetchThreadSummaries, gh, readCache, run, writeCache } from './github'
import {
  applySnoozes,
  compileRegex,
  fromGraphql,
  linkRows,
  mergeConfig,
  newCiFailures,
  parseConfigFile,
  pauseAfter,
  RATE_BACKOFF_MS,
  rowKey,
  setFrontmatter,
  toRow,
} from './lib/lib'
import type { Config, GqlPr, PrThreads, RowOptions, SharedCache, Snooze } from './lib/lib'

export type Scope = {
  // The git repository the CLI runs in, if any.
  root: string | null
  repo: string | null
  branch: string | null
  // Every repo involving me instead of only `repo`.
  isAll: boolean
}

// `known` maps owner/name to where the repo was seen, so a repo seen before needs no GitHub call.
export async function detectScope(isAll: boolean, known: Record<string, string>): Promise<Scope> {
  const top = await run(['git', 'rev-parse', '--show-toplevel'])
  const root = top.exitCode === 0 ? top.stdout.trim() || null : null
  if (!root) {
    return { root: null, repo: null, branch: null, isAll }
  }
  const seen = Object.entries(known).find(([, path]) => path === root)?.[0]
  const [viewed, branch] = await Promise.all([
    seen ? null : gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], root),
    run(['git', 'branch', '--show-current'], root),
  ])

  return {
    root,
    repo: seen ?? (viewed?.exitCode === 0 ? viewed.stdout.trim() || null : null),
    branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
    isAll,
  }
}

export const HOME_CONFIG = join(homedir(), '.claude', 'pr-monitor.md')

export async function loadConfig(root: string | null): Promise<Config> {
  const paths = [
    HOME_CONFIG,
    ...(root ? [join(root, '.claude', 'pr-monitor.md'), join(root, '.claude', 'pr-monitor.local.md')] : []),
  ]
  const files = []
  for (const path of paths) {
    try {
      files.push(parseConfigFile(await Bun.file(path).text()))
    } catch {
      // A missing layer falls through to the ones below it.
    }
  }

  return mergeConfig(files)
}

// Writes frontmatter keys into the home file (made if missing), keeping everything else in it.
export async function saveHomeSettings(values: Record<string, string>): Promise<void> {
  const file = Bun.file(HOME_CONFIG)
  const text = (await file.exists()) ? await file.text() : ''
  await Bun.write(HOME_CONFIG, setFrontmatter(text, values))
}

// The settings that apply to each repo's PRs: the home file plus the repo's own files when we know
// where the repo is on disk. `current` is what applies to the repo the CLI runs in, or the home file.
export type Configs = { home: Config; current: Config; byRepo: Record<string, Config> }

export async function loadConfigs(scope: Scope, repos: Record<string, string>): Promise<Configs> {
  const others = Object.entries(repos).filter(([repo]) => repo !== scope.repo)
  const [home, current, ...loaded] = await Promise.all([
    loadConfig(null),
    loadConfig(scope.root),
    ...others.map(([, root]) => loadConfig(root)),
  ])
  const byRepo: Record<string, Config> = Object.fromEntries(others.map(([repo], index) => [repo, loaded[index] ?? home]))
  if (scope.repo) {
    byRepo[scope.repo] = current
  }

  return { home, current, byRepo }
}

export function configFor(configs: Configs, repo: string): Config {
  return configs.byRepo[repo] ?? configs.home
}

export type Snapshot = {
  me: string | null
  rows: PrRow[]
  // The PR of the current branch, which may be closed, merged or a draft.
  current: PrRow | null
  checkedAt: number | null
  pausedUntil: number | null
  error: string | null
}

export type RefreshOptions = {
  // How old the cached result may be and still be used instead of asking GitHub; 0 always asks.
  maxAgeMs: number
  // False never asks GitHub and only reads the cache.
  canFetch: boolean
}

const EMPTY: Snapshot = { me: null, rows: [], current: null, checkedAt: null, pausedUntil: null, error: null }

export async function refresh(
  scope: Scope,
  configs: Configs,
  memory: { seen: Record<string, string>; snoozed: Record<string, Snooze> },
  { maxAgeMs, canFetch }: RefreshOptions,
): Promise<Snapshot> {
  if (!scope.isAll && !scope.repo) {
    return { ...EMPTY, error: scope.root ? 'this repository has no GitHub remote gh can read (try --all)' : 'not inside a git repository (try --all)' }
  }
  const now = Date.now()
  const path = cachePath(scope.isAll ? null : scope.repo)
  const cached = await readCache(path)
  const pausedUntil = cached?.pausedUntil && cached.pausedUntil > now ? cached.pausedUntil : null
  const applying = scope.isAll ? [configs.home, ...Object.values(configs.byRepo)] : [configs.current]
  const withMerged = applying.some(config => !!config.ticketPattern && config.twinBases.length >= 2)
  const branch = scope.repo && scope.branch ? { repo: scope.repo, name: scope.branch } : null

  let shared = cached?.me && now - cached.at < maxAgeMs ? cached : null
  let error: string | null = null
  // While paused only an explicit refresh (maxAgeMs 0) asks GitHub; everything else shows the last result.
  const mayAsk = canFetch && !(pausedUntil && maxAgeMs > 0)
  if (!shared && mayAsk) {
    const fetched = await fetchPrs({ searchRepo: scope.isAll ? null : scope.repo, withOpen: true, withMerged, branch })
    if ('failure' in fetched) {
      if (fetched.isLimited) {
        await writeCache(path, { ...(cached ?? { at: 0, me: '', open: [], merged: [], branches: {}, threads: {} }), pausedUntil: now + RATE_BACKOFF_MS })
      } else {
        error = fetched.failure
      }
    } else {
      shared = {
        at: now,
        me: fetched.me,
        open: fetched.open,
        merged: fetched.merged,
        pausedUntil: pauseAfter(fetched.rate, now),
        branches: branch ? { [branchKey(branch)]: fetched.branchPr } : {},
        threads: cached?.threads ?? {},
      }
      await writeCache(path, shared)
    }
  }
  shared ??= cached?.me ? cached : null
  if (!shared) {
    return { ...EMPTY, error, pausedUntil: (await readCache(path))?.pausedUntil ?? null }
  }
  // The plugin's cache files predate the repository field; they only ever hold this repo.
  const repoOf = (node: GqlPr) => node.repository?.nameWithOwner ?? scope.repo ?? ''
  const threads = await threadDetails(shared, path, repoOf, canFetch && !(shared.pausedUntil && shared.pausedUntil > now))

  const options = new Map<string, RowOptions>()
  const optionsFor = (repo: string): RowOptions => {
    let one = options.get(repo)
    if (!one) {
      const config = configFor(configs, repo)
      one = {
        automated: compileRegex(config.automatedComments),
        ticket: compileRegex(config.ticketPattern, 'i'),
        flakyChecks: config.flakyChecks,
      }
      options.set(repo, one)
    }

    return one
  }
  const toRows = (nodes: GqlPr[]) =>
    nodes.map(node => {
      const repo = repoOf(node)
      const { raw, unresolved } = fromGraphql(node.repository ? node : { ...node, repository: { nameWithOwner: repo } })

      return toRow(raw, shared.me, memory.seen, optionsFor(repo), unresolved, threads[`${repo}#${node.number}`]?.unresolved ?? null)
    })
  // Twins and stacks are found per repo, each with its own ticket pattern and twin bases.
  const link = (some: PrRow[], open: PrRow[]) =>
    some.map(pr => {
      const config = configFor(configs, pr.repo)

      return linkRows([pr], open, shared.merged, config.twinBases, optionsFor(pr.repo).ticket)[0] ?? pr
    })
  const rows = toRows(shared.open)
  const linked = link(rows, rows)

  let current: PrRow | null = null
  if (branch) {
    current = linked.find(pr => pr.repo === branch.repo && pr.headRef === branch.name) ?? null
    // A long-lived branch (develop, prod) has no PR of its own worth showing, only old promotions.
    const isBase =
      configFor(configs, branch.repo).twinBases.includes(branch.name) ||
      linked.some(pr => pr.repo === branch.repo && pr.baseRef === branch.name)
    if (!current && !isBase) {
      const branchPr = await branchLookup(shared, path, branch, canFetch && !(shared.pausedUntil && shared.pausedUntil > now))
      current = branchPr ? (link(toRows([branchPr]), rows)[0] ?? null) : null
    }
  }

  return {
    me: shared.me,
    rows: sortRows(applySnoozes(linked.filter(pr => !pr.isDraft), memory.snoozed, now)),
    current,
    checkedAt: shared.at,
    pausedUntil: shared.pausedUntil && shared.pausedUntil > now ? shared.pausedUntil : null,
    error,
  }
}

// Unresolved thread details for the PRs that have any, fetched again only for PRs updated since.
async function threadDetails(
  shared: SharedCache,
  path: string,
  repoOf: (node: GqlPr) => string,
  mayAsk: boolean,
): Promise<Record<string, PrThreads>> {
  const wanted = shared.open
    .filter(node => !node.isDraft && (node.reviewThreads?.nodes ?? []).some(thread => !thread.isResolved))
    .map(node => ({ key: `${repoOf(node)}#${node.number}`, node }))
  const kept: Record<string, PrThreads> = {}
  for (const { key } of wanted) {
    const one = shared.threads[key]
    if (one) {
      kept[key] = one
    }
  }
  // Nodes from the plugin's cache have no updatedAt; then only missing details are fetched. Resolving a
  // thread may leave updatedAt as it was, so a different count of unresolved threads also refetches.
  const unresolvedOf = (node: GqlPr) => (node.reviewThreads?.nodes ?? []).filter(thread => !thread.isResolved).length
  const stale = wanted.filter(
    ({ key, node }) => !kept[key] || (!!node.updatedAt && kept[key].updatedAt !== node.updatedAt) || kept[key].unresolved.length !== unresolvedOf(node),
  )
  if (stale.length === 0 || !mayAsk) {
    return kept
  }
  const fetched = await fetchThreadSummaries(stale.map(({ key }) => key))
  if (!fetched) {
    return kept
  }
  const threads = { ...kept, ...fetched }
  // Saved only onto the same fetch, so a newer one written meanwhile by another terminal is not overwritten.
  const latest = await readCache(path)
  if (latest && latest.at === shared.at) {
    await writeCache(path, { ...latest, threads })
  }

  return threads
}

function branchKey(branch: { repo: string; name: string }): string {
  return `${branch.repo}:${branch.name}`
}

// The current branch's PR when the search did not return it (no open PR involving me): from the
// cache when this fetch already looked, otherwise one small query whose answer is cached.
async function branchLookup(
  shared: SharedCache,
  path: string,
  branch: { repo: string; name: string },
  mayAsk: boolean,
): Promise<GqlPr | null> {
  const key = branchKey(branch)
  if (key in shared.branches) {
    return shared.branches[key] ?? null
  }
  if (!mayAsk) {
    return null
  }
  const fetched = await fetchPrs({ searchRepo: branch.repo, withOpen: false, withMerged: false, branch })
  if ('failure' in fetched) {
    return null
  }
  const latest = await readCache(path)
  const base = latest && latest.at === shared.at ? latest : shared
  await writeCache(path, { ...base, branches: { ...base.branches, [key]: fetched.branchPr } })

  return fetched.branchPr
}

export function sortRows(rows: PrRow[]): PrRow[] {
  const order: Record<PrBucket, number> = { me: 0, ready: 1, others: 2, snoozed: 3 }

  return [...rows].sort(
    (a, b) =>
      order[a.bucket] - order[b.bucket] ||
      Number(b.isNew) - Number(a.isNew) ||
      (b.lastOtherAt ?? '').localeCompare(a.lastOtherAt ?? ''),
  )
}

// What changed between two refreshes that is worth a notification: PRs ready to merge, my CI failing, new activity.
export function announcements(before: Snapshot, next: Snapshot): string[] {
  const wasNew = new Set(before.rows.filter(pr => pr.isNew).map(rowKey))
  const wasReady = new Set(before.rows.filter(pr => pr.bucket === 'ready').map(rowKey))
  const ready = next.rows.filter(pr => pr.bucket === 'ready' && !wasReady.has(rowKey(pr))).map(pr => `#${pr.number} is ready to merge`)
  const withCurrent = (snap: Snapshot) =>
    snap.current && !snap.rows.some(pr => rowKey(pr) === rowKey(snap.current!)) ? [...snap.rows, snap.current] : snap.rows
  const failed = newCiFailures(withCurrent(before), withCurrent(next)).map(pr => `#${pr.number} CI failed: ${pr.failingChecks.join(', ')}`)
  const fresh = next.rows.filter(pr => pr.isNew && !wasNew.has(rowKey(pr)))
  const first = fresh[0]
  const activity = first ? [fresh.length === 1 ? `#${first.number}: new ${first.lastOtherWhat ?? 'activity'}` : `${fresh.length} PRs have new activity`] : []

  return [...ready, ...failed, ...activity]
}
