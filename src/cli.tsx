#!/usr/bin/env bun
import { parseArgs } from 'node:util'

import { render } from 'ink'

import type { PrRow } from './types'
import { digest, quickReport } from './ai'
import type { ReportResult } from './ai'
import { readState, updateState } from './github'
import { ago, alertOf, ciChip, extraChips, reviewChip, threadsChip } from './lib/lib'
import type { Chip } from './lib/lib'
import { configFor, detectScope, loadConfigs, refresh } from './monitor'
import type { Snapshot } from './monitor'
import { App } from './ui/App'

const USAGE = `Usage: prs [command] [options]

Commands:
  (none)    Interactive view of open PRs involving you
  list      Print them once
  status    One-line summary for a status line; reads only the cache unless --fetch
  report N  AI status report of PR N (or owner/name#N), streamed as it is written
  digest    AI summary of what to do first across your PRs (with --all, every repo)

Options:
  --all     Every repo involving you, not only the current one
  --json    Print the snapshot as JSON
  --fetch   (status) Ask GitHub when the cache is older than the poll interval
  --color   Color the output even when it is not a terminal (e.g. a status line)
  -h, --help`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    fetch: { type: 'boolean', default: false },
    color: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const isColored = values.color || !!process.stdout.isTTY
const ANSI: Record<NonNullable<Chip['color']>, number> = { error: 31, warning: 33, success: 32, merged: 35 }

const command = positionals[0] ?? (process.stdout.isTTY && process.stdin.isTTY ? 'view' : 'list')
if (values.help || !['view', 'list', 'status', 'report', 'digest'].includes(command)) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}

const scope = await detectScope(values.all)
let state = await readState()
if (scope.repo && scope.root && state.repos[scope.repo] !== scope.root) {
  state = await updateState({ repos: { [scope.repo]: scope.root } })
}
const configs = await loadConfigs(scope, state.repos)
if (command === 'report') {
  const target = /^(?:([\w.-]+\/[\w.-]+)#)?(\d+)$/.exec(positionals[1] ?? '')
  const repo = target?.[1] ?? scope.repo
  if (!target || !repo) {
    console.error(target ? 'Not inside a GitHub repository; pass owner/name#N' : 'Usage: prs report <N | owner/name#N>')
    process.exit(1)
  }
  await stream(quickReport(repo, Number(target[2]), configFor(configs, repo), { onText: write }))
}
const memory = { seen: state.seen, snoozed: state.snoozed }
if (command === 'view') {
  const app = render(<App initialScope={scope} initialConfigs={configs} initialState={state} />, {
    alternateScreen: true,
  })
  await app.waitUntilExit()
  process.exit(0)
}
const pollMs = configs.current.pollMinutes * 60 * 1000
const snapshot =
  command === 'status'
    ? await refresh(scope, configs, memory, { maxAgeMs: pollMs, canFetch: values.fetch })
    : await refresh(scope, configs, memory, { maxAgeMs: 60 * 1000, canFetch: true })

if (command === 'digest') {
  if (!snapshot.me) {
    console.error(snapshot.error ?? 'No PRs loaded')
    process.exit(1)
  }
  const { rows, current } = snapshot
  const all = current && !rows.some(pr => pr.number === current.number && pr.repo === current.repo) ? [...rows, current] : rows
  await stream(digest(all.filter(pr => pr.state === 'OPEN'), snapshot.me, configs.current, { onText: write }))
}

if (values.json) {
  console.log(JSON.stringify(snapshot, null, 2))
} else if (command === 'status') {
  const line = statusLine(snapshot)
  if (line) {
    console.log(line)
  }
} else {
  printList(snapshot)
}

function paint(chip: Chip): string {
  const code = chip.color ? ANSI[chip.color] : chip.dim ? 2 : null

  return isColored && code ? `\x1b[${code}m${chip.text}\x1b[0m` : chip.text
}

function chips(pr: PrRow): string {
  const all: Chip[] = [reviewChip(pr), ciChip(pr), ...(pr.unresolved ? [threadsChip(pr)] : []), ...extraChips(pr)]

  return all.map(paint).join('  ')
}

function statusLine(snap: Snapshot): string {
  const parts: string[] = []
  if (snap.current) {
    parts.push(`#${snap.current.number} ${chips(snap.current)}`)
  }
  const alert = alertOf(snap.current, snap.rows, Date.now())
  if (alert) {
    const more = alert.more > 0 ? ` +${alert.more}` : ''
    const color = alert.kind === 'new' ? 'warning' : 'success'
    parts.push(paint({ text: `${alert.kind === 'new' ? '●' : '✓'} #${alert.pr.number} ${alert.text}${more}`, color }))
  }

  return parts.join(' │ ')
}

function printList(snap: Snapshot): void {
  if (snap.error) {
    console.error(`gh: ${snap.error}`)
  }
  if (snap.pausedUntil) {
    console.error(`GitHub API budget low · auto-refresh paused until ${new Date(snap.pausedUntil).toLocaleTimeString()}`)
  }
  if (!snap.checkedAt) {
    return
  }
  const now = Date.now()
  console.log(`Open PRs involving ${snap.me} · checked ${ago(new Date(snap.checkedAt).toISOString(), now)}`)
  const groups = [
    { bucket: 'me', title: 'WAITING ON ME' },
    { bucket: 'ready', title: 'READY TO MERGE' },
    { bucket: 'others', title: 'WAITING ON OTHERS' },
    { bucket: 'snoozed', title: 'SNOOZED' },
  ] as const
  for (const { bucket, title } of groups) {
    const group = snap.rows.filter(pr => pr.bucket === bucket)
    if (group.length === 0) {
      continue
    }
    console.log(`\n${title} · ${group.length}`)
    for (const pr of group) {
      const where = scope.isAll ? `${pr.repo}` : ''
      const here = snap.current?.number === pr.number && snap.current.repo === pr.repo ? ' ◉' : ''
      console.log(`${pr.isNew ? '●' : ' '} ${where}#${pr.number}${here}  ${pr.title}  [${chips(pr)}]  ${pr.isMine ? 'you' : pr.author}`)
    }
  }
}

// Prints text as it streams in, then exits: 1 with the reason when there is no answer.
let printed = 0

function write(soFar: string): void {
  process.stdout.write(soFar.slice(printed))
  printed = soFar.length
}

async function stream(answer: Promise<ReportResult>): Promise<never> {
  const result = await answer
  if ('failure' in result) {
    console.error(result.failure)
    process.exit(1)
  }
  process.stdout.write(`${result.text.slice(printed)}\n`)
  process.exit(0)
}
