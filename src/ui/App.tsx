import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { PrBucket, PrRow } from '../types'
import { copy, localOffset, notify, openUrl, promptFor, reviewLabel } from '../actions'
import type { Action } from '../actions'
import { digest, quickReport } from '../ai'
import type { ReportResult } from '../ai'
import { checkoutPr, fetchChanges, mergePr, readState, rerequestReview, run, updateBranch, updateState } from '../github'
import type { CliState, Done } from '../github'
import {
  age,
  ago,
  bucketOf,
  changesMarkdown,
  ciChip,
  detailOf,
  extraChips,
  rerequestable,
  reviewChip,
  rowKey,
  staleness,
  threadsChip,
  tomorrowMorning,
} from '../lib/lib'
import type { Chip } from '../lib/lib'
import { configFor, loadConfigs, refresh, sortRows } from '../monitor'
import type { Configs, RefreshOptions, Scope, Snapshot } from '../monitor'
import { markdownLines } from './markdown'
import { Panel } from './Panel'

const TICK_MS = 60 * 1000
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BUCKETS: { bucket: PrBucket; title: string; color?: string }[] = [
  { bucket: 'me', title: 'WAITING ON ME', color: 'yellow' },
  { bucket: 'ready', title: 'READY TO MERGE', color: 'green' },
  { bucket: 'others', title: 'WAITING ON OTHERS' },
  { bucket: 'snoozed', title: 'SNOOZED' },
]
const COLORS: Record<NonNullable<Chip['color']>, string> = { error: 'red', warning: 'yellow', success: 'green', merged: 'magenta' }
const MERGE_WORDS = { merge: 'a merge commit', squash: 'squash', rebase: 'rebase' } as const

type Flash = { text: string; isError?: boolean }
// One terminal line; `item` is the selectable item it belongs to.
type Line = { key: string; item?: string; node: ReactNode }
type Item = { key: string; pr?: PrRow; bucket?: PrBucket }
// A full-screen text view over the list: a PR's report, what changed since my review, or the digest.
type PanelKind = 'report' | 'changes' | 'digest'
type PanelState = { kind: PanelKind; pr: PrRow | null; status: 'loading' | 'done' | 'error'; text: string; at: number }
// A GitHub action waiting for y.
type Confirm = { text: string; run: () => Promise<Done> }

type Props = { initialScope: Scope; initialConfigs: Configs; initialState: CliState }

