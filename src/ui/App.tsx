import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { PrBucket, PrRow } from '../types'
import { copy, notify, openUrl, promptFor, reviewLabel } from '../actions'
import { quickReport } from '../ai'
import type { Action } from '../actions'
import { readState, run, updateState } from '../github'
import { age, ago, bucketOf, ciChip, detailOf, extraChips, reviewChip, rowKey, threadsChip } from '../lib/lib'
import type { Chip } from '../lib/lib'
import { configFor, loadConfigs, refresh, sortRows } from '../monitor'
import type { Configs, RefreshOptions, Scope, Snapshot } from '../monitor'
import { markdownLines } from './markdown'

const TICK_MS = 60 * 1000
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BUCKETS: { bucket: PrBucket; title: string; color?: string }[] = [
  { bucket: 'me', title: 'WAITING ON ME', color: 'yellow' },
  { bucket: 'ready', title: 'READY TO MERGE', color: 'green' },
  { bucket: 'others', title: 'WAITING ON OTHERS' },
]
const COLORS: Record<NonNullable<Chip['color']>, string> = { error: 'red', warning: 'yellow', success: 'green', merged: 'magenta' }

type Flash = { text: string; isError?: boolean }
// One terminal line; `item` is the selectable item it belongs to.
type Line = { key: string; item?: string; node: ReactNode }
type Item = { key: string; pr?: PrRow; bucket?: PrBucket }
type Report = { pr: PrRow; status: 'loading' | 'done' | 'error'; text: string; at: number }

type Props = { initialScope: Scope; initialConfigs: Configs; initialSeen: Record<string, string>; initialCollapsed: string[] }

