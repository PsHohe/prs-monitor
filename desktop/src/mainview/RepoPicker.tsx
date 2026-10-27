import { useEffect, useRef, useState } from 'react'

import type { DesktopState } from '../shared/repos'

type Props = {
  state: DesktopState
  // PRs per repo in the last result, shown beside each name when known.
  counts: Record<string, number>
  isBusy: boolean
  onPick: (repo: string | null) => void
  onAdd: () => void
  onRemove: (repo: string) => void
}

export function RepoPicker({ state, counts, isBusy, onPick, onAdd, onRemove }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // Closes on a click anywhere else.
  useEffect(() => {
    if (!isOpen) {
      return
    }
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)

    return () => document.removeEventListener('mousedown', onDown)
  }, [isOpen])

  const pick = (repo: string | null) => {
    setIsOpen(false)
    if (repo !== state.active) {
      onPick(repo)
    }
  }

  return (
    <div
      className="picker"
      ref={root}
      onKeyDown={event => {
        if (event.key === 'Escape' && isOpen) {
          event.stopPropagation()
          setIsOpen(false)
        }
      }}
    >
      <button className="picker-button" onClick={() => setIsOpen(!isOpen)} aria-expanded={isOpen} disabled={isBusy}>
        <span className="title">{state.active ?? 'All repos'}</span>
        <span className="muted">▾</span>
      </button>
      {isOpen && (
        <div className="menu" role="menu">
          <button className={`menu-item ${state.active === null ? 'checked' : ''}`} onClick={() => pick(null)} role="menuitemradio">
            <span className="check">{state.active === null ? '✓' : ''}</span>
            <span className="title">All repos</span>
            <span className="muted">involving you</span>
          </button>
          {state.repos.map(({ repo, root: folder }) => (
            <div key={repo} className={`menu-item ${state.active === repo ? 'checked' : ''}`} title={folder}>
              <button className="pick" onClick={() => pick(repo)} role="menuitemradio">
                <span className="check">{state.active === repo ? '✓' : ''}</span>
                <span className="title">{repo}</span>
                {counts[repo] !== undefined && <span className="muted">{counts[repo]}</span>}
              </button>
              <button className="remove" onClick={() => onRemove(repo)} title={`Remove ${repo} from the list`} aria-label={`Remove ${repo}`}>
                ×
              </button>
            </div>
          ))}
          <div className="divider" />
          <button
            className="menu-item"
            onClick={() => {
              setIsOpen(false)
              onAdd()
            }}
            role="menuitem"
          >
            <span className="check">+</span>
            <span className="title">Add repo…</span>
            <span className="muted">pick a local clone</span>
          </button>
        </div>
      )}
    </div>
  )
}
