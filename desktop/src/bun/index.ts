import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Tray, Updater, Utils, type RPCSchema } from 'electrobun/main'

import { codexModels, quickReport } from '../../../src/ai'
import { copy } from '../../../src/actions'
import { fetchConversation, fetchThreads, gh, postReview, readState, replyToThread, resolveThread, updateState } from '../../../src/github'
import { compileRegex, REPORT_PROVIDERS, reportModelLabel, rowKey, threadPages } from '../../../src/lib/lib'
import type { Config, ReportProvider } from '../../../src/lib/lib'
import { reviewPayload } from '../../../src/lib/review'
import type { ExplainStart, ReviewStart, ReviewState, Triage } from '../../../src/lib/review'
import { announcements, configFor, detectScope, HOME_CONFIG, loadConfig, loadConfigs, refresh, saveHomeSettings } from '../../../src/monitor'
import type { Configs, Scope, Snapshot } from '../../../src/monitor'
import { openAddress, openExplain, openReview } from '../../../src/review'
import type { AddressSession, ExplainSession, ExplainState, ReviewSession } from '../../../src/review'
import type { PrRow } from '../../../src/types'
import { providerFor, withoutRepo, withRepo } from '../shared/repos'
import type { DesktopState } from '../shared/repos'
import type { AddressUpdate, PrsRpc, ReportUpdate, Settings, ThreadsData } from '../shared/rpc'
import { readDesktopState, repoAt, scopeOf, writeDesktopState } from './repos'
import { readFrame, writeFrame } from './frame'
import { fetchImage } from './image'
import { readReviews, writeReview } from './saved'

// Apps opened from Finder or a desktop launcher get a minimal PATH, so gh, git, claude and codex would not be found.
// On Windows the PATH is fixed at launch, so gh's install folder is added for a gh installed while the app runs.
{
  const extra =
    process.platform === 'win32'
      ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI')]
      : [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', '/usr/bin']
  process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(delimiter), ...extra])].filter(Boolean).join(delimiter)
  // Bun.spawn and Bun.which keep the PATH the app started with unless given one, so the shared code gets it here.
  const { spawn, which } = Bun
  Object.assign(Bun, {
    spawn: (command: Parameters<typeof spawn>[0], options?: Parameters<typeof spawn>[1]) => spawn(command, { env: process.env, ...options }),
    which: (command: string, options?: Parameters<typeof which>[1]) => which(command, { PATH: process.env.PATH, ...options }),
  })
}

// Who I am, what was shown and the repos' configs as of the last refresh, for the requests that need them.
let latest: { me: string; scope: Scope; configs: Configs } | null = null

// Bumped when the active repo changes, so a poll that started before does not show the old repo's PRs.
let generation = 0

// The active repo as if the CLI ran in its clone; with none, every repo involving me (like --all).
async function load(maxAgeMs: number): Promise<Snapshot> {
  const [state, desktop] = await Promise.all([readState(), readDesktopState()])
  const entry = desktop.repos.find(one => one.repo === desktop.active)
  const scope = entry ? await scopeOf(entry) : await detectScope(true, state.repos)
  const configs = await loadConfigs(scope, state.repos)
  const started = generation
  const snapshot = await refresh(scope, configs, { seen: state.seen, snoozed: state.snoozed }, { maxAgeMs, canFetch: true })
  if (snapshot.me) {
    latest = { me: snapshot.me, scope, configs }
  }
  announce(started, snapshot)

  return { ...snapshot, rows: snapshot.rows.filter(pr => pr.bucket !== 'snoozed') }
}

// The last refresh's result, to notify only about what changed since; the first load and a repo switch stay quiet.
let shown: { generation: number; snapshot: Snapshot } | null = null

function announce(started: number, next: Snapshot): void {
  if (started !== generation) {
    return
  }
  const before = shown?.generation === started ? shown.snapshot : null
  shown = { generation: started, snapshot: next }
  if (before?.checkedAt && next.checkedAt !== before.checkedAt) {
    for (const body of announcements(before, next)) {
      Utils.showNotification({ title: 'Team PRs', body })
    }
  }
}

