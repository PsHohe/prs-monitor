import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { createRoot } from 'react-dom/client'

import { ago, rowKey } from '../../../src/lib/lib'
import type { Snapshot } from '../../../src/monitor'
import type { PrBucket, PrRow } from '../../../src/types'
import { bun, pushed } from './bridge'
import { Detail } from './Detail'
import { SettingsSheet } from './Settings'
import { List, SECTIONS } from './List'
import { RepoPicker } from './RepoPicker'
import { useExplaining } from './reviews'
import { Splitter } from './Splitter'
import { fitLayout, LIST } from '../shared/layout'
import type { Layout } from '../shared/layout'
import type { DesktopState } from '../shared/repos'

// Per-window conveniences; the app works the same when storage is unavailable.
function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)

    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)

    return () => clearInterval(timer)
  }, [everyMs])

  return now
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)

    return () => window.removeEventListener('resize', onResize)
  }, [])

  return width
}

// A press on the top bar, outside its buttons: a second one in a row does what the OS does on a title bar.
function onBarMouseDown(event: MouseEvent) {
  if (event.detail === 2 && !(event.target as Element).closest('button')) {
    void bun.titleBarDoubleClick({})
  }
}

// Turns gh's failures into what to do about them.
function problemOf(error: string): { title: string; hint: string } {
  if (/not found in \$PATH|ENOENT|executable/i.test(error)) {
    return { title: 'GitHub CLI not found', hint: 'Install gh from cli.github.com, then retry.' }
  }
  if (/gh auth login|not logged|authenticat/i.test(error)) {
    return { title: 'Not signed in to GitHub', hint: 'Run `gh auth login` in a terminal, then retry.' }
  }

  return { title: 'Could not load your PRs', hint: error }
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [repos, setRepos] = useState<DesktopState>({ repos: [], active: null, autoReport: false, providers: [], keepInTray: null })
  const [repoFailure, setRepoFailure] = useState<string | null>(null)
  // A newer version downloaded by the main process, applied on restart.
  const [update, setUpdate] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [folded, setFolded] = useState<PrBucket[]>(() => stored('folded', []))
  const [layout, setLayout] = useState<Layout>(() => ({ listWidth: 360, actionsWidth: 260, explainWidth: 440, isListOpen: true, isActionsOpen: true, ...stored('layout', {}) }))
  // The last version of the selected PR, kept so it stays on screen if it leaves the list.
  const lastSelected = useRef<PrRow | null>(null)
  const now = useNow(30 * 1000)
  const windowWidth = useWindowWidth()
  // Matches the CSS breakpoint where one pane shows at a time.
  const isNarrow = windowWidth <= 720

  // Only the latest request's answer is shown, so switching repos mid-refresh never shows the old one.
  const loads = useRef(0)
  const load = async (force: boolean) => {
    const at = ++loads.current
    setIsLoading(true)
    try {
      const next = await bun.refresh({ force })
      if (at === loads.current) {
        setSnapshot(next)
        setFailure(null)
      }
    } catch (err) {
      if (at === loads.current) {
        setFailure(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (at === loads.current) {
        setIsLoading(false)
      }
    }
  }
  useEffect(() => {
    pushed.onSnapshot = setSnapshot
    pushed.onOpenSettings = () => setIsSettingsOpen(true)
    pushed.onRepos = setRepos
    pushed.onUpdateReady = setUpdate
    void bun.repos({}).then(setRepos)
    void load(false)
  }, [])

  const rows = snapshot?.rows ?? []
  // How many PRs each repo had when last shown, for the picker.
  useEffect(() => {
    if (!snapshot) {
      return
    }
    const byRepo: Record<string, number> = {}
    for (const pr of rows) {
      byRepo[pr.repo] = (byRepo[pr.repo] ?? 0) + 1
    }
    setCounts(before => (repos.active ? { ...before, [repos.active]: rows.length } : { ...Object.fromEntries(repos.repos.map(one => [one.repo, 0])), ...byRepo }))
  }, [snapshot])
  // In the order shown, skipping folded groups, for the keyboard.
  const visible = SECTIONS.flatMap(({ bucket }) => (folded.includes(bucket) ? [] : rows.filter(pr => pr.bucket === bucket)))
  const found = rows.find(pr => rowKey(pr) === selectedKey) ?? null
  if (found) {
    lastSelected.current = found
  }
  const kept = lastSelected.current
  const selected = found ?? (kept && rowKey(kept) === selectedKey ? kept : null)
  // The finding explained beside the selected PR, which takes the actions' place.
  const explained = useExplaining(selected)

  // On a wide window the detail pane is never empty while there is something to show.
  useEffect(() => {
    if (!isNarrow && !selectedKey && visible[0]) {
      setSelectedKey(rowKey(visible[0]))
    }
  }, [isNarrow, selectedKey, visible[0]])

  const select = (pr: PrRow) => {
    setSelectedKey(rowKey(pr))
    setIsDetailOpen(true)
  }
  const showRepos = (next: DesktopState) => {
    const isSwitch = next.active !== repos.active
    setRepos(next)
    setRepoFailure(null)
    if (isSwitch) {
      setSnapshot(null)
      setSelectedKey(null)
      void load(false)
    }
  }
  const pickRepo = async (repo: string | null) => showRepos(await bun.setActive({ repo }))
  const addRepo = async () => {
    const result = await bun.addRepo({}).catch((err: unknown) => ({ failure: err instanceof Error ? err.message : String(err) }))
    if (result && 'failure' in result) {
      setRepoFailure(result.failure)
    } else if (result) {
      showRepos(result)
    }
  }
  const removeRepo = async (repo: string) => showRepos(await bun.removeRepo({ repo }))
  // Functional, since a splitter keeps calling the one it was given when the drag started.
  const changeLayout = (change: Partial<typeof layout>) =>
    setLayout(before => {
      const next = { ...before, ...change }
      store('layout', next)

      return next
    })
  const toggle = (bucket: PrBucket) => {
    const next = folded.includes(bucket) ? folded.filter(one => one !== bucket) : [...folded, bucket]
    setFolded(next)
    store('folded', next)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The app menu has this shortcut too; this catches it where the menu does not.
      if (event.key === ',' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setIsSettingsOpen(true)

        return
      }
      const isTyping = event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if (isTyping || event.metaKey || event.ctrlKey) {
        return
      }
      const at = visible.findIndex(pr => rowKey(pr) === selectedKey)
      const step = (by: number) => {
        const next = visible[Math.max(0, Math.min(visible.length - 1, at + by))]
        if (next) {
          setSelectedKey(rowKey(next))
        }
        event.preventDefault()
      }
      if (event.key === 'ArrowDown' || event.key === 'j') {
        step(1)
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        step(-1)
      } else if (event.key === 'Enter' && selected) {
        setIsDetailOpen(true)
      } else if (event.key === 'Escape') {
        setIsDetailOpen(false)
      } else if (event.key === 'o' && selected) {
        void bun.openUrl({ url: selected.url })
      } else if (event.key === 'u' && !isLoading) {
        void load(true)
      } else if (event.key === '[' && !isNarrow) {
        changeLayout({ isListOpen: !layout.isListOpen })
      } else if (event.key === ']' && !isNarrow) {
        changeLayout({ isActionsOpen: fitted.actions === null })
      } else {
        return
      }
      // A key the page leaves unhandled makes macOS beep.
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  })

  const error = failure ?? snapshot?.error ?? null
  const problem = error ? problemOf(error) : null
  const showsDetail = !!selected && (!isNarrow || isDetailOpen)
  const fitted = fitLayout(windowWidth, layout, explained !== null)
  const showsList = isNarrow ? !showsDetail : fitted.list !== null

  const checked = snapshot?.checkedAt ? ago(new Date(snapshot.checkedAt).toISOString(), now) : ''
  const listPane = (
    <aside className="pane list-pane" style={isNarrow ? undefined : { width: fitted.list ?? undefined }}>
      <header className="toolbar electrobun-webkit-app-region-drag" onMouseDown={onBarMouseDown}>
        <h1>Team PRs</h1>
        <span className="muted status" title={checked ? `Checked ${checked}` : undefined}>
          {isLoading ? 'Checking…' : checked}
        </span>
        <button className="icon" onClick={() => load(true)} disabled={isLoading} title="Refresh (u)">
          ↻
        </button>
      </header>
      <RepoPicker state={repos} counts={counts} isBusy={false} onPick={pickRepo} onAdd={addRepo} onRemove={removeRepo} />
      {repoFailure && (
        <p className="banner error">
          {repoFailure}{' '}
          <button className="link" onClick={() => setRepoFailure(null)}>
            Dismiss
          </button>
        </p>
      )}
      {update && (
        <p className="banner">
          Version {update} is ready.{' '}
          <button className="link" onClick={() => void bun.applyUpdate({})}>
            Restart to update
          </button>
        </p>
      )}
      {snapshot?.pausedUntil && <p className="banner">Paused by the GitHub rate limit; showing the last result.</p>}
      {problem && rows.length > 0 && <p className="banner error" title={error ?? ''}>{problem.title}. Showing the last result.</p>}
      {rows.length > 0 ? (
        <List rows={rows} selectedKey={selected ? rowKey(selected) : null} folded={folded} now={now} showRepo={!repos.active} onSelect={select} onToggle={toggle} />
      ) : problem ? (
        <div className="empty">
          <h2>{problem.title}</h2>
          <p>{problem.hint}</p>
          <button onClick={() => load(true)} disabled={isLoading}>
            Retry
          </button>
        </div>
      ) : snapshot ? (
        <div className="empty">
          <h2>All clear</h2>
          <p>{repos.active ? `No open PRs in ${repos.active} involve you.` : 'No open PRs involve you.'}</p>
        </div>
      ) : (
        <div className="empty">
          <p className="muted">Loading your pull requests…</p>
        </div>
      )}
      <footer className="list-footer">
        <button className="icon" onClick={() => setIsSettingsOpen(true)} title="Settings (⌘,)" aria-label="Settings">
          ⚙
        </button>
      </footer>
    </aside>
  )
  const detailPane = (
    <main className="main">
      <header className={`topbar electrobun-webkit-app-region-drag ${showsList ? '' : 'inset'}`} onMouseDown={onBarMouseDown}>
        {!isNarrow && (
          <button
            className={`icon ${layout.isListOpen ? 'active' : ''}`}
            onClick={() => changeLayout({ isListOpen: !layout.isListOpen })}
            title={`${layout.isListOpen ? 'Hide' : 'Show'} the list ([)`}
            aria-label="Toggle the list"
          >
            <PanelIcon side="left" />
          </button>
        )}
        {selected && (
          <span className="crumbs">
            <span className="muted">{selected.repo}</span>
            <span className="muted">/</span>
            <span className="title">
              #{selected.number} {selected.title}
            </span>
          </span>
        )}
        <span className="spacer" />
        {!isNarrow && (
          <button
            className={`icon ${fitted.actions !== null ? 'active' : ''}`}
            onClick={() => changeLayout({ isActionsOpen: fitted.actions === null })}
            title={`${fitted.actions !== null ? 'Hide' : 'Show'} the actions (])`}
            aria-label="Toggle the actions"
          >
            <PanelIcon side="right" />
          </button>
        )}
      </header>
      <div className="main-body">
        {selected ? (
          <Detail
            key={rowKey(selected)}
            pr={selected}
            isGone={!found}
            now={now}
            isAiOn={repos.providers.length > 0}
            isAutoReport={repos.autoReport}
            actionsWidth={isNarrow ? null : fitted.actions}
            actionsMax={fitted.actionsMax}
            onActionsWidth={actionsWidth => changeLayout({ actionsWidth })}
            onExplainWidth={explainWidth => changeLayout({ explainWidth })}
            onBack={isNarrow ? () => setIsDetailOpen(false) : null}
            onChanged={() => load(true)}
          />
        ) : (
          <div className="empty">
            <p className="muted">Select a PR</p>
          </div>
        )}
      </div>
    </main>
  )

  return (
    <div className="app">
      {showsList && listPane}
      {showsList && !isNarrow && (
        <Splitter width={fitted.list ?? LIST.min} min={LIST.min} max={fitted.listMax} side="left" label="Resize the list" onWidth={listWidth => changeLayout({ listWidth })} />
      )}
      {(!isNarrow || showsDetail) && detailPane}
      {isSettingsOpen && (
        <SettingsSheet
          providers={repos.providers}
          isAutoReport={repos.autoReport}
          onProviders={async providers => setRepos(await bun.setProviders({ providers }))}
          onAutoReport={async isOn => setRepos(await bun.setAutoReport({ isOn }))}
          isKeepInTray={repos.keepInTray === true}
          onKeepInTray={async isOn => setRepos(await bun.setKeepInTray({ isOn }))}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </div>
  )
}

// A window with its left or right panel filled in.
function PanelIcon({ side }: { side: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <line x1={side === 'left' ? 6 : 10} y1="2.5" x2={side === 'left' ? 6 : 10} y2="13.5" />
    </svg>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
