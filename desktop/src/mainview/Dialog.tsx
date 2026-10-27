import { useEffect, useRef } from 'react'

type Props = { title: string; body?: string; confirm: string; onConfirm: () => void; onCancel: () => void }

// Asks before anything that changes GitHub. ⏎ confirms and esc cancels; keys go no further.
export function Dialog({ title, body, confirm, onConfirm, onCancel }: Props) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => button.current?.focus(), [])

  return (
    <div
      className="overlay"
      onClick={onCancel}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          onCancel()
        }
      }}
    >
      <div className="dialog" role="alertdialog" aria-label={title} onClick={event => event.stopPropagation()}>
        <h2>{title}</h2>
        {body && <p>{body}</p>}
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button ref={button} className="primary" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