async function threads(pr: PrRow): Promise<ThreadsData | { failure: string }> {
  const data = await fetchThreads(pr.repo, pr.number)
  if (!data || !latest) {
    return { failure: 'Could not load the threads' }
  }
  const automated = compileRegex(configFor(latest.configs, pr.repo).automatedComments)

  return { me: latest.me, pages: threadPages(data.threads, { me: latest.me, isMine: pr.isMine, automated }) }
}

async function diff(pr: PrRow): Promise<{ text: string } | { failure: string }> {
  const result = await gh(['pr', 'diff', String(pr.number), '--repo', pr.repo])

  return result.exitCode === 0 ? { text: result.stdout } : { failure: result.stderr.trim() || 'gh pr diff failed' }
}

async function addRepo(): Promise<DesktopState | { failure: string } | null> {
  const [folder] = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false })
  if (!folder) {
    return null
  }
  const entry = await repoAt(folder)
  if ('failure' in entry) {
    return entry
  }
  const next = withRepo(await readDesktopState(), entry)
  await writeDesktopState(next)
  // The CLI's map of clones, which "All repos" reads each repo's config through.
  await updateState({ repos: { [entry.repo]: entry.root } })
  generation++

  return next
}

// The reports being written, by row key, so starting one again or cancelling stops the one before.
const writing = new Map<string, AbortController>()

// The PR's repo config with the provider this app uses; provider is null once every AI provider is off.
async function aiConfig(pr: PrRow): Promise<{ config: Config; provider: ReportProvider | null }> {
  const [loaded, { providers }] = await Promise.all([latest ? configFor(latest.configs, pr.repo) : loadConfig(null), readDesktopState()])
  const provider = providerFor(loaded, providers)

  return { config: { ...loaded, reportProvider: provider ?? loaded.reportProvider }, provider }
}

// Without the CLI the SDK falls back to a bundled copy this app does not ship, and fails obscurely.
const NO_CLAUDE = 'Claude Code CLI not found on PATH (install it, then run claude once to sign in)'
const NO_CODEX = 'Codex CLI not found on PATH (npm i -g @openai/codex, then codex login)'

async function startReport(pr: PrRow): Promise<boolean> {
  const key = rowKey(pr)
  writing.get(key)?.abort()
  const controller = new AbortController()
  writing.set(key, controller)
  const { config, provider } = await aiConfig(pr)
  const model = provider ? reportModelLabel(config) : ''
  // Nothing reaches the webview once the report was cancelled or started again.
  const send = (update: Omit<ReportUpdate, 'key' | 'model'>) => {
    if (writing.get(key) === controller) {
      window.webview.rpc?.send.report({ key, model, ...update })
    }
  }
  if (!provider) {
    send({ text: '', isDone: true, failure: 'AI is turned off in Settings' })
  } else if (config.reportProvider === 'claude' && !Bun.which('claude')) {
    send({ text: '', isDone: true, failure: NO_CLAUDE })
  } else {
    const result = await quickReport(pr.repo, pr.number, config, {
      onText: text => send({ text, isDone: false, failure: null }),
      signal: controller.signal,
    }).catch((err: unknown) => ({ failure: err instanceof Error ? err.message : String(err) }))
    send('failure' in result ? { text: '', isDone: true, failure: result.failure } : { text: result.text, isDone: true, failure: null })
  }
  if (writing.get(key) === controller) {
    writing.delete(key)
  }

  return true
}

function cancelReport(key: string): boolean {
  writing.get(key)?.abort()
  writing.delete(key)

  return true
}

// The open review sessions, by row key; each stays open for my messages until replaced or cancelled.
const reviews = new Map<string, ReviewSession>()

