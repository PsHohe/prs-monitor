import { Text } from 'ink'
import type { ReactNode } from 'react'

type Segment = { text: string; isBold: boolean; isCode: boolean }

// Splits one markdown line into **bold** and `code` runs; `isBold` carries a bold run across lines.
function segments(line: string, state: { isBold: boolean }): Segment[] {
  const out: Segment[] = []
  const heading = /^(\s*)#{1,6}\s+(.*)$/.exec(line)
  if (heading) {
    return [{ text: `${heading[1] ?? ''}${heading[2] ?? ''}`, isBold: true, isCode: false }]
  }
  // Links show their text; the terminal cannot open them anyway.
  const plain = line.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
  for (const part of plain.split(/(\*\*|`[^`]*`)/)) {
    if (part === '**') {
      state.isBold = !state.isBold
    } else if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      out.push({ text: part.slice(1, -1), isBold: state.isBold, isCode: true })
    } else if (part) {
      out.push({ text: part, isBold: state.isBold, isCode: false })
    }
  }

  return out
}

// Word-wraps segments to `width` columns, indenting continuation lines like the first (and past a list bullet).
function wrap(parts: Segment[], width: number): Segment[][] {
  const lines: Segment[][] = [[]]
  const indent = /^(\s*(?:(?:[-*]|\d+\.)\s+)?)/.exec(parts[0]?.text ?? '')?.[1]?.length ?? 0
  let used = 0
  for (const part of parts) {
    for (const word of part.text.split(/(\s+)/)) {
      if (!word) {
        continue
      }
      const isSpace = /^\s+$/.test(word)
      if (used + word.length > width && used > indent) {
        if (isSpace) {
          continue
        }
        lines.push([{ text: ' '.repeat(indent), isBold: false, isCode: false }])
        used = indent
      }
      lines.at(-1)?.push({ ...part, text: word })
      used += word.length
    }
  }

  return lines
}

// A line inside a ``` fence, as is and cut at the edge; diffs and suggestions in color.
function codeLine(line: string, lang: string): ReactNode {
  const code = line.trimStart()
  const color = lang === 'suggestion' ? 'green' : lang === 'diff' && code.startsWith('+') ? 'green' : lang === 'diff' && code.startsWith('-') ? 'red' : undefined

  return (
    <Text color={color} dimColor={!color} wrap="truncate-end">
      {line.replace(/\t/g, '    ') || ' '}
    </Text>
  )
}

// The markdown as terminal lines of at most `width` columns, one node per line.
export function markdownLines(markdown: string, width: number): ReactNode[] {
  const state = { isBold: false }
  // The open fence's language, or null outside a fence.
  let fence: string | null = null

  return markdown.split('\n').flatMap((line): ReactNode[] => {
    const marker = /^\s*```\s*(\S*)/.exec(line)
    if (marker) {
      fence = fence === null ? (marker[1] ?? '') : null

      return []
    }
    if (fence !== null) {
      return [codeLine(line, fence)]
    }

    return wrap(segments(line, state), Math.max(20, width)).map((parts, index) => (
      <Text key={index}>
        {parts.length === 0
          ? ' '
          : parts.map((part, at) => (
              <Text key={at} bold={part.isBold} color={part.isCode ? 'cyan' : undefined}>
                {part.text}
              </Text>
            ))}
      </Text>
    ))
  })
}
