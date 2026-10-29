import { homedir } from 'node:os'

import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { PrBucket, PrRow } from '../types'
import { copy, localOffset, notify, openUrl, promptFor, reviewLabel } from '../actions'
import type { Action } from '../actions'
import { codexModels, digest, quickReport } from '../ai'
import type { ReportResult } from '../ai'
import {
  checkoutPr,
  fetchChanges,
  fetchConversation,
  fetchTeam,
  fetchThreads,
  mergePr,
  readState,
  replyToThread,
  rerequestReview,
  resolveThread,
  run,
  updateBranch,
  updateState,
} from '../github'
import type { CliState, Done } from '../github'
import {
  age,
  ago,
  bucketOf,
  changesMarkdown,
  compileRegex,
  conversationMarkdown,
  ciChip,
  detailOf,
  extraChips,
  MERGE_WORDS,
  REPORT_PROVIDERS,
  reportModelLabel,
  rerequestable,
  reviewChip,
  rowKey,
  staleness,
  teamLines,
  teamOf,
  threadMarkdown,
  threadPages,
  threadsChip,
  tomorrowMorning,
} from '../lib/lib'
import type { Chip, Config, ThreadDetail } from '../lib/lib'
import { announcements, configFor, HOME_CONFIG, loadConfigs, refresh, saveHomeSettings, sortRows } from '../monitor'
import type { Configs, RefreshOptions, Scope, Snapshot } from '../monitor'
import { markdownLines } from './markdown'
import { useMouse } from './mouse'
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
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku', 'fable']
const HOME_CONFIG_SHOWN = HOME_CONFIG.replace(homedir(), '~')
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' } as const
// What a PR key does, in the order the actions line shows them; `change` keys touch GitHub or git.
type KeyGroup = 'copy' | 'view' | 'change' | 'mark'
const KEY_GROUPS: KeyGroup[] = ['copy', 'view', 'change', 'mark']
const HELP = `## List
\`↑↓\` \`jk\` move · \`⏎\` fold a group or view a PR · \`/\` filter · \`A\` this repo / all repos · \`D\` digest · \`T\` team · \`u\` refresh · \`S\` settings · \`?\` this help · \`q\` quit
The mouse wheel moves, a click picks a PR and a second click views it, a click on a group folds it. Hold ⌥ (or shift) to select text.

## On a PR
**Copy a prompt for Claude or Codex** (cyan)
\`v\` Review / Re-review · \`a\` Ask · \`c\` Clean a merged PR

**View** (cyan)
\`⏎\` the PR with its description and discussion · \`t\` unresolved threads, those waiting for your reply first · \`d\` changes since your review · \`r\` AI report · \`o\` open in the browser

**Change** (yellow; all but checkout ask first)
\`m\` merge · \`R\` ask reviewers again · \`b\` update the branch with its base · \`g\` check out the branch here

**Mark**
\`s\` seen · \`z\` snooze until new activity (again wakes it) · \`Z\` until 9:00 tomorrow or new activity

## Panels
\`↑↓\` \`jk\` or the wheel scroll · \`space\` \`b\` page down / up · \`g\` \`G\` top / bottom · \`c\` copy · \`x\` redo · \`esc\` back
In a PR \`a\` copies Ask; in a report \`a\` copies Ask with the report.
In threads \`←→\` \`n\` \`p\` switch thread · \`r\` reply (⏎ posts, esc cancels) · \`s\` resolve (asks first) · \`o\` opens the thread · \`a\` copies a prompt drafting the replies.

## Symbols
\`●\` new activity from others · \`◉ here\` the current branch's PR
\`✓ 2\` approvals · \`✗ changes\` changes requested · \`○ review\` no decision yet
\`✓ CI\` passing · \`✗ CI\` failing · \`✗ CI~\` only flaky checks fail · \`◐ 3/5\` running
\`⚑3\` unresolved threads · \`↩3\` threads waiting for your reply
\`✓ ready\` ready to merge · \`✗ conflicts\` · \`↓ behind\` its base
\`Δ3\` commits since your review · \`Δ replies\` replies since your review
\`◆ requested\` your review is requested · \`↳#12\` stacked on #12 · \`⇄#12\` hotfix twin
In the team view (\`T\`) a row is a reviewer and a column an author: \`◆\` asked and waiting · \`✗\` changes requested · \`○\` commented · \`✓\` approved, with how many PRs.
The last column is the time since someone else's last activity; in waiting on me it turns yellow after a day and red after three.`