// The model a review or explanation uses, and why it cannot start when it cannot.
async function reviewer(pr: PrRow): Promise<{ config: Config; model: string; failure: string | null }> {
  const { config, provider } = await aiConfig(pr)
  // Codex uses the report's Codex model, with the review's effort.
  const model = provider === 'codex' ? `Codex ${config.codexModel || 'default model'}` : config.reviewModel
  const failure = !provider
    ? 'AI is turned off in Settings'
    : provider === 'claude' && !Bun.which('claude')
      ? NO_CLAUDE
      : provider === 'codex' && !Bun.which('codex')
        ? NO_CODEX
        : null

  return { config, model: `${model} · ${config.reviewEffort}`, failure }
}

// A clone of the repo lets the model read the PR's code, not just its diff.
async function cloneOf(pr: PrRow): Promise<string | null> {
  const [desktop, cli] = await Promise.all([readDesktopState(), readState()])

  return desktop.repos.find(one => one.repo === pr.repo)?.root ?? cli.repos[pr.repo] ?? null
}

async function startReview(pr: PrRow, start: ReviewStart): Promise<boolean> {
  const key = rowKey(pr)
  reviews.get(key)?.close()
  reviews.delete(key)
  // A new review numbers its findings anew, so their explanations go.
  if (start.kind === 'fresh') {
    closeExplains(key)
  }
  const { config, model, failure } = await reviewer(pr)
  const send = (state: ReviewState) => window.webview.rpc?.send.review({ key, model, ...state })
  if (failure) {
    const empty = { findings: [], summary: null, messages: [], turn: 0, draft: null, commitId: null, suggestions: [] }
    send({ ...(start.kind === 'fresh' ? empty : start.prior), isBusy: false, failure, hasCode: null, activity: null })
  } else {
    const root = await cloneOf(pr)
    // Nothing reaches the webview from a review that was replaced or cancelled.
    const session: ReviewSession = openReview(pr.repo, pr.number, config, root, start, state => {
      if (reviews.get(key) === session) {
        send(state)
      }
    })
    reviews.set(key, session)
  }

  return true
}

// My message goes to the open session; with none (it ended, or the review was saved before a restart), a new one
// carries on from where the review stands.
function sendReview(pr: PrRow, text: string, refs: number[], triage: Record<number, Triage>, prior: ReviewState): boolean {
  const session = reviews.get(rowKey(pr))
  if (session?.isOpen()) {
    return session.send(text, refs, triage)
  }
  void startReview(pr, { kind: 'continue', prior, triage, text, refs })

  return true
}

function closeReview(key: string): boolean {
  reviews.get(key)?.close()
  reviews.delete(key)
  closeExplains(key)

  return true
}

// The open explanations of findings, by row key and finding.
const explains = new Map<string, ExplainSession>()
const explainKey = (key: string, findingId: number) => `${key}#${findingId}`

function closeExplains(key: string) {
  for (const [at, session] of explains) {
    if (at.startsWith(`${key}#`)) {
      session.close()
      explains.delete(at)
    }
  }
}

async function startExplain(pr: PrRow, start: ExplainStart): Promise<boolean> {
  const key = rowKey(pr)
  const findingId = start.finding.id
  const at = explainKey(key, findingId)
  explains.get(at)?.close()
  explains.delete(at)
  const { config, model, failure } = await reviewer(pr)
  const send = (state: ExplainState) => window.webview.rpc?.send.explain({ key, findingId, model, ...state })
  if (failure) {
    const messages = [...start.prior, ...(start.text ? [{ role: 'me' as const, text: start.text, refs: [], changes: [] }] : [])]
    send({ messages, isBusy: false, failure, hasCode: null, activity: null, assessment: null })
  } else {
    const root = await cloneOf(pr)
    const session: ExplainSession = openExplain(pr.repo, pr.number, config, root, start, state => {
      if (explains.get(at) === session) {
        send(state)
      }
    })
    explains.set(at, session)
  }

  return true
}

function sendExplain(pr: PrRow, start: ExplainStart & { text: string }): boolean {
  const session = explains.get(explainKey(rowKey(pr), start.finding.id))
  if (session?.isOpen()) {
    return session.send(start.text)
  }
  void startExplain(pr, start)

  return true
}

