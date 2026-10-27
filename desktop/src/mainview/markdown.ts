import DOMPurify from 'dompurify'
import { marked } from 'marked'

import { isGithubImage } from '../shared/image'

// Images uploaded to GitHub keep their place with no src: the main process fetches them with my token, which private
// repos' images need (see RichText). Others become links, since loading them would tell third-party hosts when the PR
// was viewed.
DOMPurify.addHook('afterSanitizeElements', node => {
  if (node instanceof HTMLImageElement && isGithubImage(node.src)) {
    node.dataset.src = node.src
    node.removeAttribute('src')
  } else if (node instanceof HTMLImageElement) {
    const link = document.createElement('a')
    link.href = node.src
    link.textContent = `🖼 ${node.alt || 'image'}`
    node.replaceWith(link)
  }
})

// PR bodies and comments are written by other people, so only sanitized HTML reaches the page.
export function toHtml(markdown: string): string {
  const text = markdown.replace(/<!--[\s\S]*?-->/g, '').trim()
  const html = marked.parse(text, { gfm: true, breaks: true, async: false })

  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] })
}
