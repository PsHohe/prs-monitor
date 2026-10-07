import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PrBucket, PrRow } from './types'
import { cachePath, fetchPrs, gh, readCache, run, writeCache } from './github'
import { applySnoozes, compileRegex, fromGraphql, linkRows, mergeConfig, parseConfigFile, pauseAfter, RATE_BACKOFF_MS, toRow } from './lib/lib'
import type { Config, GqlPr, RowOptions, SharedCache, Snooze } from './lib/lib'

export type Scope = {
  // The git repository the CLI runs in, if any.
  root: string | null
  repo: string | null
  branch: string | null
  // Every repo involving me instead of only `repo`.
  isAll: boolean
}

export async function detectScope(isAll: boolean): Promise<Scope> {
  const top = await run(['git', 'rev-parse', '--show-toplevel'])
  const root = top.exitCode === 0 ? top.stdout.trim() || null : null
  if (!root) {
    return { root: null, repo: null, branch: null, isAll }
  }
  const [viewed, branch] = await Promise.all([
    gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], root),
    run(['git', 'branch', '--show-current'], root),
  ])

  return {
    root,
    repo: viewed.exitCode === 0 ? viewed.stdout.trim() || null : null,
    branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
    isAll,
  }
}

export async function loadConfig(root: string | null): Promise<Config> {
  const paths = [
    join(homedir(), '.claude', 'pr-monitor.md'),
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
    return { ...EMPTY, error: scope.root ? 'gh could not read this repository' : 'not inside a git repository (try --all)' }
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
        await writeCache(path, { ...(cached ?? { at: 0, me: '', open: [], merged: [], branches: {} }), pausedUntil: now + RATE_BACKOFF_MS })
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
      }
      await writeCache(path, shared)
    }
  }
  shared ??= cached?.me ? cached : null
  if (!shared) {
    return { ...EMPTY, error, pausedUntil: (await readCache(path))?.pausedUntil ?? null }
  }

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
      // The plugin's cache files predate the repository field; they only ever hold this repo.
      const { raw, unresolved } = fromGraphql(scope.repo && !node.repository ? { ...node, repository: { nameWithOwner: scope.repo } } : node)

      return toRow(raw, shared.me, memory.seen, optionsFor(raw.repo ?? ''), unresolved)
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
  await writeCache(path, { ...shared, branches: { ...shared.branches, [key]: fetched.branchPr } })

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