export function App({ initialScope, initialConfigs, initialState }: Props) {
  const { exit } = useApp()
  const { columns, rows: height } = useWindowSize()
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [frame, setFrame] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(initialState.collapsed)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [now, setNow] = useState(Date.now())
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [isPanelOpen, setPanelOpen] = useState(false)
  const [panelTop, setPanelTop] = useState(0)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const panelAbort = useRef<AbortController | null>(null)
  const scope = useRef(initialScope)
  const configs = useRef(initialConfigs)
  const memory = useRef({ seen: initialState.seen, snoozed: initialState.snoozed })
  const snapRef = useRef<Snapshot | null>(null)
  // Each refresh takes the next number; only the latest may write, so a slow one never overwrites a newer one.
  const epoch = useRef(0)
  const inflight = useRef(false)
  const lastRefreshAt = useRef(0)
  const offset = useRef(0)
  // The selected item as of the last key, so keys typed faster than a render still move from the right place.
  const pickedKey = useRef<string | null>(null)

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
      const next = await refresh(scope.current, configs.current, memory.current, options)
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

  // Rebuilds the rows from the cache, after a change to what we remember (snoozes).
  const reshow = () => load({ maxAgeMs: Infinity, canFetch: false }, { force: true, isQuiet: true })

  const detectBranch = async () => {
    const { root, branch } = scope.current
    const result = root ? await run(['git', 'branch', '--show-current'], root) : null
    const next = result?.exitCode === 0 ? result.stdout.trim() || null : branch
    scope.current = { ...scope.current, branch: next }

    return next !== branch
  }

  useEffect(() => {
    // The cache first, so the screen fills at once; then GitHub if the cache is older than a minute.
    void load({ maxAgeMs: Infinity, canFetch: false }, { isQuiet: true }).then(() =>
      load({ maxAgeMs: 60 * 1000, canFetch: true }, { force: true }),
    )
    const timer = setInterval(async () => {
      setNow(Date.now())
      const hasMoved = await detectBranch()
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

  const remember = async (patch: Parameters<typeof updateState>[0]) => {
    const stored = await updateState(patch)
    memory.current = { seen: stored.seen, snoozed: stored.snoozed }
  }

  const markSeen = async (pr: PrRow) => {
    if (!pr.lastOtherAt || !snapRef.current) {
      return
    }
    await remember({ seen: { [rowKey(pr)]: pr.lastOtherAt } })
    const unmark = (one: PrRow) => {
      if (one.number !== pr.number || one.repo !== pr.repo || one.bucket === 'snoozed') {
        return one
      }
      const row = { ...one, isNew: false }

      return { ...row, bucket: bucketOf(row) }
    }
    const current = snapRef.current
    show({ ...current, rows: sortRows(current.rows.map(unmark)), current: current.current && unmark(current.current) })
  }

  const snooze = async (pr: PrRow, until: number | null) => {
    const isAwake = pr.bucket !== 'snoozed'
    await remember({ snoozed: { [rowKey(pr)]: isAwake ? { lastOtherAt: pr.lastOtherAt, until } : null } })
    await reshow()
    const when = until ? `until ${new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} or new activity` : 'until new activity'
    setFlash({ text: isAwake ? `Snoozed #${pr.number} ${when}` : `#${pr.number} is back` })
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

  // Runs a GitHub action, says how it went and refreshes from GitHub when it worked.
  const runAction = async (work: Promise<Done>, after?: () => Promise<unknown>) => {
    setFlash({ text: 'Working…' })
    const result = await work
    setFlash({ text: result.text, isError: !result.ok })
    if (result.ok) {
      await after?.()
      void load({ maxAgeMs: 0, canFetch: true }, { force: true })
    }
  }

  // Shows a panel: the one already made this session for the same kind and PR, or a new one when `isRedo` or there is none.
  const openPanel = async (kind: PanelKind, pr: PrRow | null, isRedo = false) => {
    setPanelOpen(true)
    setPanelTop(0)
    const isSame = panel?.kind === kind && panel.pr?.number === pr?.number && panel.pr?.repo === pr?.repo
    if (isSame && panel.status !== 'error' && !isRedo) {
      return
    }
    panelAbort.current?.abort()
    const controller = new AbortController()
    panelAbort.current = controller
    const at = Date.now()
    const write = (next: Partial<PanelState>) => {
      if (panelAbort.current === controller) {
        setPanel(one => ({ ...(one ?? { kind, pr, status: 'loading', text: '', at }), ...next }))
      }
    }
    setPanel({ kind, pr, status: 'loading', text: '', at })
    const streaming = { onText: (text: string) => write({ text }), signal: controller.signal }
    let result: ReportResult
    if (kind === 'digest') {
      const all = snapRef.current
      const rows = all ? [...all.rows, ...(all.current && !all.rows.some(one => rowKey(one) === rowKey(all.current!)) ? [all.current] : [])] : []
      result = await digest(rows.filter(one => one.state === 'OPEN'), all?.me ?? '', configs.current.current, streaming)
    } else if (!pr?.repo) {
      result = { failure: 'Unknown repository for this PR' }
    } else if (kind === 'report') {
      result = await quickReport(pr.repo, pr.number, configFor(configs.current, pr.repo), streaming)
    } else {
      const changes = await fetchChanges(pr, localOffset())
      result = 'failure' in changes ? changes : { text: changesMarkdown(changes) }
    }
    write('failure' in result ? { status: 'error', text: result.failure } : { status: 'done', text: result.text, at: Date.now() })
  }

  const toggleBucket = async (bucket: PrBucket) => {
    const next = collapsed.includes(bucket) ? collapsed.filter(one => one !== bucket) : [...collapsed, bucket]
    setCollapsed(next)
    await updateState({ collapsed: next })
  }

  // ---- What each PR offers, used by both the hints line and the keys.
  const canCheckout = (pr: PrRow) =>
    pr.state === 'OPEN' && !!scope.current.root && pr.repo === scope.current.repo && pr.headRef !== scope.current.branch
  const keysFor = (pr: PrRow): [string, string][] => {
    const isOpen = pr.state === 'OPEN'
    const keys: [string, string | null][] = [
      ['v', reviewLabel(pr) || null],
      ['d', pr.rereview ? 'Changes' : null],
      ['c', pr.state === 'MERGED' ? 'Clean' : null],
      ['m', pr.bucket === 'ready' ? 'Merge' : null],
      ['R', rerequestable(pr).length > 0 ? 'Re-request' : null],
      ['b', isOpen && pr.isBehind ? 'Update' : null],
      ['a', 'Ask'],
      ['r', 'Report'],
      ['s', pr.isNew ? 'Seen' : null],
      ['z', isOpen ? (pr.bucket === 'snoozed' ? 'Unsnooze' : 'Snooze') : null],
      ['Z', isOpen && pr.bucket !== 'snoozed' ? 'Till tomorrow' : null],
      ['g', canCheckout(pr) ? 'Checkout' : null],
      ['o', pr.url ? 'Open' : null],
    ]

    return keys.filter((one): one is [string, string] => one[1] !== null)
  }

  const onPrKey = (input: string, pr: PrRow) => {
    const offered = new Set(keysFor(pr).map(([key]) => key))
    if (!offered.has(input)) {
      return
    }
    const config = configFor(configs.current, pr.repo)
    switch (input) {
      case 'v':
        return void act('review', pr)
      case 'd':
        return void openPanel('changes', pr)
      case 'c':
        return void act('clean', pr)
      case 'a':
        return void act('ask', pr)
      case 'r':
        return void openPanel('report', pr)
      case 's':
        return void markSeen(pr)
      case 'z':
        return void snooze(pr, null)
      case 'Z':
        return void snooze(pr, tomorrowMorning(Date.now()))
      case 'o':
        return openUrl(pr.url)
      case 'g':
        return void runAction(checkoutPr(pr, scope.current.root ?? ''), detectBranch)
      case 'm':
        return setConfirm({
          text: `Merge #${pr.number} into ${pr.baseRef} with ${MERGE_WORDS[config.mergeMethod]}?`,
          run: () => mergePr(pr, config.mergeMethod),
        })
      case 'b':
        return setConfirm({ text: `Update #${pr.number}'s branch with ${pr.baseRef} (a merge commit on ${pr.headRef})?`, run: () => updateBranch(pr) })
      case 'R': {
        const logins = rerequestable(pr)

        return setConfirm({ text: `Ask ${logins.join(', ')} to review #${pr.number} again?`, run: () => rerequestReview(pr, logins) })
      }
    }
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
  pickedKey.current = picked?.key ?? null
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
    const stale = staleness(pr, now)

    return (
      <Box key={key}>
        {cell(2, marker, 'marker')}
        {showRepo && cell(16, <Text dimColor wrap="truncate-end">{pr.repo.split('/')[1]}</Text>, 'repo')}
        {cell(7, <Text bold={isPicked}>#{pr.number}</Text>, 'number')}
        {cell(10, chip(reviewChip(pr), 'review'), 'review')}
        {cell(8, chip(ciChip(pr), 'ci'), 'ci')}
        {cell(4, chip(threadsChip(pr), 'threads'), 'threads')}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold={pr.isNew || isPicked} dimColor={pr.bucket === 'snoozed'} wrap="truncate-end">
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
            <Text color={stale ? COLORS[stale] : undefined} dimColor={!stale}>
              {pr.lastOtherAt ? age(pr.lastOtherAt, now) : ''}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

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
              {keysFor(pr)
                .map(([one, label]) => `${one} ${label}`)
                .join('   ')}
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
  if (snap?.checkedAt && list.every(pr => pr.bucket === 'others' || pr.bucket === 'snoozed')) {
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

  // ---- The panel, which replaces the list while open.
  const panelLines = panel ? markdownLines(panel.text || ' ', columns - 2) : []
  const panelRoom = Math.max(3, height - 5)
  const panelMax = Math.max(0, panelLines.length - panelRoom)

  const onPanelKey = (input: string, key: { escape: boolean; downArrow: boolean; upArrow: boolean; pageDown: boolean; pageUp: boolean }) => {
    if (!panel) {
      return
    }
    const isDone = panel.status === 'done'
    const pr = panel.pr
    if (input === 'q' || key.escape) {
      setPanelOpen(false)
    } else if (key.downArrow || input === 'j') {
      setPanelTop(top => Math.min(panelMax, top + 1))
    } else if (key.upArrow || input === 'k') {
      setPanelTop(top => Math.max(0, top - 1))
    } else if (key.pageDown || input === ' ') {
      setPanelTop(top => Math.min(panelMax, top + panelRoom - 1))
    } else if (key.pageUp) {
      setPanelTop(top => Math.max(0, top - panelRoom + 1))
    } else if (input === 'c' && isDone) {
      void copy(panel.text).then(isCopied => setFlash(isCopied ? { text: 'Copied' } : { text: 'Could not copy', isError: true }))
    } else if (input === 'x' && panel.status !== 'loading') {
      void openPanel(panel.kind, pr, true)
    } else if (input === 'o' && pr?.url) {
      openUrl(pr.url)
    } else if (input === 'a' && isDone && pr && panel.kind === 'report') {
      void act('ask', pr, panel.text)
    } else if (input === 'v' && pr && panel.kind === 'changes' && reviewLabel(pr)) {
      void act('review', pr)
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()

      return
    }
    if (confirm) {
      setConfirm(null)
      if (input === 'y') {
        void runAction(confirm.run())
      } else {
        setFlash({ text: 'Cancelled' })
      }

      return
    }
    if (isPanelOpen) {
      onPanelKey(input, key)

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
    if (input === 'D') {
      void openPanel('digest', null)

      return
    }
    const index = items.findIndex(item => item.key === pickedKey.current)
    const at = items[index] ?? picked
    const move = (to: number) => {
      pickedKey.current = items[to]?.key ?? null
      setSelected(pickedKey.current)
    }
    if (key.downArrow || input === 'j') {
      move(Math.min(items.length - 1, index + 1))
    } else if (key.upArrow || input === 'k') {
      move(Math.max(0, index - 1))
    } else if (at?.bucket && (key.return || input === ' ')) {
      void toggleBucket(at.bucket)
    } else if (at?.pr) {
      onPrKey(input, at.pr)
    }
  })

  const footer = (keys: string) => (
    <Box key="footer" flexDirection="column">
      {confirm ? (
        <Text color="yellow" wrap="truncate-end">
          {confirm.text} y / n
        </Text>
      ) : (
        <Text color={flash?.isError ? 'red' : 'green'} wrap="truncate-end">
          {flash?.text ?? ' '}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {keys}
      </Text>
    </Box>
  )

  if (isPanelOpen && panel) {
    const { kind, pr, status } = panel
    const model = kind === 'changes' ? '' : configFor(configs.current, pr?.repo ?? '').reportModel
    const meta = [model, status === 'loading' ? 'loading…' : status === 'done' ? ago(new Date(panel.at).toISOString(), now) : ''].filter(Boolean).join(' · ')
    const title = kind === 'digest' ? 'Digest · what to do first' : `${kind === 'report' ? 'Report' : 'Changes since my review'} · #${pr?.number} ${pr?.title}`
    const keys = [
      '↑↓ scroll',
      status === 'done' && kind === 'report' ? 'a Ask with report' : null,
      kind === 'changes' && pr && reviewLabel(pr) ? `v ${reviewLabel(pr)}` : null,
      status === 'done' ? 'c Copy' : null,
      pr?.url ? 'o Open' : null,
      status !== 'loading' ? 'x Redo' : null,
      'esc back',
    ]

    return (
      <Panel
        height={height}
        title={title}
        meta={meta}
        subtitle={pr?.repo ?? (isAll ? 'all repos' : (scope.current.repo ?? ''))}
        error={status === 'error' ? panel.text : undefined}
        placeholder={status === 'loading' && !panel.text ? (kind === 'digest' ? 'Weighing your PRs…' : 'Reading the PR…') : undefined}
        body={panelLines}
        top={Math.min(panelTop, panelMax)}
        room={panelRoom}
        footer={footer(keys.filter(Boolean).join(' · '))}
      />
    )
  }

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

  return (
    <Box flexDirection="column" height={height}>
      {top}
      <Box flexDirection="column" flexGrow={1}>
        {lines.slice(offset.current, offset.current + room).map(line => (
          <Box key={line.key}>{line.node}</Box>
        ))}
      </Box>
      {footer('↑↓ move · ⏎ fold · D digest · u refresh · q quit')}
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
