import type { ReactNode } from 'react'

import { ago } from '../../../src/lib/lib'
import type { Conversation } from '../../../src/lib/lib'
import { Avatar } from './Chips'
import { RichText } from './RichText'

const REVIEW_WORDS: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed',
  DISMISSED: 'reviewed (dismissed)',
}

type Entry = { at: string; key: string; node: ReactNode }

export function Timeline({ conversation, now }: { conversation: Conversation; now: number }) {
  const entries: Entry[] = [
    ...conversation.comments.map((comment, index) => ({
      at: comment.at,
      key: `c${index}`,
      node: <Item author={comment.author} what="commented" at={comment.at} now={now} body={comment.body} />,
    })),
    // A review with no summary only carries its threads, which show on their own.
    ...conversation.reviews
      .filter(review => review.at && (review.body.trim() || review.state !== 'COMMENTED'))
      .map((review, index) => ({
        at: review.at ?? '',
        key: `r${index}`,
        node: (
          <Item
            author={review.author}
            what={REVIEW_WORDS[review.state] ?? review.state.toLowerCase()}
            tone={review.state === 'APPROVED' ? 'success' : review.state === 'CHANGES_REQUESTED' ? 'error' : undefined}
            at={review.at ?? ''}
            now={now}
            body={review.body}
          />
        ),
      })),
    ...conversation.threads.map((thread, index) => {
      const [first, ...replies] = thread.comments
      const where = `${thread.path}${thread.line ? `:${thread.line}` : ''}`

      return {
        at: thread.at,
        key: `t${index}`,
        node: (
          <div className={`thread ${thread.isResolved ? 'resolved' : ''}`}>
            <div className="thread-head">
              <code>{where}</code>
              <span className={`badge ${thread.isResolved ? 'dim' : 'warning'}`}>{thread.isResolved ? 'resolved' : 'unresolved'}</span>
              {thread.isOutdated && <span className="badge dim">outdated</span>}
            </div>
            {first && <Item author={first.author} what="commented" at={first.at} now={now} body={first.body} />}
            {replies.map((reply, at) => (
              <Item key={at} author={reply.author} what="replied" at={reply.at} now={now} body={reply.body} />
            ))}
          </div>
        ),
      }
    }),
  ].sort((a, b) => a.at.localeCompare(b.at))

  return (
    <div className="timeline">
      <Item author={conversation.pr.author} what="opened this PR" at={conversation.createdAt} now={now} body={conversation.body || '_No description._'} />
      {entries.map(entry => (
        <div key={entry.key}>{entry.node}</div>
      ))}
    </div>
  )
}

type ItemProps = { author: string; what: string; at: string; now: number; body: string; tone?: 'success' | 'error' }

export function Item({ author, what, at, now, body, tone }: ItemProps) {
  return (
    <div className="item">
      <div className="item-head">
        <Avatar login={author} />
        <b>{author}</b> <span className={tone ?? 'muted'}>{what}</span>
        <span className="muted" title={new Date(at).toLocaleString()}>
          {ago(at, now)}
        </span>
      </div>
      {body.trim() && <RichText text={body} />}
    </div>
  )
}
