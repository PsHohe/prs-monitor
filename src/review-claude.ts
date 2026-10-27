import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import { CATEGORIES, describeTool, isReadOnlyCommand, SEVERITIES, SUGGESTION_LIMIT, VERDICTS } from './lib/review'
import type { EngineHooks, EngineOptions, ReviewEngine } from './review'

const REVIEW_TOOLS = ['report_finding', 'update_finding', 'withdraw_finding', 'mark_addressed', 'report_summary', 'draft_review', 'suggest_next'].map(name => `mcp__review__${name}`)

const FIELDS = {
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  path: z.string().describe('The file as it appears in the diff'),
  line: z.number().int().nullable().describe('The line in the new version of the file, or null'),
  title: z.string().describe('One short sentence'),
  body: z.string().describe('Why it matters, in markdown'),
  suggestion: z.string().describe('The concrete change, in markdown, or empty'),
  confidence: z.enum(SEVERITIES),
}

// The review through the Agent SDK: one long session that changes the review with tools as it goes, and streams its
// answers. With the checkout, it reads the code like Claude Code would, read-only.
export function openClaude({ config, dir, system }: EngineOptions, hooks: EngineHooks): ReviewEngine {
  const { book } = hooks
  const recorded = (text: string) => ({ content: [{ type: 'text' as const, text }] })
  // Without the book (an explanation), the model only reads and answers.
  const server = book && createSdkMcpServer({
    name: 'review',
    tools: [
      tool('report_finding', 'Report one new review finding, most important first.', FIELDS, async args => recorded(book.report(args))),
      tool(
        'update_finding',
        'Revise a finding: pass its id and only the fields that change.',
        {
          id: z.number().int(),
          severity: FIELDS.severity.optional(),
          category: FIELDS.category.optional(),
          path: FIELDS.path.optional(),
          line: FIELDS.line.optional(),
          title: FIELDS.title.optional(),
          body: FIELDS.body.optional(),
          suggestion: FIELDS.suggestion.optional(),
          confidence: FIELDS.confidence.optional(),
        },
        async ({ id, ...changes }) => recorded(book.revise(id, changes)),
      ),
      tool(
        'withdraw_finding',
        'Take back a finding that does not hold up.',
        { id: z.number().int(), reason: z.string().describe('Why, in one sentence') },
        async ({ id, reason }) => recorded(book.withdraw(id, reason)),
      ),
      tool(
        'mark_addressed',
        'Close a finding that commits since the review fixed.',
        { id: z.number().int(), how: z.string().describe('How the new code addresses it, in one sentence') },
        async ({ id, how }) => recorded(book.address(id, how)),
      ),
      tool(
        'report_summary',
        'Report the overall verdict once every finding is reported; again later only if it changes.',
        {
          verdict: z.enum(VERDICTS),
          overview: z.string().describe('Two or three sentences'),
          risks: z.array(z.string()).describe('The risk areas, a few words each'),
          notChecked: z.array(z.string()).describe('What could not be checked'),
        },
        async args => recorded(book.summarize(args)),
      ),
      tool(
        'draft_review',
        'Draft the review for GitHub, when I ask for it; I check it and post it myself.',
        {
          verdict: z.enum(VERDICTS),
          body: z.string().describe("The review's body, in markdown"),
          comments: z
            .array(z.object({ id: z.number().int().describe('The finding'), body: z.string().describe('The comment to the author, in markdown') }))
            .describe('One per finding to include'),
        },
        async ({ verdict, body, comments }) => recorded(book.draft(verdict, body, comments)),
      ),
      tool(
        'suggest_next',
        `Offer me up to ${SUGGESTION_LIMIT} next steps as buttons, at the end of every turn; they replace the last ones.`,
        {
          suggestions: z
            .array(
              z.object({
                label: z.string().describe('A few words on the button'),
                text: z.string().describe('The message it sends, written as me'),
                refs: z.array(z.number().int()).describe('The findings it is about, or none'),
              }),
            )
            .describe('Most useful first; empty when nothing is worth it'),
        },
        async ({ suggestions }) => recorded(book.suggest(suggestions)),
      ),
    ],
  })

  // My messages, handed to the SDK one at a time as I send them; streaming input also lets SDK tools run.
  const inbox: SDKUserMessage[] = []
  let wake: (() => void) | null = null
  let isClosed = false
  const rouse = () => wake?.()
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = inbox.shift()
      if (next) {
        yield next
      } else if (isClosed) {
        return
      } else {
        await new Promise<void>(resolve => (wake = resolve))
        wake = null
      }
    }
  }

  const abortController = new AbortController()
  let isStopping = false
  const messages = query({
    prompt: prompt(),
    options: {
      model: config.reviewModel,
      effort: config.reviewEffort,
      systemPrompt: system,
      tools: dir ? ['Read', 'Grep', 'Glob', 'Bash'] : [],
      mcpServers: server ? { review: server } : {},
      // With the checkout, canUseTool decides every call, the review's own tools included.
      ...(dir ? { canUseTool: readOnly(dir) } : { allowedTools: server ? REVIEW_TOOLS : [] }),
      // Not even the checkout's own settings: a PR could bring hooks that run on my machine.
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 200,
      includePartialMessages: true,
      cwd: dir ?? tmpdir(),
      pathToClaudeCodeExecutable: Bun.which('claude') ?? undefined,
      abortController,
    },
  })

  void (async () => {
    try {
      for await (const message of messages) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            const activity = block.type === 'tool_use' ? describeTool(block.name, block.input as Record<string, unknown>) : null
            if (activity) {
              hooks.onActivity(activity)
            }
          }
        } else if (message.type === 'stream_event') {
          const event = message.event
          if (event.type === 'content_block_start' && event.content_block.type === 'text') {
            hooks.onText('', true)
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            hooks.onText(event.delta.text, false)
          }
        } else if (message.type === 'result') {
          if (isStopping) {
            isStopping = false
            hooks.onDone(null, true)
          } else if (message.subtype !== 'success' || message.is_error) {
            hooks.onDone(`The model stopped (${message.subtype === 'success' ? message.result : message.subtype})`, false)
          } else {
            hooks.onDone(null, false)
          }
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        hooks.onDone(err instanceof Error ? err.message : String(err), false)
      }
    }
    if (!abortController.signal.aborted) {
      hooks.onEnd()
    }
  })()

  return {
    send: content => {
      inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })
      rouse()
    },
    stop: () => {
      isStopping = true
      void messages.interrupt().catch(() => {})
    },
    close: () => {
      isClosed = true
      rouse()
      abortController.abort()
    },
  }
}

// Lets the model read inside the checkout and run read-only commands there; everything else is refused with why.
function readOnly(dir: string): CanUseTool {
  const isInside = (path: string) => {
    const to = relative(dir, resolve(dir, path))

    return !to.startsWith('..') && !isAbsolute(to)
  }

  return async (name, input) => {
    if (REVIEW_TOOLS.includes(name)) {
      return { behavior: 'allow', updatedInput: input }
    }
    const path = name === 'Read' ? input.file_path : name === 'Grep' || name === 'Glob' ? (input.path ?? dir) : null
    if (typeof path === 'string') {
      return isInside(path) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only files in the PR checkout can be read.' }
    }
    if (name === 'Bash' && typeof input.command === 'string' && isReadOnlyCommand(input.command, dir)) {
      return { behavior: 'allow', updatedInput: input }
    }

    return {
      behavior: 'deny',
      message:
        name === 'Bash'
          ? 'Refused: only read-only commands (git log/show/blame/diff, gh view/list/api GET, cd, ls, cat, grep…), alone, piped or chained, inside the checkout.'
          : `${name} is not available in this review.`,
    }
  }
}
