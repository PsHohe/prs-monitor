type Props = {
  width: number
  min: number
  max: number
  // Which side of the splitter the pane it sizes is on: dragging toward that side shrinks it.
  side: 'left' | 'right'
  label: string
  onWidth: (width: number) => void
}

// A handle between two panes that resizes one of them.
export function Splitter({ width, min, max, side, label, onWidth }: Props) {
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      onPointerDown={event => {
        event.preventDefault()
        const handle = event.currentTarget
        const startX = event.clientX
        const startWidth = width
        handle.setPointerCapture(event.pointerId)
        document.body.classList.add('resizing')
        const move = (moved: PointerEvent) => {
          const dx = moved.clientX - startX
          onWidth(Math.round(Math.max(min, Math.min(max, startWidth + (side === 'left' ? dx : -dx)))))
        }
        const up = () => {
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('pointerup', up)
          document.body.classList.remove('resizing')
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', up)
      }}
    />
  )
}