type Flash = { text: string; isError?: boolean; isSticky?: boolean }
// One terminal line; `item` is the selectable item it belongs to.
type Line = { key: string; item?: string; node: ReactNode }
type Item = { key: string; pr?: PrRow; bucket?: PrBucket }
// A full-screen text view over the list: a PR with its discussion, its report, what changed since my review, its threads (a page each), the digest, the team or the help.
type PanelKind = 'pr' | 'report' | 'changes' | 'digest' | 'team' | 'threads' | 'help'
type ThreadPage = { thread: ThreadDetail; isOwed: boolean; text: string }
// `lines` are colored lines shown instead of the text as markdown (the team view).
type PanelState = { kind: PanelKind; pr: PrRow | null; status: 'loading' | 'done' | 'error'; text: string; at: number; pages?: ThreadPage[]; lines?: Chip[][] }
// The settings screen: the picked row, and the models the Codex CLI lists (loaded when it opens).
type Settings = { row: number; codexModels: string[]; hasCodex: boolean }
// A GitHub action waiting for y.
type Confirm = { text: string; run: () => Promise<Done>; after?: () => Promise<unknown> }

type Props = { initialScope: Scope; initialConfigs: Configs; initialState: CliState }

export function App({ initialScope, initialConfigs, initialState }: Props) {
  const { exit } = useApp()
  const { columns, rows: height } = useWindowSize()
  const [snap, setSnap] = useState<Snapshot | null>(null)
  // How many refreshes and GitHub actions are running; the spinner turns while any is.
  const [busy, setBusy] = useState(0)
  const [frame, setFrame] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [isFiltering, setFiltering] = useState(false)
  const [isAll, setAll] = useState(initialScope.isAll)
  const [collapsed, setCollapsed] = useState(initialState.collapsed)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [now, setNow] = useState(Date.now())
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [isPanelOpen, setPanelOpen] = useState(false)
  const [panelTop, setPanelTop] = useState(0)
  const [panelPage, setPanelPage] = useState(0)
  // A reply being typed to a thread.
  const [draft, setDraft] = useState<{ thread: ThreadDetail; text: string } | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const isSaving = useRef(false)
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
  // Where the list's lines start on screen (0-based) and how many show, for mouse clicks.
  const listArea = useRef({ first: 0, room: 0 })

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
    setBusy(count => count + 1)
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
        announcements(before, next).forEach(notify)
      }
    } catch (err) {
      if (attempt === epoch.current) {
        setFlash({ text: err instanceof Error ? err.message : String(err), isError: true })
      }
    } finally {
      setBusy(count => count - 1)
      if (attempt === epoch.current) {
        inflight.current = false
      }
    }
  }

  // Switches between the current repo and every repo: the cache first, then GitHub, as at start.
  const toggleScope = () => {
    if (isAll && !scope.current.repo) {
      setFlash({ text: 'Not inside a GitHub repository', isError: true })

      return
    }
    scope.current = { ...scope.current, isAll: !isAll }
    setAll(!isAll)
    setFilter('')
    void load({ maxAgeMs: Infinity, canFetch: false }, { force: true, isQuiet: true }).then(() =>
      load({ maxAgeMs: 60 * 1000, canFetch: true }, { force: true, isQuiet: true }),
    )
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
    if (busy === 0) {
      return
    }
    const timer = setInterval(() => setFrame(one => (one + 1) % SPIN_FRAMES.length), 100)

    return () => clearInterval(timer)
  }, [busy === 0])

  // A sticky flash stays until something replaces it.
  useEffect(() => {
    if (!flash || flash.isSticky) {
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
    const name = { review: reviewLabel(pr), clean: 'Cleanup', ask: 'Ask', replies: 'Replies' }[action]
    const provider = PROVIDER_NAMES[configFor(configs.current, pr.repo).reportProvider]
    setFlash({ text: `${name} prompt for #${pr.number} copied · paste it into ${provider}` })
  }

  // Runs a GitHub action, says how it went and refreshes from GitHub when it worked.
  const runAction = async (work: Promise<Done>, after?: () => Promise<unknown>) => {
    setFlash({ text: 'Working…', isSticky: true })
    setBusy(count => count + 1)
    const result = await work
    setBusy(count => count - 1)
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
    if (!isRedo) {
      setPanelPage(0)
    }
    const isSame = panel?.kind === kind && panel.pr?.number === pr?.number && panel.pr?.repo === pr?.repo
    // Threads are acted on, so they are always fetched again.
    if (isSame && panel.status !== 'error' && !isRedo && kind !== 'threads') {
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
    if (kind === 'help') {
      result = { text: HELP }
    } else if (kind === 'digest') {
      const all = snapRef.current
      const rows = all ? [...all.rows, ...(all.current && !all.rows.some(one => rowKey(one) === rowKey(all.current!)) ? [all.current] : [])] : []
      result = await digest(rows.filter(one => one.state === 'OPEN'), all?.me ?? '', configs.current.current, streaming)
    } else if (kind === 'team') {
      const all = snapRef.current
      const repos = isAll ? [...new Set((all?.rows ?? []).map(one => one.repo).filter(Boolean))] : scope.current.repo ? [scope.current.repo] : []
      const prs = await fetchTeam(repos)
      if ('failure' in prs) {
        result = prs
      } else {
        const team = teamOf(prs, all?.me ?? '')
        const lines = teamLines(team, all?.me ?? '', Date.now())
        const where = repos.length === 1 ? repos[0] : `${repos.length} repos`
        write({ lines })
        result = { text: [`Open PRs in ${where}${team.drafts ? ` · ${team.drafts} draft${team.drafts === 1 ? '' : 's'} not shown` : ''}`, '', ...lines.map(line => line.map(one => one.text).join('').trimEnd())].join('\n') }
      }
    } else if (!pr?.repo) {
      result = { failure: 'Unknown repository for this PR' }
    } else if (kind === 'threads') {
      const data = await fetchThreads(pr.repo, pr.number)
      const me = snapRef.current?.me ?? ''
      const context = { me, isMine: pr.isMine, automated: compileRegex(configFor(configs.current, pr.repo).automatedComments) }
      const pages = data ? threadPages(data.threads, context).map(one => ({ ...one, text: threadMarkdown(one, me, localOffset()) })) : []
      write({ pages })
      result = data ? { text: pages.length === 0 ? 'No unresolved threads.' : '' } : { failure: 'Could not load the threads' }
    } else if (kind === 'pr') {
      const conversation = await fetchConversation(pr, localOffset())
      result = 'failure' in conversation ? conversation : { text: conversationMarkdown(conversation) }
    } else if (kind === 'report') {
      result = await quickReport(pr.repo, pr.number, configFor(configs.current, pr.repo), streaming)
    } else {
      const changes = await fetchChanges(pr, localOffset())
      result = 'failure' in changes ? changes : { text: changesMarkdown(changes) }
    }
    write('failure' in result ? { status: 'error', text: result.failure } : { status: 'done', text: result.text, at: Date.now() })
  }

  // ---- Settings: the AI provider and model, saved to the home config file as they change.
  const openSettings = async () => {
    setSettings({ row: 0, codexModels: [], hasCodex: !!Bun.which('codex') })
    const models = await codexModels()
    setSettings(one => one && { ...one, codexModels: models })
  }

  // The models offered for the saved provider, keeping a model typed into the file by hand.
  const modelChoices = (config: Config, codex: string[]) => {
    const [choices, value] = config.reportProvider === 'codex' ? [['', ...codex], config.codexModel] : [CLAUDE_MODELS, config.reportModel]

    return choices.includes(value) ? choices : [...choices, value]
  }

  const changeSetting = async (by: number) => {
    if (!settings || isSaving.current) {
      return
    }
    const home = configs.current.home
    const turn = <T,>(choices: T[], value: T) => choices[(choices.indexOf(value) + by + choices.length) % choices.length] ?? value
    let values: Record<string, string>
    if (settings.row === 0) {
      values = { report_provider: turn(REPORT_PROVIDERS, home.reportProvider) }
    } else if (home.reportProvider === 'codex') {
      values = { codex_model: turn(modelChoices(home, settings.codexModels), home.codexModel) }
    } else {
      values = { report_model: turn(modelChoices(home, settings.codexModels), home.reportModel) }
    }
    isSaving.current = true
    try {
      await saveHomeSettings(values)
      configs.current = await loadConfigs(scope.current, (await readState()).repos)
      setFlash({ text: `Saved to ${HOME_CONFIG_SHOWN}` })
    } catch (err) {
      setFlash({ text: `Could not save: ${err instanceof Error ? err.message : String(err)}`, isError: true })
    } finally {
      isSaving.current = false
    }
  }

  const onSettingsKey = (input: string, key: Key) => {
    if (input === 'q' || key.escape || input === 'S') {
      setSettings(null)
    } else if (key.downArrow || input === 'j' || key.upArrow || input === 'k') {
      setSettings(one => one && { ...one, row: 1 - one.row })
    } else if (key.rightArrow || input === 'l' || input === ' ' || key.return) {
      void changeSetting(1)
    } else if (key.leftArrow || input === 'h') {
      void changeSetting(-1)
    }
  }

  const toggleBucket = async (bucket: PrBucket) => {
    const next = collapsed.includes(bucket) ? collapsed.filter(one => one !== bucket) : [...collapsed, bucket]
    setCollapsed(next)
    await updateState({ collapsed: next })
  }

  // ---- What each PR offers, used by both the hints line and the keys.
  const canCheckout = (pr: PrRow) =>
    pr.state === 'OPEN' && !!scope.current.root && pr.repo === scope.current.repo && pr.headRef !== scope.current.branch
  const keysFor = (pr: PrRow): [string, string, KeyGroup][] => {
    const isOpen = pr.state === 'OPEN'
    const keys: [string, string | null, KeyGroup][] = [
      ['v', reviewLabel(pr) || null, 'copy'],
      ['a', 'Ask', 'copy'],
      ['c', pr.state === 'MERGED' ? 'Clean' : null, 'copy'],
      ['⏎', 'View', 'view'],
      ['t', pr.unresolved ? 'Threads' : null, 'view'],
      ['d', pr.rereview ? 'Changes' : null, 'view'],
      ['r', 'Report', 'view'],
      ['o', pr.url ? 'Open' : null, 'view'],
      ['m', pr.bucket === 'ready' ? 'Merge' : null, 'change'],
      ['R', rerequestable(pr).length > 0 ? 'Re-request' : null, 'change'],
      ['b', isOpen && pr.isBehind ? 'Update' : null, 'change'],
      ['g', canCheckout(pr) ? 'Checkout' : null, 'change'],
      ['s', pr.isNew ? 'Seen' : null, 'mark'],
      ['z', isOpen ? (pr.bucket === 'snoozed' ? 'Unsnooze' : 'Snooze') : null, 'mark'],
      ['Z', isOpen && pr.bucket !== 'snoozed' ? 'Till tomorrow' : null, 'mark'],
    ]

    return keys.filter((one): one is [string, string, KeyGroup] => one[1] !== null)
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
      case '⏎':
        return void openPanel('pr', pr)
      case 't':
        return void openPanel('threads', pr)
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
  const query = filter.trim().toLowerCase()
  const matches = (pr: PrRow) => !query || `#${pr.number} ${pr.title} ${pr.author} ${pr.repo}`.toLowerCase().includes(query)
  const showWho = columns >= 90
  const showAge = columns >= 70
  const showRepo = isAll && columns >= 100
  const groups = BUCKETS.map(one => ({ ...one, rows: list.filter(pr => pr.bucket === one.bucket && matches(pr)) })).filter(one => one.rows.length > 0)
  // While filtering, folded groups open so every match shows.
  const isFolded = (bucket: PrBucket) => collapsed.includes(bucket) && !query
  const items: Item[] = [
    ...(current ? [{ key: 'current', pr: current }] : []),
    ...groups.flatMap(({ bucket, rows }) => [
      { key: `bucket:${bucket}`, bucket },
      ...(isFolded(bucket) ? [] : rows.map(pr => ({ key: `row:${rowKey(pr)}`, pr }))),
    ]),
  ]
  // The remembered selection while it still exists, otherwise the first PR.
  const picked = items.find(item => item.key === selected) ?? items.find(item => item.pr) ?? items[0] ?? null
  pickedKey.current = picked?.key ?? null
  const lines: Line[] = []

  // On the selected row nothing is dim, so it stays readable on the highlight.
  const chip = (one: Chip, key: string, isPicked = false) => (
    <Text key={key} color={one.color ? COLORS[one.color] : undefined} dimColor={one.dim && !isPicked} wrap="truncate-end">
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
    const extras = [...(isHere(pr, key) ? [{ text: '◉ here', dim: true }] : []), ...extraChips(pr)]
    const stale = staleness(pr, now)

    return (
      <Box key={key} backgroundColor={isPicked ? 'gray' : undefined} flexGrow={1}>
        {cell(1, <Text bold>{isPicked ? '▸' : ' '}</Text>, 'pointer')}
        {cell(2, <Text color="yellow">{pr.isNew ? '●' : ' '}</Text>, 'new')}
        {showRepo && cell(16, <Text dimColor={!isPicked} wrap="truncate-end">{pr.repo.split('/')[1]}</Text>, 'repo')}
        {cell(7, <Text bold={isPicked}>#{pr.number}</Text>, 'number')}
        {cell(10, chip(reviewChip(pr), 'review', isPicked), 'review')}
        {cell(8, chip(ciChip(pr), 'ci', isPicked), 'ci')}
        {cell(4, chip(threadsChip(pr), 'threads', isPicked), 'threads')}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold={pr.isNew || isPicked} dimColor={pr.bucket === 'snoozed' && !isPicked} wrap="truncate-end">
            {pr.title}
          </Text>
        </Box>
        {extras.map((one, index) => (
          <Box key={`extra-${index}`} flexShrink={0} marginLeft={1}>
            {chip(one, 'chip', isPicked)}
          </Box>
        ))}
        {showWho && (
          <Box width={14} flexShrink={0} marginLeft={1}>
            <Text dimColor={!isPicked} wrap="truncate-end">
              {pr.isMine ? 'you' : pr.author}
            </Text>
          </Box>
        )}
        {showAge && (
          <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end">
            <Text color={stale ? COLORS[stale] : undefined} dimColor={!stale && !isPicked}>
              {pr.lastOtherAt ? age(pr.lastOtherAt, now) : ''}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  const addRow = (pr: PrRow, key: string) => {
    lines.push({ key, item: key, node: rowLine(pr, key, key === picked?.key) })
  }

  let header: ReactNode = null
  if (snap?.checkedAt && list.length > 0) {
    header = (
      <Box>
        {cell(3, <Text> </Text>, 'marker')}
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
  if (snap?.checkedAt && !query && list.every(pr => pr.bucket === 'others' || pr.bucket === 'snoozed')) {
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
  if (query && groups.length === 0) {
    lines.push({ key: 'no-match', node: <Text dimColor>No PRs match “{filter.trim()}” · esc clears the filter</Text> })
  }
  for (const { bucket, title, color, rows: group } of groups) {
    const key = `bucket:${bucket}`
    lines.push({ key: `${key}-gap`, node: <Text> </Text> })
    lines.push({
      key,
      item: key,
      node: (
        <Text color={color} dimColor={!color} bold={key === picked?.key} inverse={key === picked?.key}>
          {isFolded(bucket) ? '▸' : '▾'} {title} · {group.length}
        </Text>
      ),
    })
    if (!isFolded(bucket)) {
      for (const pr of group) {
        addRow(pr, `row:${rowKey(pr)}`)
      }
    }
  }

  // ---- The selected item's details and keys, fixed above the footer so the list never shifts.
  const details = (): ReactNode[] => {
    const pr = picked?.pr
    if (!pr) {
      const hint = picked?.bucket ? `⏎ ${isFolded(picked.bucket) ? 'unfold' : 'fold'} this group` : ' '

      return [<Text key="detail" dimColor>{hint}</Text>, <Text key="actions"> </Text>]
    }
    const where = isAll && !showRepo ? `${pr.repo}  ·  ` : ''
    const who = showWho ? '' : `${pr.isMine ? 'you' : pr.author}  ·  `
    const byGroup = KEY_GROUPS.map(group => keysFor(pr).filter(one => one[2] === group)).filter(one => one.length > 0)

    return [
      <Text key="detail" dimColor wrap="truncate-end">
        {where}
        {who}
        {detailOf(pr, now)}
      </Text>,
      <Text key="actions" wrap="truncate-end">
        {byGroup.map((keys, index) => (
          <Text key={index}>
            {index > 0 && <Text dimColor>{'  │  '}</Text>}
            <Text color={keys[0]?.[2] === 'change' ? 'yellow' : 'cyan'}>{keys.map(([one, label]) => `${one} ${label}`).join('  ')}</Text>
          </Text>
        ))}
      </Text>,
    ]
  }

  // ---- The panel, which replaces the list while open.
  const pages = panel?.pages ?? []
  const pageAt = Math.max(0, Math.min(panelPage, pages.length - 1))
  const page = pages[pageAt]
  const panelText = page?.text ?? panel?.text ?? ''
  const panelLines = panel?.lines
    ? panel.lines.map(line => (
        <Text wrap="truncate-end">
          {line.map((one, index) => (
            <Text key={index} color={one.color ? COLORS[one.color] : undefined} dimColor={one.dim}>
              {one.text}
            </Text>
          ))}
        </Text>
      ))
    : panel
      ? markdownLines(panelText || ' ', columns - 2)
      : []
  const panelRoom = Math.max(3, height - 5)
  const panelMax = Math.max(0, panelLines.length - panelRoom)

  type Key = {
    escape: boolean
    downArrow: boolean
    upArrow: boolean
    leftArrow: boolean
    rightArrow: boolean
    pageDown: boolean
    pageUp: boolean
    home: boolean
    end: boolean
    return: boolean
  }

  const onPanelKey = (input: string, key: Key) => {
    if (!panel) {
      return
    }
    const isDone = panel.status === 'done'
    const isHelp = panel.kind === 'help'
    const pr = panel.pr
    const turn = (to: number) => {
      setPanelPage(Math.max(0, Math.min(pages.length - 1, to)))
      setPanelTop(0)
    }
    if (input === 'q' || key.escape || (isHelp && input === '?')) {
      setPanelOpen(false)
    } else if (key.downArrow || input === 'j') {
      setPanelTop(top => Math.min(panelMax, top + 1))
    } else if (key.upArrow || input === 'k') {
      setPanelTop(top => Math.max(0, top - 1))
    } else if (key.pageDown || input === ' ') {
      setPanelTop(top => Math.min(panelMax, top + panelRoom - 1))
    } else if (key.pageUp || input === 'b') {
      setPanelTop(top => Math.max(0, top - panelRoom + 1))
    } else if (key.home || input === 'g') {
      setPanelTop(0)
    } else if (key.end || input === 'G') {
      setPanelTop(panelMax)
    } else if (page && (key.rightArrow || input === 'n')) {
      turn(pageAt + 1)
    } else if (page && (key.leftArrow || input === 'p')) {
      turn(pageAt - 1)
    } else if (input === 'r' && page?.thread.canReply) {
      setDraft({ thread: page.thread, text: '' })
    } else if (input === 's' && pr && page?.thread.canResolve) {
      const { thread } = page
      setConfirm({
        text: `Resolve the thread on ${thread.path}${thread.line ? `:${thread.line}` : ''}?`,
        run: () => resolveThread(thread.id),
        after: () => openPanel('threads', pr, true),
      })
    } else if (input === 'o' && page?.thread.url) {
      openUrl(page.thread.url)
    } else if (input === 'c' && isDone && !isHelp) {
      void copy(panelText).then(isCopied => setFlash(isCopied ? { text: 'Copied' } : { text: 'Could not copy', isError: true }))
    } else if (input === 'x' && panel.status !== 'loading' && !isHelp) {
      void openPanel(panel.kind, pr, true)
    } else if (input === 'o' && pr?.url) {
      openUrl(pr.url)
    } else if (input === 'a' && isDone && pr && panel.kind === 'report') {
      void act('ask', pr, panel.text)
    } else if (input === 'a' && pr && panel.kind === 'pr') {
      void act('ask', pr)
    } else if (input === 'a' && pr && panel.kind === 'threads' && pr.replies?.length) {
      void act('replies', pr)
    } else if (input === 'v' && pr && (panel.kind === 'changes' || panel.kind === 'pr') && reviewLabel(pr)) {
      void act('review', pr)
    }
  }

  // Typing a reply: ⏎ posts it and shows the thread again, esc drops it.
  const onDraftKey = (input: string, key: { escape: boolean; return: boolean; backspace: boolean; delete: boolean; ctrl: boolean; meta: boolean }) => {
    if (!draft) {
      return
    }
    if (key.escape) {
      setDraft(null)
      setFlash({ text: 'Reply discarded' })
    } else if (key.return) {
      const body = draft.text.trim()
      const pr = panel?.pr
      if (!body || !pr) {
        return
      }
      setDraft(null)
      void runAction(replyToThread(draft.thread.id, body), () => openPanel('threads', pr, true))
    } else if (key.backspace || key.delete) {
      setDraft({ ...draft, text: draft.text.slice(0, -1) })
    } else if (input && !key.ctrl && !key.meta) {
      // A pasted reply keeps its line breaks.
      setDraft({ ...draft, text: draft.text + input.replace(/\r\n?/g, '\n') })
    }
  }

  // Typing a filter: letters go to the filter, arrows still move, ⏎ keeps it and esc clears it.
  const onFilterKey = (input: string, key: { escape: boolean; return: boolean; backspace: boolean; delete: boolean; ctrl: boolean; meta: boolean }) => {
    if (key.escape) {
      setFilter('')
      setFiltering(false)
    } else if (key.return) {
      setFiltering(false)
    } else if (key.backspace || key.delete) {
      setFilter(text => text.slice(0, -1))
    } else if (input && !key.ctrl && !key.meta) {
      setFilter(text => text + input)
    }
  }

  const pick = (key: string | null) => {
    pickedKey.current = key
    setSelected(key)
  }
  const step = (by: number) => {
    const index = items.findIndex(item => item.key === pickedKey.current)
    pick(items[Math.max(0, Math.min(items.length - 1, index + by))]?.key ?? null)
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()

      return
    }
    if (confirm) {
      setConfirm(null)
      if (input === 'y') {
        void runAction(confirm.run(), confirm.after)
      } else {
        setFlash({ text: 'Cancelled' })
      }

      return
    }
    if (draft) {
      onDraftKey(input, key)

      return
    }
    if (settings) {
      onSettingsKey(input, key)

      return
    }
    if (isPanelOpen) {
      onPanelKey(input, key)

      return
    }
    const at = items.find(item => item.key === pickedKey.current) ?? picked
    if (key.downArrow || (!isFiltering && input === 'j')) {
      step(1)
    } else if (key.upArrow || (!isFiltering && input === 'k')) {
      step(-1)
    } else if (isFiltering) {
      onFilterKey(input, key)
    } else if (input === 'q') {
      exit()
    } else if (key.escape) {
      // esc never quits, so leaving a panel with one esc too many is harmless.
      setFilter('')
    } else if (input === '/') {
      setFiltering(true)
    } else if (input === '?') {
      void openPanel('help', null)
    } else if (input === 'A') {
      toggleScope()
    } else if (input === 'u') {
      void load({ maxAgeMs: 0, canFetch: true }, { force: true })
    } else if (input === 'D') {
      void openPanel('digest', null)
    } else if (input === 'T') {
      void openPanel('team', null)
    } else if (input === 'S') {
      void openSettings()
    } else if (at?.bucket && (key.return || input === ' ')) {
      void toggleBucket(at.bucket)
    } else if (at?.pr) {
      onPrKey(key.return ? '⏎' : input, at.pr)
    }
  })

  // The wheel moves the selection or scrolls the panel; a click picks an item, and a second click acts like ⏎ (a group folds at once).
  useMouse(({ kind, y }) => {
    if (confirm || draft || settings) {
      return
    }
    const by = kind === 'wheelDown' ? 1 : kind === 'wheelUp' ? -1 : 0
    if (isPanelOpen) {
      setPanelTop(top => Math.max(0, Math.min(panelMax, top + by * 3)))

      return
    }
    if (by) {
      step(by)

      return
    }
    const row = y - 1 - listArea.current.first
    const key = row >= 0 && row < listArea.current.room ? lines[offset.current + row]?.item : undefined
    const item = items.find(one => one.key === key)
    if (!item) {
      return
    }
    const isPicked = item.key === pickedKey.current
    pick(item.key)
    if (item.bucket) {
      void toggleBucket(item.bucket)
    } else if (item.pr && isPicked) {
      onPrKey('⏎', item.pr)
    }
  })

  const footer = (keys: string) => (
    <Box key="footer" flexDirection="column">
      {confirm ? (
        <Text color="yellow" wrap="truncate-end">
          {confirm.text} <Text bold>y</Text> confirm · any other key cancels
        </Text>
      ) : draft ? (
        <Text color="cyan" wrap="truncate-start">
          Reply › {draft.text.replace(/\n/g, ' ⏎ ')}▏
        </Text>
      ) : (
        <Text color={flash?.isError ? 'red' : 'green'} wrap="truncate-end">
          {flash?.text ?? ' '}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {draft ? `replying on ${draft.thread.path}${draft.thread.line ? `:${draft.thread.line}` : ''} · ⏎ post · esc cancel` : keys}
      </Text>
    </Box>
  )

  if (settings) {
    const { home, current } = configs.current
    const choice = (value: string, isPicked: boolean, isRowPicked: boolean) => (
      <Text key={value} color={isPicked ? 'cyan' : undefined} inverse={isPicked && isRowPicked} dimColor={!isPicked}>
        {` ${value || 'default'} `}
      </Text>
    )
    const isCodex = home.reportProvider === 'codex'
    const model = isCodex ? home.codexModel : home.reportModel
    const rows = [
      { name: 'Provider', choices: REPORT_PROVIDERS as string[], value: home.reportProvider },
      { name: 'Model', choices: modelChoices(home, settings.codexModels), value: model },
    ]
    // A repo's own files win over the home file, so say when they change what applies here.
    const overrides = [
      current.reportProvider !== home.reportProvider ? `provider ${current.reportProvider}` : null,
      reportModelLabel(current) !== reportModelLabel(home) && current.reportProvider === home.reportProvider ? `model ${reportModelLabel(current)}` : null,
    ].filter(Boolean)
    const body: ReactNode[] = [
      <Text bold>AI for reports and the digest</Text>,
      <Text> </Text>,
      ...rows.map(({ name, choices, value }, index) => (
        <Text wrap="wrap">
          <Text bold={index === settings.row}>{index === settings.row ? '▸ ' : '  '}</Text>
          <Text bold={index === settings.row}>{name.padEnd(10)}</Text>
          {choices.map(one => choice(one, one === value, index === settings.row))}
        </Text>
      )),
      <Text> </Text>,
      <Text dimColor wrap="wrap">
        {isCodex
          ? 'Codex runs the codex CLI with its own login (codex login); default is the model Codex picks.'
          : 'Claude runs the claude CLI with its own login.'}
      </Text>,
      ...(isCodex && !settings.hasCodex ? [<Text color="yellow">The codex CLI is not on your PATH.</Text>] : []),
      ...(overrides.length > 0
        ? [<Text color="yellow" wrap="wrap">{`This repo's .claude/pr-monitor files set ${overrides.join(' and ')}, which wins here.`}</Text>]
        : []),
    ].map((node, index) => <Box key={index}>{node}</Box>)

    return (
      <Panel
        height={height}
        title="Settings"
        meta=""
        subtitle={`saved to ${HOME_CONFIG_SHOWN}`}
        body={body}
        top={0}
        room={Math.max(3, height - 5)}
        footer={footer('↑↓ setting · ←→ change · esc back')}
      />
    )
  }

  if (isPanelOpen && panel) {
    const { kind, pr, status } = panel
    const isHelp = kind === 'help'
    const model = kind === 'report' || kind === 'digest' ? reportModelLabel(configFor(configs.current, pr?.repo ?? '')) : ''
    const meta = isHelp ? '' : [model, status === 'loading' ? 'loading…' : status === 'done' ? ago(new Date(panel.at).toISOString(), now) : ''].filter(Boolean).join(' · ')
    const names = { pr: 'PR', report: 'Report', changes: 'Changes since my review', threads: 'Threads' }
    const title =
      kind === 'digest'
        ? 'Digest · what to do first'
        : kind === 'team'
          ? 'Team · who reviews whom'
          : kind === 'help'
            ? 'Keys and symbols'
            : `${names[kind]} · #${pr?.number} ${pr?.title}`
    const keys = [
      '↑↓ scroll',
      status === 'done' && kind === 'report' ? 'a Ask with report' : null,
      kind === 'pr' ? 'a Ask' : null,
      pages.length > 1 ? '←→ thread' : null,
      page?.thread.canReply ? 'r Reply' : null,
      page?.thread.canResolve ? 's Resolve' : null,
      kind === 'threads' && pr?.replies?.length ? 'a Draft replies' : null,
      (kind === 'changes' || kind === 'pr') && pr && reviewLabel(pr) ? `v ${reviewLabel(pr)}` : null,
      status === 'done' && !isHelp ? 'c Copy' : null,
      pr?.url ? 'o Open' : null,
      status !== 'loading' && !isHelp ? 'x Redo' : null,
      'esc back',
    ]

    return (
      <Panel
        height={height}
        title={title}
        meta={meta}
        subtitle={
          isHelp
            ? ''
            : [pr?.repo ?? (isAll ? 'all repos' : (scope.current.repo ?? '')), page ? `thread ${pageAt + 1} of ${pages.length}` : ''].filter(Boolean).join(' · ')
        }
        error={status === 'error' ? panel.text : undefined}
        placeholder={status === 'loading' && !panel.text ? (kind === 'digest' ? 'Weighing your PRs…' : kind === 'team' ? 'Reading the open PRs…' : 'Reading the PR…') : undefined}
        body={panelLines}
        top={Math.min(panelTop, panelMax)}
        room={panelRoom}
        footer={footer(keys.filter(Boolean).join(' · '))}
      />
    )
  }

  // ---- Fixed top and bottom lines around the scrolling area.
  const top: ReactNode[] = []
  const spinner = busy > 0 ? (SPIN_FRAMES[frame] ?? '↻') : '↻'
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
      <Text dimColor={busy === 0}>{spinner}</Text>
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
  if (isFiltering || filter) {
    top.push(
      <Text key="filter" color="cyan" wrap="truncate-end">
        / {filter}
        {isFiltering ? '▏' : ''}
      </Text>,
    )
  }
  if (header) {
    top.push(<Box key="header">{header}</Box>)
  }

  // Scroll just enough to keep the selected item in view; the details area and the footer take five lines.
  const room = Math.max(3, height - top.length - 5)
  const first = lines.findIndex(line => line.item === picked?.key)
  const last = lines.findLastIndex(line => line.item === picked?.key)
  if (first >= 0 && first < offset.current) {
    offset.current = first
  } else if (last >= 0 && last >= offset.current + room) {
    offset.current = last - room + 1
  }
  offset.current = Math.max(0, Math.min(offset.current, lines.length - room))
  listArea.current = { first: top.length, room }
  const keys = isFiltering
    ? 'type to filter by number, title, author or repo · ↑↓ move · ⏎ keep · esc clear'
    : [
        '↑↓ move · ⏎ fold / view · / filter',
        isAll && !scope.current.repo ? null : `A ${isAll ? 'this repo' : 'all repos'}`,
        'D digest · T team · u refresh · S settings · ? keys · q quit',
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <Box flexDirection="column" height={height}>
      {top}
      <Box flexDirection="column" flexGrow={1}>
        {lines.slice(offset.current, offset.current + room).map(line => (
          <Box key={line.key}>{line.node}</Box>
        ))}
      </Box>
      <Box flexDirection="column" borderStyle="single" borderDimColor borderBottom={false} borderLeft={false} borderRight={false} paddingLeft={3}>
        {details()}
      </Box>
      {footer(keys)}
    </Box>
  )
}