// The drafts being made for the threads waiting on me, by row key.
const addressing = new Map<string, AddressSession>()

async function startAddress(pr: PrRow): Promise<boolean> {
  const key = rowKey(pr)
  addressing.get(key)?.close()
  addressing.delete(key)
  const { config, model, failure } = await reviewer(pr)
  const send = (state: Omit<AddressUpdate, 'key' | 'model'>) => window.webview.rpc?.send.address({ key, model, ...state })
  const stopped = (why: string) => send({ plans: [], count: 0, isBusy: false, failure: why, hasCode: null, activity: null, commitId: null })
  if (failure) {
    stopped(failure)
    return true
  }
  const [data, root] = await Promise.all([threads(pr), cloneOf(pr)])
  if ('failure' in data) {
    stopped(data.failure)
    return true
  }
  const owed = data.pages.filter(page => page.isOwed).map(page => page.thread)
  if (owed.length === 0) {
    stopped('No threads are waiting for your reply')
    return true
  }
  // Nothing reaches the webview from drafts that were replaced or cancelled.
  const session: AddressSession = openAddress(pr.repo, pr.number, config, root, { all: data.pages.map(page => page.thread), owed, isMine: pr.isMine }, state => {
    if (addressing.get(key) === session) {
      send(state)
    }
  })
  addressing.set(key, session)

  return true
}

function cancelAddress(key: string): boolean {
  addressing.get(key)?.close()
  addressing.delete(key)

  return true
}

// Asked once: listing Codex's models runs the codex CLI.
let codexList: Promise<string[]> | null = null

async function settings(): Promise<Settings> {
  codexList ??= codexModels()
  const [home, { providers }] = await Promise.all([loadConfig(null), readDesktopState()])
  // What this app uses, after a provider that is off falls back to one that is on.
  const used = (config: Config) => reportModelLabel({ ...config, reportProvider: providerFor(config, providers) ?? config.reportProvider })
  const overrides = Object.entries(latest?.configs.byRepo ?? {})
    .filter(([, config]) => used(config) !== used(home))
    .map(([repo, config]) => ({ repo, model: used(config) }))

  return {
    path: HOME_CONFIG.replace(homedir(), '~'),
    provider: providerFor(home, providers) ?? home.reportProvider,
    savedProvider: home.reportProvider,
    claudeModel: home.reportModel,
    codexModel: home.codexModel,
    reviewModel: home.reviewModel,
    reviewEffort: home.reviewEffort,
    codexModels: await codexList,
    hasClaude: !!Bun.which('claude'),
    hasCodex: !!Bun.which('codex'),
    overrides,
  }
}

async function saveSettings(values: Record<string, string>): Promise<Settings | { failure: string }> {
  try {
    await saveHomeSettings(values)
  } catch (err) {
    return { failure: err instanceof Error ? err.message : String(err) }
  }
  // Reports read the configs from the last refresh, so they pick the change up without one.
  if (latest) {
    latest = { ...latest, configs: await loadConfigs(latest.scope, (await readState()).repos) }
  }

  return settings()
}

// What the OS does on a title bar double click: macOS lets the user choose, elsewhere it maximizes.
async function titleBarDoubleClick(): Promise<boolean> {
  const choice =
    process.platform === 'darwin' ? (await Bun.$`defaults read -g AppleActionOnDoubleClick`.nothrow().quiet().text()).trim() : 'Maximize'
  if (choice === 'Minimize') {
    window.minimize()
  } else if (choice !== 'None') {
    window.isMaximized() ? window.unmaximize() : window.maximize()
  }

  return true
}

async function changeRepos(change: (state: DesktopState) => DesktopState): Promise<DesktopState> {
  const before = await readDesktopState()
  const next = change(before)
  await writeDesktopState(next)
  if (next.active !== before.active) {
    generation++
  }

  return next
}

