import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { gh, run } from '../../../src/github'
import type { Scope } from '../../../src/monitor'
import { parseDesktopState } from '../shared/repos'
import type { DesktopState, RepoEntry } from '../shared/repos'

// Next to the CLI's own state, which it does not touch.
const PATH = join(homedir(), '.claude', 'pr-monitor', 'desktop.json')

export async function readDesktopState(): Promise<DesktopState> {
  try {
    return parseDesktopState(await Bun.file(PATH).text())
  } catch {
    return parseDesktopState('')
  }
}

export async function writeDesktopState(state: DesktopState): Promise<void> {
  await mkdir(dirname(PATH), { recursive: true })
  await Bun.write(PATH, JSON.stringify(state, null, 2))
}

// The repo a picked folder belongs to; any folder inside a clone works.
export async function repoAt(folder: string): Promise<RepoEntry | { failure: string }> {
  const top = await run(['git', 'rev-parse', '--show-toplevel'], folder)
  const root = top.exitCode === 0 ? top.stdout.trim() : ''
  if (!root) {
    return { failure: `${folder} is not inside a git repository` }
  }
  const viewed = await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], root)
  const repo = viewed.exitCode === 0 ? viewed.stdout.trim() : ''

  return repo ? { repo, root } : { failure: `gh cannot find a GitHub repository for ${root}` }
}

// Like the CLI run inside the clone: its branch's PR and its config files apply.
export async function scopeOf(entry: RepoEntry): Promise<Scope> {
  const branch = await run(['git', 'branch', '--show-current'], entry.root)

  return { root: entry.root, repo: entry.repo, branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null, isAll: false }
}
