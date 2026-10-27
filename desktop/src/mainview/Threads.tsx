import { useEffect, useRef, useState } from 'react'

import type { Done } from '../../../src/github'
import type { ThreadDetail } from '../../../src/lib/lib'
import type { ThreadsData } from '../shared/rpc'
import { bun } from './bridge'
import { Item } from './Conversation'
import { Dialog } from './Dialog'

// Unsent replies by thread, so switching PRs or tabs does not lose them.
const drafts = new Map<string, string>()

type Props = {
  data: ThreadsData
  now: number
  // Bumped to put the cursor in the first thread waiting for my reply.
  focusSignal: number
  onChanged: () => void
}

export function Threads({ data, now, focusSignal, onChanged }: Props) {
  const [notice, setNotice] = useState<Done | null>(null)
  const firstOwed = data.pages.find(page => page.isOwed)?.thread.id

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
      {data.pages.map(({ thread, isOwed }) => (
        <ThreadCard
          key={thread.id}
          thread={thread}
          isOwed={isOwed}
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
  thread: ThreadDetail
  isOwed: boolean
  me: string
  now: number
  focusSignal: number
  onDone: (result: Done) => void
}

function ThreadCard({ thread, isOwed, me, now, focusSignal, onDone }: CardProps) {
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