const rpc = BrowserView.defineRPC<{ bun: RPCSchema<PrsRpc['bun']>; webview: RPCSchema<PrsRpc['webview']> }>({
  maxRequestTime: 60 * 1000,
  handlers: {
    requests: {
      refresh: ({ force }) => load(force ? 0 : 60 * 1000),
      openUrl: ({ url }) => Utils.openExternal(url),
      copy: ({ text }) => copy(text),
      image: ({ url }) => fetchImage(url),
      // The webview formats dates itself, so no offset is needed.
      conversation: ({ pr }) => fetchConversation(pr, 0),
      threads: ({ pr }) => threads(pr),
      diff: ({ pr }) => diff(pr),
      reply: ({ threadId, body }) => replyToThread(threadId, body),
      resolve: ({ threadId }) => resolveThread(threadId),
      repos: () => readDesktopState(),
      addRepo: () => addRepo(),
      removeRepo: ({ repo }) => changeRepos(state => withoutRepo(state, repo)),
      setActive: ({ repo }) => changeRepos(state => ({ ...state, active: state.repos.some(one => one.repo === repo) ? repo : null })),
      setAutoReport: ({ isOn }) => changeRepos(state => ({ ...state, autoReport: isOn })),
      setKeepInTray: async ({ isOn }) => {
        const next = await changeRepos(state => ({ ...state, keepInTray: isOn }))
        showTray(isOn)

        return next
      },
      setProviders: ({ providers }) => changeRepos(state => ({ ...state, providers: REPORT_PROVIDERS.filter(one => providers.includes(one)) })),
      // Answers at once: a report can take longer than a request may wait.
      startReport: ({ pr }) => {
        void startReport(pr)

        return true
      },
      cancelReport: ({ key }) => cancelReport(key),
      startReview: ({ pr, start }) => {
        void startReview(pr, start)

        return true
      },
      cancelReview: ({ key }) => closeReview(key),
      sendReview: ({ pr, text, refs, triage, prior }) => sendReview(pr, text, refs, triage, prior),
      savedReviews: () => readReviews(),
      saveReview: async ({ key, review }) => {
        await writeReview(key, review)

        return true
      },
      postReview: ({ pr, draft, submit }) => postReview(pr.repo, pr.number, reviewPayload(draft, submit)),
      stopReview: ({ key }) => {
        reviews.get(key)?.stop()

        return true
      },
      startExplain: ({ pr, start }) => {
        void startExplain(pr, start)

        return true
      },
      sendExplain: ({ pr, start }) => sendExplain(pr, start),
      stopExplain: ({ key, findingId }) => {
        explains.get(explainKey(key, findingId))?.stop()

        return true
      },
      reviseFinding: ({ key, findingId, changes }) => {
        reviews.get(key)?.revise(findingId, changes)

        return true
      },
      startAddress: ({ pr }) => {
        void startAddress(pr)

        return true
      },
      cancelAddress: ({ key }) => cancelAddress(key),
      settings: () => settings(),
      saveSettings: ({ values }) => saveSettings(values),
      titleBarDoubleClick: () => titleBarDoubleClick(),
      applyUpdate: async () => {
        isQuitting = true
        await Updater.applyUpdate()

        return true
      },
    },
    messages: {},
  },
})

// Without an Edit menu, macOS gives the webview's text fields no copy, paste or undo shortcuts.
ApplicationMenu.setApplicationMenu([
  {
    submenu: [
      { role: 'about' },
      { type: 'divider' },
      { label: 'Settings…', action: 'settings', accelerator: 'CommandOrControl+,' },
      { type: 'divider' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'showAll' },
      { type: 'divider' },
      { role: 'quit', accelerator: 'CommandOrControl+Q' },
    ],
  },
  {
    label: 'Edit',
    submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'divider' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
  },
  { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { role: 'toggleFullScreen' }] },
])

ApplicationMenu.on('application-menu-clicked', event => {
  if ((event as { data?: { action?: string } }).data?.action === 'settings') {
    window.webview.rpc?.send.openSettings({})
  }
})

