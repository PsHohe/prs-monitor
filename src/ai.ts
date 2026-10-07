import { tmpdir } from 'node:os'

import { query } from '@anthropic-ai/claude-agent-sdk'

import { localOffset } from './actions'
import { gh } from './github'
import type { RunResult } from './github'
import { REPORT_SYSTEM, reportPrompt } from './lib/lib'
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

  const abortController = new AbortController()
  signal?.addEventListener('abort', () => abortController.abort())
  let text = ''
  try {
    // One plain answer: no tools, none of the person's settings, hooks, plugins or MCP servers, nothing saved.
    const messages = query({
      prompt: reportPrompt(data, config),
      options: {
        model: config.reportModel,
        systemPrompt: REPORT_SYSTEM,
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

function jsonLines<T>(result: RunResult): T[] {
  if (result.exitCode !== 0) {
    return []
  }

  return result.stdout
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as T)
}
