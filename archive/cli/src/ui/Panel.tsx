import { Box, Text } from 'ink'
import type { ReactNode } from 'react'

type Props = {
  height: number
  title: string
  meta: string
  subtitle: string
  // Shown instead of the body: an error in red, or a dim placeholder while nothing has arrived.
  error?: string
  placeholder?: string
  body: ReactNode[]
  top: number
  room: number
  footer: ReactNode
}

// A full-screen scrollable text panel (report, changes, digest) with the list's footer.
export function Panel({ height, title, meta, subtitle, error, placeholder, body, top, room, footer }: Props) {
  const range = body.length > room ? `lines ${top + 1}-${Math.min(body.length, top + room)} of ${body.length}` : ''

  return (
    <Box flexDirection="column" height={height}>
      <Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold wrap="truncate-end">
            {title}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{meta}</Text>
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">
        {[subtitle, range].filter(Boolean).join(' · ') || ' '}
      </Text>
      <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
        {error ? (
          <Text color="red">{error}</Text>
        ) : placeholder ? (
          <Text dimColor>{placeholder}</Text>
        ) : (
          body.slice(top, top + room).map((line, index) => <Box key={index}>{line}</Box>)
        )}
      </Box>
      {footer}
    </Box>
  )
}
