import { tmpdir } from 'node:os'

import { query } from '@anthropic-ai/claude-agent-sdk'

import type { PrRow } from './types'
import { localOffset } from './actions'
import { gh } from './github'
import type { RunResult } from './github'
import { DIGEST_SYSTEM, digestPrompt, REPORT_SYSTEM, reportPrompt } from './lib/lib'
import type { Config, ReportData, ReportDismissal } from './lib/lib'

const REPORT_FIELDS =
  'number,title,state,isDraft,author,headRefName,baseRefName,reviewDecision,mergeable,mergeStateStatus,additions,deletions,changedFiles,statusCheckRollup,reviews,comments,commits'

export type ReportResult = { text: string } | { failure: string }

// A quick status report of one PR, streamed through `onText` as the model writes it.
export async function quickReport(
  repo: string,
  number: number,
  config: Config,
  { onText, signal }: { onText?: (soFar: string) => void; signal?: AbortSignal } = {},
): Promise<ReportResult> {
  const [viewed, inline, dismissed] = await Promise.all([
    gh(['pr', 'view', String(number), '--repo', repo, '--json', REPORT_FIELDS]),
    gh([
      'api',
      `repos/${repo}/pulls/${number}/comments`,
      '--paginate',
      '--jq',
      '.[] | {user: .user.login, path, line, body, created_at}',
    ]),
    gh([
      'api',
      `repos/${repo}/issues/${number}/timeline`,
      '--paginate',
      '--jq',
      '.[] | select(.event == "review_dismissed") | {at: .created_at, actor: .actor.login, message: .dismissed_review.dismissal_message, commit: .dismissed_review.dismissal_commit_id}',
    ]),
  ])
  if (viewed.exitCode !== 0) {
    return { failure: viewed.stderr.trim() || 'gh pr view failed' }
  }
  const data: ReportData = {
    pr: JSON.parse(viewed.stdout) as Record<string, unknown>,
    inline: jsonLines<ReportData['inline'][number]>(inline),
    dismissals: jsonLines<ReportDismissal>(dismissed),
    now: Date.now(),
    offsetMinutes: localOffset(),
  }

  return complete(reportPrompt(data, config), REPORT_SYSTEM, config, { onText, signal })
}

// What to do first across the given PRs, from the rows alone (no extra GitHub calls).
export function digest(
  rows: PrRow[],
  me: string,
  config: Config,
  options: { onText?: (soFar: string) => void; signal?: AbortSignal } = {},
): Promise<ReportResult> {
  const prompt = digestPrompt(rows, { me, now: Date.now(), offsetMinutes: localOffset() }, config.sections['digest focus'])

  return complete(prompt, DIGEST_SYSTEM, config, options)
}

type Streaming = { onText?: (soFar: string) => void; signal?: AbortSignal }

// One plain answer from the configured provider.
function complete(prompt: string, system: string, config: Config, options: Streaming): Promise<ReportResult> {
  return config.reportProvider === 'codex'
    ? completeCodex(prompt, system, config.codexModel, options)
    : completeClaude(prompt, system, config.reportModel, options)
}

// No tools, none of the person's settings, hooks, plugins or MCP servers, nothing saved.
async function completeClaude(
  prompt: string,
  system: string,
  model: string,
  { onText, signal }: Streaming,
): Promise<ReportResult> {
  const abortController = new AbortController()
  signal?.addEventListener('abort', () => abortController.abort())
  let text = ''
  try {
    const messages = query({
      prompt,
      options: {
        model,
        systemPrompt: system,
        effort: 'low',
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        maxTurns: 1,
        includePartialMessages: true,
        cwd: tmpdir(),
        // The installed CLI, so a compiled prs works without the SDK's bundled copy.
        pathToClaudeCodeExecutable: Bun.which('claude') ?? undefined,
        abortController,
      },
    })
    for await (const message of messages) {
      if (message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text
          onText?.(text)
        }
      } else if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error) {
          return { failure: `The model did not answer (${message.subtype === 'success' ? message.result : message.subtype})` }
        }

        return { text: message.result || text }
      }
    }
  } catch (err) {
    return { failure: signal?.aborted ? 'Cancelled' : err instanceof Error ? err.message : String(err) }
  }

  return text ? { text } : { failure: 'The model did not answer' }
}

type CodexEvent = {
  type: string
  message?: string
  item?: { type: string; text?: string; message?: string }
  error?: { message?: string }
}

// The same through the Codex CLI and its own login: read-only sandbox, no user config or rules, nothing saved.
// Codex sends the answer whole, so `onText` gets it once.
async function completeCodex(prompt: string, system: string, model: string, { onText, signal }: Streaming): Promise<ReportResult> {
  const codex = Bun.which('codex')
  if (!codex) {
    return { failure: 'Codex CLI not found on PATH (npm i -g @openai/codex, then codex login)' }
  }
  const args = [
    codex, 'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--sandbox', 'read-only', '--skip-git-repo-check', '-C', tmpdir(),
    '-c', `developer_instructions=${JSON.stringify(system)}`,
    '-c', 'model_reasoning_effort="low"',
    ...(model ? ['-m', model] : []),
    '-',
  ]
  const child = Bun.spawn(args, { cwd: tmpdir(), stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe' })
  const kill = () => child.kill()
  signal?.addEventListener('abort', kill)
  let text = ''
  let failure = ''
  try {
    let pending = ''
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseEvent(line)
        if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          text = text ? `${text}\n\n${event.item.text}` : event.item.text
          onText?.(text)
        } else if (event?.type === 'turn.failed' || event?.type === 'error') {
          failure = apiMessage(event.error?.message ?? event.message ?? '') || failure
        }
      }
    }
    const exitCode = await child.exited
    if (signal?.aborted) {
      return { failure: 'Cancelled' }
    }
    if (failure || (exitCode !== 0 && !text)) {
      const stderr = (await new Response(child.stderr).text()).trim().split('\n').pop()
      return { failure: `The model did not answer (${failure || stderr || `codex exited with ${exitCode}`})` }
    }
  } finally {
    signal?.removeEventListener('abort', kill)
  }

  return text ? { text } : { failure: 'The model did not answer' }
}

function parseEvent(line: string): CodexEvent | null {
  try {
    return line.trim() ? (JSON.parse(line) as CodexEvent) : null
  } catch {
    return null
  }
}

// Codex wraps API errors as JSON inside the message; the inner message reads better.
function apiMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } }
    return parsed.error?.message ?? raw
  } catch {
    return raw
  }
}

// The models the Codex CLI lists, from its catalog; empty when Codex is missing or the catalog changed shape.
export async function codexModels(): Promise<string[]> {
  const codex = Bun.which('codex')
  if (!codex) {
    return []
  }
  try {
    const child = Bun.spawn([codex, 'debug', 'models'], { cwd: tmpdir(), stdout: 'pipe', stderr: 'ignore' })
    const catalog = JSON.parse(await new Response(child.stdout).text()) as { models?: { slug?: string; visibility?: string }[] }
    return (catalog.models ?? []).filter(one => one.slug && one.visibility === 'list').map(one => one.slug!)
  } catch {
    return []
  }
}

function jsonLines<T>(result: RunResult): T[] {
  if (result.exitCode !== 0) {
    return []
  }

  return result.stdout
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as T)
}