const window = new BrowserWindow({
  title: 'Team PRs',
  url: 'views://mainview/index.html',
  rpc,
  frame: await readFrame(),
  // The app draws its own top bar; the window buttons sit inside it.
  titleBarStyle: 'hiddenInset',
  // Centred on the 48px top bar.
  trafficLightOffset: { x: 10, y: 10 },
})

// Reopens at the size and place it was left; a full screen or maximized frame is not one to come back to.
const remember = () => {
  if (!window.isFullScreen() && !window.isMaximized()) {
    writeFrame(window.getFrame())
  }
}
window.on('resize', remember)
window.on('move', remember)

// Quitting (⌘Q or the tray's Quit) closes the window for real; closing it alone may only send the app to the menu bar.
let isQuitting = false
Electrobun.events.on('before-quit', () => {
  isQuitting = true
})

let tray: Tray | null = null

function showTray(isOn: boolean): void {
  if (isOn && !tray) {
    tray = new Tray({ image: 'views://tray.png', template: true, width: 18, height: 18 })
    tray.setMenu([
      { type: 'normal', label: 'Open Team PRs', action: 'open' },
      { type: 'divider' },
      { type: 'normal', label: 'Quit Team PRs', action: 'quit' },
    ])
    tray.on('tray-clicked', event => {
      const action = (event as { data?: { action?: string } }).data?.action
      if (action === 'quit') {
        Utils.quit()
      } else if (action === 'open') {
        openWindow()
      }
    })
  } else if (!isOn && tray) {
    tray.remove()
    tray = null
    // With no tray icon, a hidden window could not be brought back.
    if (!window.isVisible()) {
      openWindow()
    }
  }
}

// In the menu bar the app leaves the Dock and the app switcher, as menu bar apps do.
function openWindow(): void {
  if (process.platform === 'darwin') {
    Utils.setDockIconVisible(true)
  }
  window.show()
  window.activate()
}

// The first close asks whether to keep running, and the answer becomes the setting.
async function closeWindow(): Promise<void> {
  let { keepInTray } = await readDesktopState()
  if (keepInTray === null) {
    const { response } = await Utils.showMessageBox({
      type: 'question',
      message: 'Keep Team PRs running in the menu bar?',
      detail: 'It keeps checking your PRs and notifying you, and opens again from its menu bar icon. You can change this in Settings.',
      buttons: ['Keep Running', 'Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    })
    if (response === 2) {
      return
    }
    keepInTray = response === 0
    window.webview.rpc?.send.repos(await changeRepos(state => ({ ...state, keepInTray })))
    showTray(keepInTray)
  }
  if (!keepInTray) {
    Utils.quit()
    return
  }
  window.hide()
  if (process.platform === 'darwin') {
    Utils.setDockIconVisible(false)
  }
}

window.on('will-close', event => {
  if (!isQuitting) {
    ;(event as { response: { allow: boolean } }).response = { allow: false }
    void closeWindow()
  }
})

showTray((await readDesktopState()).keepInTray === true)

// Same cadence as the TUI; the shared cache keeps the CLI and this app from asking GitHub twice.
const pollMs = (await loadConfig(null)).pollMinutes * 60 * 1000
setInterval(async () => {
  const started = generation
  const snapshot = await load(pollMs)
  if (started === generation) {
    window.webview.rpc?.send.snapshot(snapshot)
  }
}, pollMs)

// Downloads a newer release in the background and offers a restart; dev builds never find one.
async function checkForUpdate(): Promise<void> {
  try {
    if (!(await Updater.checkForUpdate()).updateAvailable) {
      return
    }
    await Updater.downloadUpdate()
    const { updateReady, version } = Updater.updateInfo()
    if (updateReady) {
      window.webview.rpc?.send.updateReady({ version })
    }
  } catch (error) {
    console.error('Update check failed:', error)
  }
}

// Waits for the webview to be listening before the first check.
setTimeout(checkForUpdate, 30 * 1000)
setInterval(checkForUpdate, 4 * 60 * 60 * 1000)
