import { useEffect, useRef, useState } from 'react'

import { ago, rowKey } from '../../../src/lib/lib'
import { findingText, isOpenFinding, VERDICTS } from '../../../src/lib/review'
import type { Finding, ReviewDraft, ReviewMessage, ReviewSummary, Triage, Verdict } from '../../../src/lib/review'
import type { PrRow } from '../../../src/types'
import { bun } from './bridge'
import { Dialog } from './Dialog'
import { toHtml } from './markdown'
import { stampOf } from './remote'
import { cancelReview, checkCommits, explain, postDraft, rereview, sendMessage, setTriage, startReview, stopAnswer, toggleSelected, useExplaining, useReview, verdictOf } from './reviews'
import type { Review } from './reviews'

const VERDICT_NAMES: Record<Verdict, string> = { approve: 'Approve', comment: 'Comment', request_changes: 'Request changes' }

// One click messages beside the model's suggestions; refs are the findings they are about (the selected ones, or
// for Verify every open one).
const VERIFY = {
  label: 'Verify',
  title: 'Re-check the selected findings, or all of them',
  text: () => 'Verify these findings against the code: withdraw any that do not hold up, and revise any that are off.',
  refs: (selected: number[], open: number[]) => (selected.length > 0 ? selected : open),
}
const DRAFT = {
  label: 'Draft review',
  title: 'Draft the review for GitHub from the selected findings, or those you kept',
  text: (refs: number[]) => (refs.length > 0 ? 'Draft the review for GitHub with these findings.' : 'Draft the review for GitHub.'),
  refs: (selected: number[]) => selected,
}

// Unsent messages by PR, so switching PRs or tabs does not lose them.
const drafts = new Map<string, string>()

type Props = { pr: PrRow; now: number }

