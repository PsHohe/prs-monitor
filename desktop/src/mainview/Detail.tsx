import { useEffect, useState } from 'react'

import { ago, detailOf } from '../../../src/lib/lib'
import { isOpenFinding } from '../../../src/lib/review'
import type { PrRow } from '../../../src/types'
import { reasonsOf } from '../shared/attention'
import { ACTIONS, EXPLAIN } from '../shared/layout'
import { Actions } from './Actions'
import { bun } from './bridge'
import { Avatar, Chips } from './Chips'
import { Timeline } from './Conversation'
import { ExplainPanel } from './Explain'
import { Files } from './Files'
import { useRemote } from './remote'
import { Splitter } from './Splitter'
import { ReportCard } from './Report'
import { startReport, useReport } from './reports'
import { ReviewPanel } from './Review'
import { startReview, useExplaining, useReview } from './reviews'
import { Threads } from './Threads'

type Tab = 'conversation' | 'threads' | 'files' | 'review'

type Props = {
  pr: PrRow
  isGone: boolean
  now: number
  // Off once every AI provider is turned off in Settings.
  isAiOn: boolean
  isAutoReport: boolean
  // The actions panel's width, or null while it is hidden; while a finding's explanation is open, the explanation's.
  actionsWidth: number | null
  actionsMax: number
  onActionsWidth: (width: number) => void
  onExplainWidth: (width: number) => void
  onBack: (() => void) | null
  onChanged: () => void
}

