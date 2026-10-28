import { useEffect, useRef, useState } from 'react'

import type { Done } from '../../../src/github'
import { specText } from '../../../src/lib/address'
import type { ThreadPlan } from '../../../src/lib/address'
import { ago } from '../../../src/lib/lib'
import type { ThreadDetail } from '../../../src/lib/lib'
import type { PrRow } from '../../../src/types'
import type { ThreadsData } from '../shared/rpc'
import { cancelAddress, startAddress, useAddress } from './addresses'
import { bun } from './bridge'
import { Item } from './Conversation'
import { Dialog } from './Dialog'
import { toHtml } from './markdown'
import { stampOf } from './remote'

// Unsent replies by thread, so switching PRs or tabs does not lose them.
const drafts = new Map<string, string>()

type Props = {
  pr: PrRow
  data: ThreadsData
  isAiOn: boolean
  now: number
  // Bumped to put the cursor in the first thread waiting for my reply.
  focusSignal: number
  onChanged: () => void
}

export function Threads({ pr, data, isAiOn, now, focusSignal, onChanged }: Props) {
  const [notice, setNotice] = useState<Done | null>(null)
  const firstOwed = data.pages.find(page => page.isOwed)?.thread.id
  const address = useAddress(pr)
  const planOf = (thread: ThreadDetail) => address?.plans.find(plan => plan.threadId === thread.id) ?? null

  if (data.pages.length === 0) {
    return (
      <div className="timeline">
        {notice && <p className={`notice ${notice.ok ? 'success' : 'error'}`}>{notice.text}</p>}
        <p className="muted">No unresolved threads.</p>
      </div>
    )
  }

  return (
    <div className="timeline">
      {notice && <p className={`notice ${notice.ok ? 'success' : 'error'}`}>{notice.text}</p>}
      {isAiOn && <AddressBar pr={pr} data={data} now={now} />}
      {data.pages.map(({ thread, isOwed }) => (
        <ThreadCard
          key={thread.id}
          pr={pr}
          thread={thread}
          isOwed={isOwed}
          plan={planOf(thread)}
          me={data.me}
          now={now}
          focusSignal={thread.id === firstOwed ? focusSignal : 0}
          onDone={result => {
            setNotice(result)
            if (result.ok) {
              onChanged()
            }
          }}
        />
      ))}
    </div>
  )
}

type CardProps = {
  pr: PrRow
  thread: ThreadDetail
  isOwed: boolean
  // What the AI drafted for it, when it waits on me.
  plan: ThreadPlan | null
  me: string
  now: number
  focusSignal: number
  onDone: (result: Done) => void
}