// The AI review: findings as cards I keep or dismiss under the model's verdict, then a conversation that revises them.
export function ReviewPanel({ pr, now }: Props) {
  const review = useReview(pr)
  const explained = useExplaining(pr)
  const [isShowingAside, setIsShowingAside] = useState(false)
  // What Check for new commits found, for the PR and the turn it was about; null while it checks.
  const [checked, setChecked] = useState<{ key: string; turn: number; text: string | null } | null>(null)

  if (!review) {
    return (
      <div className="review">
        <section className="report">
          <div className="report-head">
            <span className="spark">✦</span>
            <b>AI review</b>
            <span className="muted">Reads the PR and its code, and files findings you keep or dismiss</span>
            <span className="spacer" />
            <button onClick={() => startReview(pr)} title="v">
              Start review
            </button>
          </div>
        </section>
      </div>
    )
  }

  const key = rowKey(pr)
  const isReviewing = review.isBusy && review.turn === 0
  // Posting it changes the PR's review state, which is no news about the PR.
  const isStale = review.stamp !== stampOf(pr) && !review.posted
  // New commits since the review looked, which a re-review settles the findings against.
  const hasNewCommits = !!review.commitId && !!pr.headOid && review.commitId !== pr.headOid
  const count = review.findings.length
  const found = `${count} finding${count === 1 ? '' : 's'}`
  // The conversation opens once the review itself is done, whatever it found.
  const canTalk = !isReviewing && (review.turn > 0 || count > 0 || !!review.summary)
  const status = isReviewing
    ? `Reviewing${review.model ? ` · ${review.model}` : '…'}${count ? ` · ${found} so far` : ''}`
    : !canTalk && review.failure
      ? 'Stopped'
      : `${review.model} · ${ago(review.at, now)}`
  const isAside = (finding: Finding) => !isOpenFinding(finding) || review.triage[finding.id]?.state === 'dismissed'
  const open = review.findings.filter(finding => !isAside(finding))
  const aside = review.findings.filter(isAside)
  const kept = open.filter(finding => review.triage[finding.id]?.state === 'kept').length
  const addressed = aside.filter(finding => !!finding.addressed).length

  return (
    <div className="review">
      <section className={`report ${isReviewing ? 'writing' : ''}`} aria-busy={isReviewing}>
        <div className="report-head">
          <span className="spark">✦</span>
          <b>AI review</b>
          <span className="muted">{status}</span>
          <span className="spacer" />
          {isReviewing ? (
            <button className="link" onClick={() => cancelReview(pr)}>
              Cancel
            </button>
          ) : (
            <>
              {canTalk && !review.isBusy && (
                <button
                  className="link"
                  disabled={checked?.key === key && checked.text === null}
                  onClick={() => {
                    setChecked({ key, turn: review.turn, text: null })
                    void checkCommits(pr).then(text => setChecked({ key, turn: review.turn, text }))
                  }}
                  title="Ask GitHub for commits pushed since this review, and re-review them; your triage stays"
                >
                  {checked?.key === key && checked.text === null ? 'Checking…' : 'Check for new commits'}
                </button>
              )}
              <button className="link" onClick={() => startReview(pr)} title="Start over; this clears the conversation and your triage">
                {review.failure && !canTalk ? 'Try again' : 'Review again'}
              </button>
            </>
          )}
        </div>
        {checked?.key === key && checked.turn === review.turn && checked.text && !review.isBusy && <p className="notice muted">{checked.text}</p>}
        {hasNewCommits && !review.isBusy && canTalk ? (
          <div className="actions notice">
            <span className="muted">New commits since this review.</span>
            <button onClick={() => rereview(pr)} title="Check the findings against the new commits and review what changed; your triage stays">
              Re-review
            </button>
          </div>
        ) : (
          isStale && !review.isBusy && <p className="notice muted">The PR changed since this review.</p>
        )}
        {!canTalk && review.failure && <p className="error">{review.failure}</p>}
        {review.hasCode === false && (
          <p className="notice muted">Diff only: add this repo's clone with Add repo… in the repo picker so the review can read its code.</p>
        )}
        {review.summary ? (
          <Summary summary={review.summary} />
        ) : (
          isReviewing && <p className="muted">{count ? 'Still reading; the verdict comes last.' : review.hasCode === null ? 'Getting the PR…' : 'Reading the diff…'}</p>
        )}
        {isReviewing && review.activity && <p className="muted activity">{review.activity}</p>}
        {!isReviewing && !review.failure && count === 0 && <p className="muted">No findings.</p>}
      </section>

      {open.map(finding => (
        <FindingCard key={finding.id} pr={pr} review={review} finding={finding} isExplained={finding.id === explained} />
      ))}

      {count > 0 && (
        <div className="review-foot muted">
          <span>
            {kept} kept · {open.length - kept} to triage
            {addressed > 0 ? ` · ${addressed} addressed` : ''} · {aside.length - addressed} set aside
          </span>
          {aside.length > 0 && (
            <button className="link" onClick={() => setIsShowingAside(is => !is)}>
              {isShowingAside ? 'Hide set aside' : 'Show set aside'}
            </button>
          )}
        </div>
      )}
      {isShowingAside && aside.map(finding => <FindingCard key={finding.id} pr={pr} review={review} finding={finding} isExplained={finding.id === explained} />)}

      {review.messages.length > 0 && <Conversation messages={review.messages} isBusy={review.isBusy} activity={review.activity} />}
      {review.draft && <DraftCard key={review.draft.revision} pr={pr} review={review} draft={review.draft} />}
      {canTalk && <Composer pr={pr} review={review} open={open.map(finding => finding.id)} />}
    </div>
  )
}

function Summary({ summary }: { summary: ReviewSummary }) {
  return (
    <div className="summary">
      <div className="verdict-line">
        <span className={`verdict ${summary.verdict}`}>{VERDICT_NAMES[summary.verdict]}</span>
        <span className="muted">recommended</span>
      </div>
      <p>{summary.overview}</p>
      {summary.risks.length > 0 && (
        <div className="facts">
          <span className="muted">Risk areas</span>
          {summary.risks.map(risk => (
            <span key={risk} className="badge dim">
              {risk}
            </span>
          ))}
        </div>
      )}
      {summary.notChecked.length > 0 && (
        <p className="muted">
          <span>Not checked: </span>
          {summary.notChecked.join(' · ')}
        </p>
      )}
    </div>
  )
}

