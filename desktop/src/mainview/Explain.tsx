import { useEffect, useRef, useState } from 'react'

import type { PrRow } from '../../../src/types'
import { Conversation, FindingBody, FindingNotes, FindingTags, TriageActions } from './Review'
import { askExplain, closeExplain, restartExplain, stopExplain, useReview } from './reviews'

// Unsent questions by PR and finding, so switching PRs or findings does not lose them.
const drafts = new Map<string, string>()

type Props = { pr: PrRow; findingId: number }

// A side conversation that explains one finding, to know more before I keep or dismiss it. It reads the code like
// the review does, but only I change the review.
export function ExplainPanel({ pr, findingId }: Props) {
  const review = useReview(pr)
  const finding = review?.findings.find(one => one.id === findingId)
  const thread = review?.explains[findingId]
  const draftKey = `${pr.url}#${findingId}`
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '')
  const [isShowingFinding, setIsShowingFinding] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const last = thread?.messages.at(-1)

  // Follows the answer as it streams in.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [thread?.messages.length, last?.text.length, thread?.activity])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !(event.target instanceof HTMLInputElement)) {
        closeExplain(pr)
      }
    }
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  })

  if (!review || !finding || !thread) {
    return null
  }

  const edit = (value: string) => {
    setText(value)
    drafts.set(draftKey, value)
  }
  const send = () => {
    if (!text.trim() || thread.isBusy) {
      return
    }
    void askExplain(pr, findingId, text)
    edit('')
  }
  // An answer that failed before it said anything shows only as the failure.
  const said = thread.messages.filter((message, index) => message.text.trim() || message.changes.length > 0 || (thread.isBusy && index === thread.messages.length - 1))
  // Nothing was said before it failed: start over rather than ask into the void.
  const hasNothing = !thread.isBusy && !thread.messages.some(message => message.text.trim())

  return (
    <div className="explain">
      <div className="explain-head">
        <span className={`spark ${thread.isBusy ? 'busy' : ''}`}>✦</span>
        <b>Explain #{finding.id}</b>
        <span className="muted model">{thread.model}</span>
        <span className="spacer" />
        {!thread.isBusy && !hasNothing && (
          <button className="link" onClick={() => restartExplain(pr, findingId)} title="Forget this conversation and explain it again">
            Start over
          </button>
        )}
        <button className="link close" onClick={() => closeExplain(pr)} aria-label="Close the explanation" title="Close (esc)">
          ×
        </button>
      </div>

      <div className="explain-scroll">
        <section className={`finding ${finding.severity} ${review.triage[finding.id]?.state ?? ''}`}>
          <div className="finding-head">
            <FindingTags pr={pr} finding={finding} />
          </div>
          <button className="finding-title" onClick={() => setIsShowingFinding(is => !is)} aria-expanded={isShowingFinding}>
            <span className="chevron">{isShowingFinding ? '▾' : '▸'}</span>
            {finding.title}
          </button>
          {isShowingFinding && <FindingBody finding={finding} />}
          <FindingNotes finding={finding} triage={review.triage[finding.id] ?? null} />
          <div className="actions">
            <TriageActions pr={pr} finding={finding} triage={review.triage[finding.id] ?? null} />
          </div>
        </section>

        {thread.hasCode === false && <p className="notice muted">Diff only: add this repo's clone with Add repo… so it can read the code.</p>}
        <Conversation messages={said} isBusy={thread.isBusy} activity={thread.activity ?? (thread.hasCode === null && thread.isBusy ? 'Getting the PR…' : null)} />
        {thread.failure && (
          <div className="actions">
            <p className="error">{thread.failure}</p>
            {hasNothing && <button onClick={() => restartExplain(pr, findingId)}>Try again</button>}
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="review-composer">
        <textarea
          value={text}
          placeholder="Ask more about this finding…"
          onChange={event => edit(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && event.metaKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className="actions">
          <span className="muted">It reads the code; you decide.</span>
          <span className="spacer" />
          {thread.isBusy ? (
            <button onClick={() => stopExplain(pr, findingId)}>Stop</button>
          ) : (
            <button className="primary" disabled={!text.trim() || hasNothing} onClick={send} title="⌘↵">
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