function ThreadCard({ pr, thread, isOwed, plan, me, now, focusSignal, onDone }: CardProps) {
  const [draft, setDraft] = useState(drafts.get(thread.id) ?? '')
  const [isReplying, setIsReplying] = useState(draft !== '')
  const [busy, setBusy] = useState<'reply' | 'resolve' | null>(null)
  const [isConfirming, setIsConfirming] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (focusSignal > 0 && thread.canReply) {
      setIsReplying(true)
    }
  }, [focusSignal])
  useEffect(() => {
    if (isReplying) {
      box.current?.focus()
    }
  }, [isReplying, focusSignal])

  const write = (text: string) => {
    setDraft(text)
    if (text) {
      drafts.set(thread.id, text)
    } else {
      drafts.delete(thread.id)
    }
  }
  const post = async () => {
    const body = draft.trim()
    if (!body || busy) {
      return
    }
    setBusy('reply')
    const result = await bun.reply({ threadId: thread.id, body }).catch(failed)
    setBusy(null)
    if (result.ok) {
      write('')
      setIsReplying(false)
    }
    onDone(result)
  }
  const resolve = async () => {
    setIsConfirming(false)
    setBusy('resolve')
    const result = await bun.resolve({ threadId: thread.id }).catch(failed)
    setBusy(null)
    onDone(result)
  }

  const starter = thread.comments[0]?.author ?? 'someone'
  const last = thread.comments.at(-1)?.author ?? 'someone'
  const where = `${thread.path}${thread.line ? `:${thread.line}` : ''}`
  const why = !isOwed
    ? `Not waiting on you · last from ${last === me ? 'you' : last}`
    : starter === me
      ? `Waiting on you: ${last} replied to your thread`
      : `Waiting on you: ${last} commented on your PR`

  return (
    <div className={`thread ${isOwed ? 'owed' : ''}`}>
      <div className="thread-head">
        <code>{where}</code>
        {thread.isOutdated && (
          <span className="badge dim" title="The code changed since this comment">
            outdated
          </span>
        )}
        <span className={`why ${isOwed ? 'warning' : 'muted'}`}>{why}</span>
      </div>
      <Hunk text={thread.diffHunk} />
      {thread.comments.map((comment, index) => (
        <Item key={index} author={comment.author} what={index === 0 ? 'commented' : 'replied'} at={comment.at} now={now} body={comment.body} />
      ))}
      {plan && (
        <PlanBox
          pr={pr}
          thread={thread}
          plan={plan}
          onUse={() => {
            write(plan.reply)
            setIsReplying(true)
            box.current?.focus()
          }}
        />
      )}
      {isReplying ? (
        <div className="composer">
          <textarea
            ref={box}
            value={draft}
            placeholder="Reply… (markdown)"
            rows={4}
            disabled={busy === 'reply'}
            onChange={event => write(event.target.value)}
            onKeyDown={event => {
              event.stopPropagation()
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void post()
              } else if (event.key === 'Escape') {
                setIsReplying(false)
              }
            }}
          />
          <div className="actions">
            <span className="muted hint">{draft ? 'Draft kept if you leave · ' : ''}⌘↵ to post · esc to close</span>
            <button onClick={() => setIsReplying(false)}>Cancel</button>
            <button className="primary" onClick={post} disabled={!draft.trim() || !!busy}>
              {busy === 'reply' ? 'Posting…' : 'Reply'}
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          {thread.canReply && (
            <button className={isOwed ? 'primary' : ''} onClick={() => setIsReplying(true)}>
              Reply…
            </button>
          )}
          {thread.canResolve && (
            <button onClick={() => setIsConfirming(true)} disabled={!!busy}>
              {busy === 'resolve' ? 'Resolving…' : 'Resolve'}
            </button>
          )}
          <span className="spacer" />
          {thread.url && <a href={thread.url}>Open on GitHub</a>}
        </div>
      )}
      {isConfirming && (
        <Dialog
          title={`Resolve the thread on ${where}?`}
          body="It is marked resolved on GitHub for everyone."
          confirm="Resolve"
          onConfirm={resolve}
          onCancel={() => setIsConfirming(false)}
        />
      )}
    </div>
  )
}