type CardProps = { pr: PrRow; review: Review; finding: Finding; isExplained: boolean }

export const VERDICT_LABELS = { holds: 'Holds', refined: 'Refined', disputed: 'Disputed' } as const

function FindingCard({ pr, review, finding, isExplained }: CardProps) {
  const [isOpen, setIsOpen] = useState(false)
  const triage: Triage | null = review.triage[finding.id] ?? null
  const isSelected = review.selected.includes(finding.id)
  // What the model's latest answer did to it.
  const latest =
    review.turn > 0 && finding.turn === review.turn
      ? 'New'
      : review.turn > 0 && finding.revisedTurn === review.turn && isOpenFinding(finding)
        ? 'Revised'
        : review.turn > 0 && finding.revisedTurn === review.turn && finding.addressed
          ? 'Addressed'
          : null
  // What its explanation found, until I settle it; then whether I applied its revision.
  const verdict = verdictOf(review, finding.id)

  return (
    <article
      id={`finding-${finding.id}`}
      className={`finding ${finding.severity} ${triage?.state ?? ''} ${isOpenFinding(finding) ? '' : 'withdrawn'} ${isSelected ? 'selected' : ''} ${isExplained ? 'explained' : ''}`}
    >
      <div className="finding-head">
        <input
          type="checkbox"
          checked={isSelected}
          disabled={!isOpenFinding(finding)}
          onChange={() => toggleSelected(pr, finding.id)}
          title="Attach to your next message"
          aria-label={`Attach #${finding.id} to your next message`}
        />
        <FindingTags pr={pr} finding={finding} />
        {latest && <span className="badge fresh">{latest}</span>}
        {verdict?.settled?.state === 'applied' ? (
          <span className="badge dim" title={verdict.note}>
            Revised by Explain
          </span>
        ) : (
          verdict &&
          !verdict.settled && (
            <span className={`verdict ${verdict.verdict}`} title={verdict.note}>
              {VERDICT_LABELS[verdict.verdict]}
            </span>
          )
        )}
        <span className="spacer" />
        <span className="muted confidence">{finding.confidence} confidence</span>
      </div>
      <button className="finding-title" onClick={() => setIsOpen(is => !is)} aria-expanded={isOpen}>
        <span className="chevron">{isOpen ? '▾' : '▸'}</span>
        {finding.title}
      </button>
      {isOpen && <FindingBody finding={finding} />}
      <FindingNotes finding={finding} triage={triage} />
      <div className="actions">
        <TriageActions pr={pr} finding={finding} triage={triage} />
        <span className="spacer" />
        <CopyButton finding={finding} />
        <button
          className={`explain-button ${isExplained ? 'active' : ''}`}
          onClick={() => explain(pr, finding.id)}
          title="Ask the AI to explain this finding, in a side panel"
        >
          ✦ {review.explains[finding.id] ? 'Explanation' : 'Explain'}
        </button>
      </div>
    </article>
  )
}

// Copies the finding as markdown, and says so for a moment.
function CopyButton({ finding }: { finding: Finding }) {
  const [copied, setCopied] = useState<boolean | null>(null)

  useEffect(() => {
    if (copied === null) {
      return
    }
    const timer = setTimeout(() => setCopied(null), 1500)

    return () => clearTimeout(timer)
  }, [copied])

  return (
    <button className="link" onClick={() => void bun.copy({ text: findingText(finding) }).then(setCopied)} title="Copy the finding as markdown">
      {copied === null ? 'Copy' : copied ? '✓ Copied' : 'Could not copy'}
    </button>
  )
}

// The finding's number, severity, category and where it is, which opens it on GitHub.
export function FindingTags({ pr, finding }: { pr: PrRow; finding: Finding }) {
  return (
    <>
      <span className="muted id">#{finding.id}</span>
      <span className={`severity ${finding.severity}`}>{finding.severity}</span>
      <span className="badge dim">{finding.category}</span>
      <button className="link where" onClick={() => void openAt(pr, finding)} title="Open on GitHub">
        {finding.path}
        {finding.line ? `:${finding.line}` : ''}
      </button>
    </>
  )
}

