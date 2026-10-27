import { useEffect, useRef } from 'react'

import { age, rowKey, staleness } from '../../../src/lib/lib'
import type { PrBucket, PrRow } from '../../../src/types'
import { reasonsOf } from '../shared/attention'
import { Avatar, Chips } from './Chips'

export const SECTIONS: { bucket: PrBucket; title: string; isRich: boolean }[] = [
  { bucket: 'me', title: 'Waiting on me', isRich: true },
  { bucket: 'ready', title: 'Ready to merge', isRich: true },
  { bucket: 'others', title: 'Waiting on others', isRich: false },
]

type Props = {
  rows: PrRow[]
  selectedKey: string | null
  folded: PrBucket[]
  now: number
  // Off while one repo is shown, since every row would say the same.
  showRepo: boolean
  onSelect: (pr: PrRow) => void
  onToggle: (bucket: PrBucket) => void
}

export function List({ rows, selectedKey, folded, now, showRepo, onSelect, onToggle }: Props) {
  return (
    <div className="list" role="listbox">
      {SECTIONS.map(({ bucket, title, isRich }) => {
        const group = rows.filter(pr => pr.bucket === bucket)
        const isFolded = folded.includes(bucket)

        return group.length === 0 ? null : (
          <section key={bucket}>
            <button className={`group ${bucket}`} onClick={() => onToggle(bucket)} aria-expanded={!isFolded}>
              <span className="fold">{isFolded ? '▸' : '▾'}</span>
              {title}
              <span className="count">{group.length}</span>
            </button>
            {!isFolded &&
              group.map(pr => {
                const key = rowKey(pr)
                const Row = isRich ? RichRow : CompactRow

                return <Row key={key} pr={pr} now={now} showRepo={showRepo} isSelected={key === selectedKey} onSelect={() => onSelect(pr)} />
              })}
          </section>
        )
      })}
    </div>
  )
}

type RowProps = { pr: PrRow; now: number; showRepo: boolean; isSelected: boolean; onSelect: () => void }

function useSelectedRef(isSelected: boolean) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (isSelected) {
      ref.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [isSelected])

  return ref
}

// Needs me: who, why in words, and how long it has waited.
function RichRow({ pr, now, showRepo, isSelected, onSelect }: RowProps) {
  const ref = useSelectedRef(isSelected)
  const [reason, ...more] = reasonsOf(pr)
  const waited = pr.bucket === 'me' && pr.lastOtherAt ? age(pr.lastOtherAt, now) : null

  return (
    <button ref={ref} className={`row rich ${isSelected ? 'selected' : ''}`} onClick={onSelect} role="option" aria-selected={isSelected}>
      <Avatar login={pr.author} size={28} />
      <span className="body">
        <span className="line">
          {pr.isNew && <span className="unread" title="New activity" />}
          <span className="title">{pr.title}</span>
          {waited && (
            <span className={`age ${staleness(pr, now) ?? ''}`} title="Waiting on you for">
              {waited}
            </span>
          )}
        </span>
        <span className="meta">
          {showRepo ? `${pr.repo} ` : ''}#{pr.number} · {pr.isMine ? 'you' : pr.author}
        </span>
        {reason && (
          <span className={`reason ${pr.bucket}`}>
            {reason}
            {more.length > 0 && <span className="more"> +{more.length} more</span>}
          </span>
        )}
        <Chips pr={pr} />
      </span>
    </button>
  )
}

// Nothing needed from me: one line to keep an eye on it.
function CompactRow({ pr, showRepo, isSelected, onSelect }: RowProps) {
  const ref = useSelectedRef(isSelected)

  return (
    <button ref={ref} className={`row compact ${isSelected ? 'selected' : ''}`} onClick={onSelect} role="option" aria-selected={isSelected}>
      <span className="line">
        {pr.isNew && <span className="unread" title="New activity" />}
        <span className="title">{pr.title}</span>
        <span className="meta">#{pr.number}</span>
      </span>
      <span className="line">
        <span className="meta title">
          {showRepo ? `${pr.repo} · ` : ''}
          {pr.isMine ? 'you' : pr.author}
        </span>
        <Chips pr={pr} />
      </span>
    </button>
  )
}