export function App({ initialScope, initialConfigs, initialSeen, initialCollapsed }: Props) {
  const { exit } = useApp()
  const { columns, rows: height } = useWindowSize()
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [frame, setFrame] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [now, setNow] = useState(Date.now())
  const [report, setReport] = useState<Report | null>(null)
  const [isReportOpen, setReportOpen] = useState(false)
  const [reportTop, setReportTop] = useState(0)
  const reportAbort = useRef<AbortController | null>(null)
  const scope = useRef(initialScope)
  const configs = useRef(initialConfigs)
  const seen = useRef(initialSeen)
  const snapRef = useRef<Snapshot | null>(null)
  // Each refresh takes the next number; only the latest may write, so a slow one never overwrites a newer one.
  const epoch = useRef(0)
  const inflight = useRef(false)
  const lastRefreshAt = useRef(0)
  const offset = useRef(0)

  const pollMs = () => configs.current.current.pollMinutes * 60 * 1000

  const show = (next: Snapshot) => {
    snapRef.current = next
    setSnap(next)
  }

  const load = async (options: RefreshOptions, { force = false, isQuiet = false } = {}) => {
    if (inflight.current && !force) {
      return
    }
    const attempt = ++epoch.current
    inflight.current = true
    lastRefreshAt.current = Date.now()
    setFrame(0)
    try {
      configs.current = await loadConfigs(scope.current, (await readState()).repos)
      const next = await refresh(scope.current, configs.current, seen.current, options)
      if (attempt !== epoch.current) {
        return
      }
      const before = snapRef.current
      show(next)
      if (next.checkedAt) {
        lastRefreshAt.current = next.checkedAt
      }
      if (!isQuiet && before?.checkedAt && next.checkedAt !== before.checkedAt) {
        announce(before, next)
      }
    } catch (err) {
      if (attempt === epoch.current) {
        setFlash({ text: err instanceof Error ? err.message : String(err), isError: true })
      }
    } finally {
      if (attempt === epoch.current) {
        inflight.current = false
        setFrame(null)
      }
    }
  }

  useEffect(() => {
    // The cache first, so the screen fills at once; then GitHub if the cache is older than a minute.
    void load({ maxAgeMs: Infinity, canFetch: false }, { isQuiet: true }).then(() =>
      load({ maxAgeMs: 60 * 1000, canFetch: true }, { force: true }),
    )
    const timer = setInterval(async () => {
      setNow(Date.now())
      const { root, branch } = scope.current
      const current = root ? await run(['git', 'branch', '--show-current'], root) : null
      const nextBranch = current?.exitCode === 0 ? current.stdout.trim() || null : branch
      const hasMoved = nextBranch !== branch
      scope.current = { ...scope.current, branch: nextBranch }
      if (hasMoved || Date.now() - lastRefreshAt.current >= pollMs()) {
        void load({ maxAgeMs: pollMs(), canFetch: true })
      }
    }, TICK_MS)

    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (frame === null) {
      return
    }
    const timer = setInterval(() => setFrame(one => (one === null ? null : (one + 1) % SPIN_FRAMES.length)), 100)

    return () => clearInterval(timer)
  }, [frame === null])

  useEffect(() => {
    if (!flash) {
      return
    }
    const timer = setTimeout(() => setFlash(null), 5000)

    return () => clearTimeout(timer)
  }, [flash])

  const markSeen = async (pr: PrRow) => {
    if (!pr.lastOtherAt || !snapRef.current) {
      return
    }
    seen.current = (await updateState({ seen: { [rowKey(pr)]: pr.lastOtherAt } })).seen
    const unmark = (one: PrRow) => {
      if (one.number !== pr.number || one.repo !== pr.repo) {
        return one
      }
      const row = { ...one, isNew: false }

      return { ...row, bucket: bucketOf(row) }
    }
    const current = snapRef.current
    show({ ...current, rows: sortRows(current.rows.map(unmark)), current: current.current && unmark(current.current) })
  }

  const act = async (action: Action, pr: PrRow, reportText?: string) => {
    const prompt = await promptFor(action, pr, configFor(configs.current, pr.repo), snapRef.current?.me ?? '', reportText)
    if ('failure' in prompt) {
      setFlash({ text: prompt.failure, isError: true })

      return
    }
    if (!(await copy(prompt.text))) {
      setFlash({ text: 'Could not copy to the clipboard', isError: true })

      return
    }
    if (action !== 'clean') {
      await markSeen(pr)
    }
    const name = action === 'review' ? reviewLabel(pr) : action === 'clean' ? 'Cleanup' : 'Ask'
    setFlash({ text: `${name} prompt for #${pr.number} copied · paste it into Claude` })
  }

  // Shows the PR's report: the one already made this session, or a new one when `isRedo` or there is none.
  const openReport = async (pr: PrRow, isRedo = false) => {
    setReportOpen(true)
    setReportTop(0)
    const isSame = report && report.pr.number === pr.number && report.pr.repo === pr.repo
    if (isSame && report.status !== 'error' && !isRedo) {
      return
    }
    reportAbort.current?.abort()
    const controller = new AbortController()
    reportAbort.current = controller
    const at = Date.now()
    const write = (next: Partial<Report>) => {
      if (reportAbort.current === controller) {
        setReport(one => ({ ...(one ?? { pr, status: 'loading', text: '', at }), ...next }))
      }
    }
    setReport({ pr, status: 'loading', text: '', at })
    if (!pr.repo) {
      write({ status: 'error', text: 'Unknown repository for this PR' })

      return
    }
    const result = await quickReport(pr.repo, pr.number, configFor(configs.current, pr.repo), {
      onText: text => write({ text }),
      signal: controller.signal,
    })
    write('failure' in result ? { status: 'error', text: result.failure } : { status: 'done', text: result.text, at: Date.now() })
  }

  const toggleBucket = async (bucket: PrBucket) => {
    const next = collapsed.includes(bucket) ? collapsed.filter(one => one !== bucket) : [...collapsed, bucket]
    setCollapsed(next)
    await updateState({ collapsed: next })
  }

  // ---- Layout: every line of the scrolling area, then the selectable items among them.
  const list = snap?.rows ?? []
  const current = snap?.current ?? null
  const isAll = scope.current.isAll
  const showWho = columns >= 90
  const showAge = columns >= 70
  const showRepo = isAll && columns >= 100
  const groups = BUCKETS.map(one => ({ ...one, rows: list.filter(pr => pr.bucket === one.bucket) })).filter(one => one.rows.length > 0)
  const items: Item[] = [
    ...(current ? [{ key: 'current', pr: current }] : []),
    ...groups.flatMap(({ bucket, rows }) => [
      { key: `bucket:${bucket}`, bucket },
      ...(collapsed.includes(bucket) ? [] : rows.map(pr => ({ key: `row:${rowKey(pr)}`, pr }))),
    ]),
  ]
  // The remembered selection while it still exists, otherwise the first PR.
  const picked = items.find(item => item.key === selected) ?? items.find(item => item.pr) ?? items[0] ?? null
  const lines: Line[] = []

  const chip = (one: Chip, key: string) => (
    <Text key={key} color={one.color ? COLORS[one.color] : undefined} dimColor={one.dim} wrap="truncate-end">
      {one.text}
    </Text>
  )
  const cell = (width: number, node: ReactNode, key: string) => (
    <Box key={key} width={width} flexShrink={0}>
      {node}
    </Box>
  )
  const isHere = (pr: PrRow, key: string) => key !== 'current' && !!current && current.number === pr.number && current.repo === pr.repo

  const rowLine = (pr: PrRow, key: string, isPicked: boolean): ReactNode => {
    const marker = isPicked ? <Text bold>▸</Text> : pr.isNew ? <Text color="yellow">●</Text> : <Text> </Text>
    const extras = [...(isHere(pr, key) ? [{ text: '◉ here', dim: true }] : []), ...extraChips(pr)]

    return (
      <Box key={key}>
        {cell(2, marker, 'marker')}
        {showRepo && cell(16, <Text dimColor wrap="truncate-end">{pr.repo.split('/')[1]}</Text>, 'repo')}
        {cell(7, <Text bold={isPicked}>#{pr.number}</Text>, 'number')}
        {cell(10, chip(reviewChip(pr), 'review'), 'review')}
        {cell(8, chip(ciChip(pr), 'ci'), 'ci')}
        {cell(4, chip(threadsChip(pr), 'threads'), 'threads')}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold={pr.isNew || isPicked} wrap="truncate-end">
            {pr.title}
          </Text>
        </Box>
        {extras.map((one, index) => (
          <Box key={`extra-${index}`} flexShrink={0} marginLeft={1}>
            {chip(one, 'chip')}
          </Box>
        ))}
        {showWho && (
          <Box width={14} flexShrink={0} marginLeft={1}>
            <Text dimColor wrap="truncate-end">
              {pr.isMine ? 'you' : pr.author}
            </Text>
          </Box>
        )}
        {showAge && (
          <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end">
            <Text dimColor>{pr.lastOtherAt ? age(pr.lastOtherAt, now) : ''}</Text>
          </Box>
        )}
      </Box>
    )
  }

  const hints = (pr: PrRow) =>
    [
      reviewLabel(pr) ? `v ${reviewLabel(pr)}` : null,
      pr.state === 'MERGED' ? 'c Clean' : null,
      'a Ask',
      'r Report',
      pr.isNew ? 's Seen' : null,
      pr.url ? 'o Open' : null,
    ]
      .filter(Boolean)
      .join('   ')

  const addRow = (pr: PrRow, key: string) => {
    const isPicked = key === picked?.key
    lines.push({ key, item: key, node: rowLine(pr, key, isPicked) })
    if (isPicked) {
      const where = isAll && !showRepo ? `${pr.repo}  ·  ` : ''
      lines.push({
        key: `${key}-detail`,
        item: key,
        node: (
          <Box marginLeft={9}>
            <Text dimColor wrap="truncate-end">
              {where}
              {detailOf(pr, now)}
            </Text>
          </Box>
        ),
      })
      lines.push({
        key: `${key}-actions`,
        item: key,
        node: (
          <Box marginLeft={9}>
            <Text color="cyan" wrap="truncate-end">
              {hints(pr)}
            </Text>
          </Box>
        ),
      })
    }
  }

  let header: ReactNode = null
  if (snap?.checkedAt && list.length > 0) {
    header = (
      <Box>
        {cell(2, <Text> </Text>, 'marker')}
        {showRepo && cell(16, <Text dimColor>REPO</Text>, 'repo')}
        {cell(7, <Text dimColor>#</Text>, 'number')}
        {cell(10, <Text dimColor>REVIEW</Text>, 'review')}
        {cell(8, <Text dimColor>CI</Text>, 'ci')}
        {cell(4, <Text dimColor>⚑</Text>, 'threads')}
        <Box flexGrow={1}>
          <Text dimColor>TITLE</Text>
        </Box>
      </Box>
    )
  }
  if (current) {
    lines.push({ key: 'current-title', node: <Text dimColor>CURRENT BRANCH · {scope.current.branch}</Text> })
    addRow(current, 'current')
  }
  if (snap?.checkedAt && list.every(pr => pr.bucket === 'others')) {
    lines.push({
      key: 'caught-up',
      node: (
        <Text>
          <Text color="green">✓ All caught up</Text>
          <Text dimColor>{list.length === 0 ? ' · no open PRs involve you' : ' · nothing is waiting on you'}</Text>
        </Text>
      ),
    })
  }
  for (const { bucket, title, color, rows: group } of groups) {
    const key = `bucket:${bucket}`
    const isFolded = collapsed.includes(bucket)
    lines.push({ key: `${key}-gap`, node: <Text> </Text> })
    lines.push({
      key,
      item: key,
      node: (
        <Text color={color} dimColor={!color} bold={key === picked?.key} inverse={key === picked?.key}>
          {isFolded ? '▸' : '▾'} {title} · {group.length}
        </Text>
      ),
    })
    if (!isFolded) {
      for (const pr of group) {
        addRow(pr, `row:${rowKey(pr)}`)
      }
    }
  }

  // ---- The report screen, which replaces the list while open.
  const reportLines = report ? markdownLines(report.text || ' ', columns - 2) : []
  const reportRoom = Math.max(3, height - 5)
  const maxReportTop = Math.max(0, reportLines.length - reportRoom)

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()

      return
    }
    if (isReportOpen && report) {
      const isDone = report.status === 'done'
      if (input === 'q' || key.escape) {
        setReportOpen(false)
      } else if (key.downArrow || input === 'j') {
        setReportTop(top => Math.min(maxReportTop, top + 1))
      } else if (key.upArrow || input === 'k') {
        setReportTop(top => Math.max(0, top - 1))
      } else if (key.pageDown || input === ' ') {
        setReportTop(top => Math.min(maxReportTop, top + reportRoom - 1))
      } else if (key.pageUp) {
        setReportTop(top => Math.max(0, top - reportRoom + 1))
      } else if (input === 'a' && isDone) {
        void act('ask', report.pr, report.text)
      } else if (input === 'c' && isDone) {
        void copy(report.text).then(isCopied => setFlash(isCopied ? { text: 'Report copied' } : { text: 'Could not copy the report', isError: true }))
      } else if (input === 'o' && report.pr.url) {
        openUrl(report.pr.url)
      } else if (input === 'x' && report.status !== 'loading') {
        void openReport(report.pr, true)
      }

      return
    }
    if (input === 'q' || key.escape) {
      exit()

      return
    }
    if (input === 'u') {
      void load({ maxAgeMs: 0, canFetch: true }, { force: true })

      return
    }
    const index = items.findIndex(item => item.key === picked?.key)
    if (key.downArrow || input === 'j') {
      setSelected(items[Math.min(items.length - 1, index + 1)]?.key ?? null)
    } else if (key.upArrow || input === 'k') {
      setSelected(items[Math.max(0, index - 1)]?.key ?? null)
    } else if (picked?.bucket && (key.return || input === ' ')) {
      void toggleBucket(picked.bucket)
    }
    const pr = picked?.pr
    if (!pr) {
      return
    }
    if (input === 'v' && reviewLabel(pr)) {
      void act('review', pr)
    } else if (input === 'a') {
      void act('ask', pr)
    } else if (input === 'c' && pr.state === 'MERGED') {
      void act('clean', pr)
    } else if (input === 'r') {
      void openReport(pr)
    } else if (input === 's' && pr.isNew) {
      void markSeen(pr)
    } else if (input === 'o' && pr.url) {
      openUrl(pr.url)
    }
  })

  // ---- Fixed top and bottom lines around the scrolling area.
  const top: ReactNode[] = []
  const spinner = frame === null ? '↻' : (SPIN_FRAMES[frame] ?? '↻')
  const where = isAll ? 'all repos' : (scope.current.repo ?? 'this repo')
  top.push(
    <Box key="title">
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text bold>PRs</Text>
          <Text dimColor>
            {' · '}
            {where}
            {snap?.checkedAt ? ` · checked ${ago(new Date(snap.checkedAt).toISOString(), now)}` : ' · loading…'}
          </Text>
        </Text>
      </Box>
      <Text dimColor={frame === null}>{spinner}</Text>
    </Box>,
  )
  if (snap?.error) {
    top.push(
      <Text key="error" color="red" wrap="truncate-end">
        gh: {snap.error}
      </Text>,
    )
  }
  if (snap?.pausedUntil) {
    top.push(
      <Text key="paused" color="yellow" wrap="truncate-end">
        GitHub API budget low · auto-refresh resumes in {age(new Date(now).toISOString(), snap.pausedUntil)} · u still asks
      </Text>,
    )
  }
  if (header) {
    top.push(<Box key="header">{header}</Box>)
  }
  const footer = (
    <Box key="footer" flexDirection="column">
      <Text color={flash?.isError ? 'red' : 'green'} wrap="truncate-end">
        {flash?.text ?? ' '}
      </Text>
      <Text dimColor wrap="truncate-end">
        ↑↓ move · ⏎ fold · u refresh · q quit
      </Text>
    </Box>
  )

  // Scroll just enough to keep every line of the selected item in view.
  const room = Math.max(3, height - top.length - 2)
  const first = lines.findIndex(line => line.item === picked?.key)
  const last = lines.findLastIndex(line => line.item === picked?.key)
  if (first >= 0 && first < offset.current) {
    offset.current = first
  } else if (last >= 0 && last >= offset.current + room) {
    offset.current = last - room + 1
  }
  offset.current = Math.max(0, Math.min(offset.current, lines.length - room))

  if (isReportOpen && report) {
    const { pr, status } = report
    const meta =
      status === 'loading'
        ? `${configFor(configs.current, pr.repo).reportModel} · writing…`
        : status === 'done'
          ? `${configFor(configs.current, pr.repo).reportModel} · ${ago(new Date(report.at).toISOString(), now)}`
          : configFor(configs.current, pr.repo).reportModel
    const keys = [
      '↑↓ scroll',
      status === 'done' ? 'a Ask with report' : null,
      status === 'done' ? 'c Copy' : null,
      pr.url ? 'o Open' : null,
      status !== 'loading' ? 'x Redo' : null,
      'esc back',
    ]

    return (
      <Box flexDirection="column" height={height}>
        <Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">
              Report · #{pr.number} {pr.title}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{meta}</Text>
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">
          {pr.repo}
          {reportLines.length > reportRoom ? ` · lines ${Math.min(reportTop, maxReportTop) + 1}-${Math.min(reportLines.length, reportTop + reportRoom)} of ${reportLines.length}` : ''}
        </Text>
        <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
          {status === 'error' ? (
            <Text color="red">{report.text}</Text>
          ) : status === 'loading' && !report.text ? (
            <Text dimColor>Reading the PR…</Text>
          ) : (
            reportLines.slice(Math.min(reportTop, maxReportTop), Math.min(reportTop, maxReportTop) + reportRoom).map((line, index) => (
              <Box key={index}>{line}</Box>
            ))
          )}
        </Box>
        <Text color={flash?.isError ? 'red' : 'green'} wrap="truncate-end">
          {flash?.text ?? ' '}
        </Text>
        <Text dimColor wrap="truncate-end">
          {keys.filter(Boolean).join(' · ')}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" height={height}>
      {top}
      <Box flexDirection="column" flexGrow={1}>
        {lines.slice(offset.current, offset.current + room).map(line => (
          <Box key={line.key}>{line.node}</Box>
        ))}
      </Box>
      {footer}
    </Box>
  )
}

function announce(before: Snapshot, next: Snapshot): void {
  const key = (pr: PrRow) => rowKey(pr)
  const wasNew = new Set(before.rows.filter(pr => pr.isNew).map(key))
  const wasReady = new Set(before.rows.filter(pr => pr.bucket === 'ready').map(key))
  for (const pr of next.rows.filter(one => one.bucket === 'ready' && !wasReady.has(key(one)))) {
    notify(`#${pr.number} is ready to merge`)
  }
  const fresh = next.rows.filter(pr => pr.isNew && !wasNew.has(key(pr)))
  const first = fresh[0]
  if (first) {
    notify(fresh.length === 1 ? `#${first.number}: new ${first.lastOtherWhat ?? 'activity'}` : `${fresh.length} PRs have new activity`)
  }
}
