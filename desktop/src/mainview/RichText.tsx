import { useEffect, useMemo, useRef, useState } from 'react'

import { bun } from './bridge'
import { toHtml } from './markdown'

// Fetched images by URL, kept while the app runs so switching PRs does not fetch them again.
const images = new Map<string, Promise<string | null>>()

function load(url: string): Promise<string | null> {
  let image = images.get(url)
  if (!image) {
    image = bun.image({ url }).then(result => ('dataUrl' in result ? result.dataUrl : null))
    images.set(url, image)
  }

  return image
}

// Sanitized markdown whose GitHub images show as previews; a click shows one full size.
export function RichText({ text }: { text: string }) {
  const html = useMemo(() => toHtml(text), [text])
  const ref = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.querySelectorAll<HTMLImageElement>('img[data-src]').forEach(img => {
      const url = img.dataset.src!
      img.classList.add('md-image', 'loading')
      void load(url).then(dataUrl => {
        img.classList.remove('loading')
        if (dataUrl) {
          img.src = dataUrl
        } else {
          img.classList.add('failed')
          img.title = 'Could not load the image; click to open it on GitHub'
        }
      })
    })
  }, [html])

  return (
    <>
      <div
        ref={ref}
        className="md"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={event => {
          const img = event.target instanceof HTMLImageElement && event.target.dataset.src ? event.target : null
          if (!img) {
            return
          }
          // Not the link GitHub may wrap it in; a failed one opens on GitHub, where the browser is logged in.
          event.preventDefault()
          event.stopPropagation()
          if (img.classList.contains('failed')) {
            void bun.openUrl({ url: img.dataset.src! })
          } else if (img.src) {
            setFull(img.src)
          }
        }}
      />
      {full && <Lightbox src={full} onClose={() => setFull(null)} />}
    </>
  )
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [])

  return (
    <div
      ref={ref}
      className="overlay lightbox"
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          onClose()
        }
      }}
    >
      <img src={src} alt="" />
    </div>
  )
}