export function FindingBody({ finding }: { finding: Finding }) {
  return (
    <div className="finding-body">
      <div className="md" dangerouslySetInnerHTML={{ __html: toHtml(finding.body) }} />
      {finding.suggestion.trim() && (
        <>
          <div className="label muted">Suggested fix</div>
          <div className="md" dangerouslySetInnerHTML={{ __html: toHtml(finding.suggestion) }} />
        </>
      )}
    </div>
  )
}

// Why it was set aside: withdrawn, addressed, or my reason for dismissing it.
export function FindingNotes({ finding, triage }: { finding: Finding; triage: Triage | null }) {
  return (
    <>
      {finding.withdrawn && <p className="muted reason">Withdrawn by the AI: {finding.withdrawn}</p>}
      {finding.addressed && <p className="success reason">✓ Addressed: {finding.addressed}</p>}
      {triage?.state === 'dismissed' && triage.reason && <p className="muted reason">Dismissed: {triage.reason}</p>}
    </>
  )
}

// Keep or dismiss the finding, with an optional reason the AI reads; or where I stand, to undo.
export function TriageActions({ pr, finding, triage }: { pr: PrRow; finding: Finding; triage: Triage | null }) {
  const [reason, setReason] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (reason !== null) {
      input.current?.focus()
    }
  }, [reason !== null])

  const dismiss = () => {
    setTriage(pr, finding.id, { state: 'dismissed', reason: reason?.trim() ?? '' })
    setReason(null)
  }

  return reason !== null ? (
    <>
      <input
        ref={input}
        className="reason-input"
        value={reason}
        placeholder="Why? (optional, the AI reads it)"
        onChange={event => setReason(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            dismiss()
          } else if (event.key === 'Escape') {
            setReason(null)
          }
        }}
      />
      <button onClick={dismiss}>Dismiss</button>
      <button className="link" onClick={() => setReason(null)}>
        Cancel
      </button>
    </>
  ) : triage ? (
    <>
      <span className={triage.state === 'kept' ? 'success' : 'muted'}>{triage.state === 'kept' ? '✓ Kept' : 'Dismissed'}</span>
      <button className="link" onClick={() => setTriage(pr, finding.id, null)}>
        Undo
      </button>
    </>
  ) : (
    isOpenFinding(finding) && (
      <>
        <button onClick={() => setTriage(pr, finding.id, { state: 'kept', reason: '' })}>Keep</button>
        <button onClick={() => setReason('')}>Dismiss</button>
      </>
    )
  )
}