export function Detail({ pr, isGone, now, isAiOn, isAutoReport, actionsWidth, actionsMax, onActionsWidth, onExplainWidth, onBack, onChanged }: Props) {
  const owed = pr.replies?.length ?? 0
  // A PR that waits on my replies opens where I can give them.
  const [tab, setTab] = useState<Tab>(owed > 0 ? 'threads' : 'conversation')
  const [focusSignal, setFocusSignal] = useState(0)
  const conversation = useRemote('conversation', pr, one => bun.conversation({ pr: one }))
  const threads = useRemote('threads', pr, one => bun.threads({ pr: one }), tab === 'threads')
  const diff = useRemote('diff', pr, one => bun.diff({ pr: one }), tab === 'files')
  const shown = tab === 'threads' ? threads : tab === 'files' ? diff : conversation
  const reasons = pr.bucket === 'me' || pr.bucket === 'ready' ? reasonsOf(pr) : []
  const unresolved = threads.data ? threads.data.pages.length : pr.unresolved
  const report = useReport(pr)
  const review = useReview(pr)
  const explained = useExplaining(pr)
  const isExplaining = explained !== null && !!review?.explains[explained]
  const toTriage = review ? review.findings.filter(finding => isOpenFinding(finding) && !review.triage[finding.id]).length : 0

  const reply = () => {
    setTab('threads')
    setFocusSignal(n => n + 1)
  }

  // Opens the review tab, starting a review when there is none yet.
  const openReview = () => {
    setTab('review')
    if (!review) {
      startReview(pr)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) {
        return
      }
      if (event.key === 't') {
        setTab('threads')
      } else if (event.key === 'c') {
        setTab('conversation')
      } else if (event.key === 'f') {
        setTab('files')
      } else if (event.key === 'g' && isAiOn && !(report && !report.isDone)) {
        startReport(pr)
      } else if (event.key === 'v' && isAiOn) {
        openReview()
      } else if (event.key === 'r' && owed > 0) {
        reply()
      } else {
        return
      }
      // A key the page leaves unhandled makes macOS beep; this also keeps the r from landing in the reply box.
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  })

  const info = conversation.data

  // With no room beside the detail, the explanation takes its place until closed.
  if (isExplaining && actionsWidth === null) {
    return (
      <div className="pane detail-pane explain-pane">
        <ExplainPanel pr={pr} findingId={explained} />
      </div>
    )
  }

  return (
    <>
      <div className="pane detail-pane">
        <article className={`detail ${tab === 'files' ? 'wide' : ''}`}>
          {onBack && (
            <button className="back" onClick={onBack}>
              ‹ All PRs
            </button>
          )}
          <header>
            <div className="meta">
              {pr.repo} #{pr.number}
              {pr.isDraft && ' · draft'}
            </div>
            <h1>{pr.title}</h1>
            <div className="meta byline">
              <Avatar login={pr.author} />
              <span>
                <b>{pr.isMine ? 'You' : pr.author}</b> want{pr.isMine ? '' : 's'} to merge <code>{pr.headRef}</code> into <code>{pr.baseRef}</code>
                {info && (
                  <>
                    {' '}
                    · opened {ago(info.createdAt, now)} · <span className="plus">+{info.additions}</span> <span className="minus">−{info.deletions}</span> in{' '}
                    {info.changedFiles} files
                  </>
                )}
              </span>
            </div>
            <Chips pr={pr} />
          </header>

          {isGone && <p className="banner">This PR is no longer in your list (merged, closed or snoozed). Showing it as it was.</p>}

          <section className={`next ${pr.bucket}`}>
            <div>
              <div className="label">{reasons.length > 0 ? (pr.bucket === 'ready' ? 'Ready' : 'Waiting on you') : 'Nothing needed from you'}</div>
              {reasons.length > 0 ? (
                <ul>
                  {reasons.map(reason => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : (
                <p>{detailOf(pr, now)}</p>
              )}
            </div>
            {actionsWidth !== null ? null : owed > 0 ? (
              <>
                <button onClick={() => bun.openUrl({ url: pr.url })} title="o">
                  Open on GitHub
                </button>
                <button className="primary" onClick={reply} title="r">
                  Reply
                </button>
              </>
            ) : (
              <button className="primary" onClick={() => bun.openUrl({ url: pr.url })} title="o">
                Open on GitHub
              </button>
            )}
          </section>

          {isAiOn && <ReportCard pr={pr} now={now} isAuto={isAutoReport} />}

          <div className="tabs" role="tablist">
            <button className={`tab ${tab === 'conversation' ? 'active' : ''}`} onClick={() => setTab('conversation')} title="c" role="tab">
              Conversation
            </button>
            <button className={`tab ${tab === 'threads' ? 'active' : ''}`} onClick={() => setTab('threads')} title="t" role="tab">
              Threads {unresolved ? <span className="count">{unresolved}</span> : null}
            </button>
            <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')} title="f" role="tab">
              Files {info ? <span className="count">{info.changedFiles}</span> : null}
            </button>
            {isAiOn && (
              <button className={`tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')} title="v" role="tab">
                AI review {toTriage ? <span className="count">{toTriage}</span> : null}
              </button>
            )}
            <span className="spacer" />
            {tab === 'review' ? null : shown.isLoading ? (
              <span className="muted">Loading…</span>
            ) : (
              <button className="link" onClick={shown.reload}>
                Reload
              </button>
            )}
          </div>
          {tab !== 'review' && shown.failure && <p className="error">Could not load: {shown.failure}</p>}
          {tab === 'conversation' &&
            (conversation.data ? <Timeline conversation={conversation.data} now={now} /> : !shown.failure && <p className="muted">Loading the conversation…</p>)}
          {tab === 'threads' &&
            (threads.data ? (
              <Threads
                data={threads.data}
                now={now}
                focusSignal={focusSignal}
                onChanged={() => {
                  threads.reload()
                  conversation.reload()
                  onChanged()
                }}
              />
            ) : (
              !shown.failure && <p className="muted">Loading the threads…</p>
            ))}
          {tab === 'files' && (diff.data ? <Files text={diff.data.text} /> : !shown.failure && <p className="muted">Loading the changes…</p>)}
          {tab === 'review' && isAiOn && <ReviewPanel pr={pr} now={now} />}
        </article>
      </div>
      {isExplaining && actionsWidth !== null ? (
        <>
          <Splitter width={actionsWidth} min={EXPLAIN.min} max={actionsMax} side="right" label="Resize the explanation" onWidth={onExplainWidth} />
          <aside className="pane explain-pane" style={{ width: actionsWidth }}>
            <ExplainPanel pr={pr} findingId={explained} />
          </aside>
        </>
      ) : (
        actionsWidth !== null && (
        <>
          <Splitter width={actionsWidth} min={ACTIONS.min} max={actionsMax} side="right" label="Resize the actions" onWidth={onActionsWidth} />
          <aside className="pane actions-pane" style={{ width: actionsWidth }}>
            <Actions pr={pr} isAiOn={isAiOn} onReply={reply} onReview={openReview} />
          </aside>
        </>
        )
      )}
    </>
  )
}