// Drafts what to do about the threads waiting on me, and says where that stands.
function AddressBar({ pr, data, now }: { pr: PrRow; data: ThreadsData; now: number }) {
  const address = useAddress(pr)
  const owed = data.pages.filter(page => page.isOwed).length
  if (!address) {
    return owed === 0 ? null : (
      <section className="report">
        <div className="report-head">
          <span className="spark">✦</span>
          <b>Draft answers</b>
          <span className="muted">{pr.isMine ? 'For each thread waiting on you: a change spec to hand off, or a reply to post' : 'A reply for each thread waiting on you'}</span>
          <span className="spacer" />
          <button onClick={() => startAddress(pr)} title="a">
            Draft with AI
          </button>
        </div>
      </section>
    )
  }

  // The changes to hand off, in the order the threads show.
  const changes = data.pages
    .map(({ thread }) => ({ thread, plan: address.plans.find(plan => plan.threadId === thread.id) }))
    .filter((item): item is { thread: ThreadDetail; plan: ThreadPlan } => item.plan?.action === 'change')
  const replies = address.plans.filter(plan => plan.action === 'reply').length
  const tally = [changes.length > 0 ? `${changes.length} to change` : '', replies > 0 ? `${replies} to reply` : ''].filter(Boolean).join(' · ')
  const status = address.isBusy
    ? `Drafting${address.model ? ` · ${address.model}` : '…'}${address.count ? ` · ${address.plans.length} of ${address.count}` : ''}`
    : [address.model, ago(address.at, now), tally].filter(Boolean).join(' · ')

  return (
    <section className={`report ${address.isBusy ? 'writing' : ''}`} aria-busy={address.isBusy}>
      <div className="report-head">
        <span className="spark">✦</span>
        <b>Draft answers</b>
        <span className="muted">{status}</span>
        <span className="spacer" />
        {address.isBusy ? (
          <button className="link" onClick={() => cancelAddress(pr)}>
            Cancel
          </button>
        ) : (
          <>
            {changes.length > 1 && <CopyText text={specText(pr, changes)} label={`Copy ${changes.length} specs`} title="Copy every change spec as one document, for a coding agent or a developer" />}
            <button className="link" onClick={() => startAddress(pr)} title="Draft them again from the threads as they are now">
              {address.failure && address.plans.length === 0 ? 'Try again' : 'Draft again'}
            </button>
          </>
        )}
      </div>
      {address.failure && <p className="error">{address.failure}</p>}
      {address.hasCode === false && <p className="notice muted">Diff only: add this repo's clone with Add repo… in the repo picker so the AI can read its code.</p>}
      {!address.isBusy && address.stamp !== stampOf(pr) && <p className="notice muted">The PR changed since these drafts.</p>}
      {address.isBusy && address.activity && <p className="muted activity">{address.activity}</p>}
    </section>
  )
}

// The AI's call on a thread: a change spec to copy, or a reply to start mine from.
function PlanBox({ pr, thread, plan, onUse }: { pr: PrRow; thread: ThreadDetail; plan: ThreadPlan; onUse: () => void }) {
  const [isOpen, setIsOpen] = useState(plan.action === 'reply')
  const text = plan.action === 'change' ? plan.spec : plan.reply

  return (
    <div className={`plan ${plan.action}`}>
      <div className="plan-head">
        <span className="spark">✦</span>
        <b>{plan.action === 'change' ? 'Needs a change' : 'Suggested reply'}</b>
        <span className="spacer" />
        {plan.action === 'change' ? (
          <CopyText text={specText(pr, [{ plan, thread }])} label="Copy spec" title="Copy the change spec, for a coding agent or a developer" />
        ) : (
          <button className="link" onClick={onUse} title="Put it in the reply box to edit and post">
            Use as reply
          </button>
        )}
      </div>
      <p className="plan-summary">{plan.summary}</p>
      {text && (
        <>
          <button className="plan-toggle link" onClick={() => setIsOpen(is => !is)} aria-expanded={isOpen}>
            {isOpen ? '▾' : '▸'} {plan.action === 'change' ? 'Spec' : 'Reply'}
          </button>
          {isOpen && <div className="md" dangerouslySetInnerHTML={{ __html: toHtml(text) }} />}
        </>
      )}
    </div>
  )
}

// Copies the text, and says so for a moment.
function CopyText({ text, label, title }: { text: string; label: string; title: string }) {
  const [copied, setCopied] = useState<boolean | null>(null)

  useEffect(() => {
    if (copied === null) {
      return
    }
    const timer = setTimeout(() => setCopied(null), 1500)

    return () => clearTimeout(timer)
  }, [copied])

  return (
    <button className="link" onClick={() => void bun.copy({ text }).then(setCopied)} title={title}>
      {copied === null ? label : copied ? '✓ Copied' : 'Could not copy'}
    </button>
  )
}

const failed = (err: unknown): Done => ({ ok: false, text: err instanceof Error ? err.message : String(err) })

// The last lines of the code the thread is on, as GitHub shows them above the comment.
function Hunk({ text }: { text: string }) {
  const lines = text.split('\n').slice(1).slice(-8)
  if (lines.length === 0) {
    return null
  }

  return (
    <pre className="hunk">
      {lines.map((line, index) => (
        <div key={index} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}>
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}