export function Conversation({ messages, isBusy, activity }: { messages: ReviewMessage[]; isBusy: boolean; activity: string | null }) {
  return (
    <div className="review-chat">
      {messages.map((message, index) =>
        message.role === 'me' ? (
          <div key={index} className="chat-me">
            {message.refs.length > 0 && (
              <div className="refs">
                {message.refs.map(id => (
                  <button key={id} className="ref" onClick={() => reveal(id)}>
                    #{id}
                  </button>
                ))}
              </div>
            )}
            <div>{message.text}</div>
          </div>
        ) : (
          <div key={index} className="chat-ai">
            <span className={`spark ${isBusy && index === messages.length - 1 ? 'busy' : ''}`}>✦</span>
            <div className="chat-body">
              {message.text && <div className="md" dangerouslySetInnerHTML={{ __html: toHtml(message.text) }} />}
              {isBusy && index === messages.length - 1 && (activity || !message.text) && <p className="muted activity">{activity ?? 'Thinking…'}</p>}
              {message.changes.length > 0 && (
                <div className="refs">
                  {message.changes.map(change => {
                    const id = /#(\d+)/.exec(change)?.[1]

                    return id ? (
                      <button key={change} className="ref" onClick={() => reveal(Number(id))}>
                        {change}
                      </button>
                    ) : (
                      <span key={change} className="badge dim">
                        {change}
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        ),
      )}
    </div>
  )
}

type DraftProps = { pr: PrRow; review: Review; draft: ReviewDraft }

// The review for GitHub the model drafted, which I edit and then post: pending to finish on GitHub, or submitted.
function DraftCard({ pr, review, draft }: DraftProps) {
  const [edited, setEdited] = useState(draft)
  const [asking, setAsking] = useState<'pending' | 'submit' | null>(null)
  const [isPosting, setIsPosting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const posted = review.posted?.revision === draft.revision ? review.posted : null
  const inline = edited.comments.filter(comment => comment.isInline).length
  const counted = `${edited.comments.length} comment${edited.comments.length === 1 ? '' : 's'}${edited.comments.length > inline ? ` (${edited.comments.length - inline} in the body)` : ''}`
  const editComment = (index: number, body: string) =>
    setEdited(one => ({ ...one, comments: one.comments.map((comment, at) => (at === index ? { ...comment, body } : comment)) }))
  const post = async (submit: boolean) => {
    setAsking(null)
    setIsPosting(true)
    setFailure(await postDraft(pr, edited, submit))
    setIsPosting(false)
  }

  return (
    <section className="draft">
      <div className="finding-head">
        <b>Review for GitHub</b>
        <span className="muted">
          {draft.revision > 1 ? `draft ${draft.revision} · ` : ''}on {draft.commitId.slice(0, 7)}
        </span>
        <span className="spacer" />
        <select
          value={edited.verdict}
          disabled={!!posted}
          onChange={event => setEdited(one => ({ ...one, verdict: event.target.value as Verdict }))}
          aria-label="Verdict"
        >
          {VERDICTS.map(verdict => (
            <option key={verdict} value={verdict}>
              {VERDICT_NAMES[verdict]}
            </option>
          ))}
        </select>
      </div>
      <textarea value={edited.body} disabled={!!posted} onChange={event => setEdited(one => ({ ...one, body: event.target.value }))} aria-label="Review body" />
      {edited.comments.map((comment, index) => (
        <div key={comment.findingId} className="draft-comment">
          <div className="finding-head">
            <button className="ref" onClick={() => reveal(comment.findingId)}>
              #{comment.findingId}
            </button>
            <span className="muted where">
              {comment.path}
              {comment.line ? `:${comment.line}` : ''}
            </span>
            <span className="badge dim" title={comment.isInline ? 'A comment on the line' : 'The diff does not show this line, so it goes in the body'}>
              {comment.isInline ? 'inline' : 'in body'}
            </span>
            <span className="spacer" />
            {!posted && (
              <button
                className="link"
                onClick={() => setEdited(one => ({ ...one, comments: one.comments.filter((_, at) => at !== index) }))}
                aria-label={`Leave out #${comment.findingId}`}
                title="Leave out"
              >
                ×
              </button>
            )}
          </div>
          <textarea value={comment.body} disabled={!!posted} onChange={event => editComment(index, event.target.value)} aria-label={`Comment for #${comment.findingId}`} />
        </div>
      ))}
      {failure && <p className="error">{failure}</p>}
      {posted ? (
        <div className="actions">
          <span className="success">✓ {posted.text}</span>
          {posted.url && (
            <button className="link" onClick={() => void bun.openUrl({ url: posted.url! })}>
              Open on GitHub
            </button>
          )}
        </div>
      ) : (
        <div className="actions">
          <span className="muted">{counted}</span>
          <span className="spacer" />
          <button disabled={isPosting} onClick={() => setAsking('pending')} title="Only you see it until you submit it on GitHub">
            Create pending review
          </button>
          <button className="primary" disabled={isPosting} onClick={() => setAsking('submit')}>
            {isPosting ? 'Posting…' : `Submit · ${VERDICT_NAMES[edited.verdict]}`}
          </button>
        </div>
      )}
      {asking && (
        <Dialog
          title={asking === 'submit' ? `Submit "${VERDICT_NAMES[edited.verdict]}" on #${pr.number}?` : `Create a pending review on #${pr.number}?`}
          body={
            asking === 'submit'
              ? `It posts now as you, with ${counted}, and notifies the author.`
              : `It holds ${counted} that only you see until you submit it on GitHub. GitHub allows one pending review per PR.`
          }
          confirm={asking === 'submit' ? 'Submit' : 'Create'}
          onConfirm={() => void post(asking === 'submit')}
          onCancel={() => setAsking(null)}
        />
      )}
    </section>
  )
}

type ComposerProps = { pr: PrRow; review: Review; open: number[] }

function Composer({ pr, review, open }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(pr.url) ?? '')
  const attached = review.selected.map(id => review.findings.find(finding => finding.id === id)).filter(finding => !!finding)

  const edit = (value: string) => {
    setText(value)
    drafts.set(pr.url, value)
  }
  const send = () => {
    if (!text.trim() || review.isBusy) {
      return
    }
    void sendMessage(pr, text, review.selected)
    edit('')
  }
  // A suggestion to edit before sending: its text in the box, its findings attached.
  const box = useRef<HTMLTextAreaElement>(null)
  const prefill = (value: string, refs: number[]) => {
    edit(value)
    refs.filter(id => !review.selected.includes(id)).forEach(id => toggleSelected(pr, id))
    box.current?.focus()
  }
  const hasKept = Object.values(review.triage).some(triage => triage.state === 'kept')

  return (
    <div className="review-composer">
      {review.failure && <p className="error">{review.failure}</p>}
      {attached.length > 0 && (
        <div className="refs">
          {attached.map(finding => (
            <span key={finding.id} className="chip-ref" title={finding.title}>
              #{finding.id} {finding.title}
              <button className="link" onClick={() => toggleSelected(pr, finding.id)} aria-label={`Detach #${finding.id}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        value={text}
        placeholder={attached.length > 0 ? 'Ask about the attached findings…' : 'Ask about the review, or tick findings to talk about them…'}
        onChange={event => edit(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && event.metaKey) {
            event.preventDefault()
            send()
          }
        }}
      />
      <div className="actions">
        {[VERIFY, DRAFT].map(quick => (
          <button
            key={quick.label}
            title={quick.title}
            className={quick === DRAFT && hasKept ? 'ready' : undefined}
            disabled={review.isBusy || (quick === VERIFY && open.length === 0)}
            onClick={() => {
              const refs = quick.refs(review.selected, open)
              void sendMessage(pr, quick.text(refs), refs)
            }}
          >
            {quick.label}
          </button>
        ))}
        {review.suggestions.map(suggestion => (
          <button
            key={suggestion.label}
            className="suggestion"
            title={`${suggestion.text}\n\nShift-click to edit it first`}
            disabled={review.isBusy}
            onClick={event => {
              if (event.shiftKey) {
                prefill(suggestion.text, suggestion.refs)
              } else {
                void sendMessage(pr, suggestion.text, suggestion.refs)
              }
            }}
          >
            <span className="spark">✦</span> {suggestion.label}
          </button>
        ))}
        <span className="spacer" />
        {review.isBusy ? (
          <button onClick={() => stopAnswer(pr)}>Stop</button>
        ) : (
          <button className="primary" disabled={!text.trim()} onClick={send} title="⌘↵">
            Send
          </button>
        )}
      </div>
    </div>
  )
}

// Scrolls to a finding's card and flashes it.
function reveal(id: number) {
  const card = document.getElementById(`finding-${id}`)
  if (!card) {
    return
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  card.classList.remove('flash')
  void card.offsetWidth
  card.classList.add('flash')
}

// The PR's changed files on GitHub at the finding's line; GitHub names each file's anchor by the SHA-256 of its path.
async function openAt(pr: PrRow, finding: Finding) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(finding.path))
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  await bun.openUrl({ url: `${pr.url}/files#diff-${hex}${finding.line ? `R${finding.line}` : ''}` })
}
