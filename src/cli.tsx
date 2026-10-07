#!/usr/bin/env bun
import { parseArgs } from 'node:util'

import { render } from 'ink'

import type { PrRow } from './types'
import { readState } from './github'
import { ago, alertOf, ciChip, extraChips, reviewChip, threadsChip } from './lib/lib'
import type { Chip } from './lib/lib'
import { detectScope, loadConfig, refresh } from './monitor'
import type { Snapshot } from './monitor'
import { App } from './ui/App'

const USAGE = `Usage: prs [command] [options]

Commands:
  (none)    Interactive view of open PRs involving you
  list      Print them once
  status    One-line summary for a status line; reads only the cache unless --fetch

Options:
  --all     Every repo involving you, not only the current one
  --json    Print the snapshot as JSON
  --fetch   (status) Ask GitHub when the cache is older than the poll interval
  -h, --help`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    fetch: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const command = positionals[0] ?? (process.stdout.isTTY && process.stdin.isTTY ? 'view' : 'list')
if (values.help || !['view', 'list', 'status'].includes(command)) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}

const scope = await detectScope(values.all)
const config = await loadConfig(scope.root)
const { seen, collapsed } = await readState()
if (command === 'view') {
  const app = render(<App initialScope={scope} initialConfig={config} initialSeen={seen} initialCollapsed={collapsed} />, {
    alternateScreen: true,
  })
  await app.waitUntilExit()
  process.exit(0)
}
const pollMs = config.pollMinutes * 60 * 1000
const snapshot =
  command === 'status'
    ? await refresh(scope, config, seen, { maxAgeMs: pollMs, canFetch: values.fetch })
    : await refresh(scope, config, seen, { maxAgeMs: 60 * 1000, canFetch: true })

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

function chips(pr: PrRow): string {
  const all: Chip[] = [reviewChip(pr), ciChip(pr), ...(pr.unresolved ? [threadsChip(pr)] : []), ...extraChips(pr)]

  return all.map(one => one.text).join('  ')
}

function statusLine(snap: Snapshot): string {
  const parts: string[] = []
  if (snap.current) {
    parts.push(`#${snap.current.number} ${chips(snap.current)}`)
  }
  const alert = alertOf(snap.current, snap.rows, Date.now())
  if (alert) {
    const more = alert.more > 0 ? ` +${alert.more}` : ''
    parts.push(`${alert.kind === 'new' ? '●' : '✓'} #${alert.pr.number} ${alert.text}${more}`)
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
