import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Subprocess } from 'bun'

import type { Effort } from './lib/lib'
import { applyTurn, REVIEW_SCHEMA } from './lib/review'
import type { CodexTurn } from './lib/review'
import type { EngineHooks, EngineOptions, ReviewEngine } from './review'

// Codex tops out below Claude's max.
const EFFORTS: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }

type CodexEvent = {
  type: string
  thread_id?: string
  message?: string
  item?: { type: string; text?: string; command?: string }
  error?: { message?: string }
}

// The review through the Codex CLI and its own login: each message is one `codex exec` in a read-only sandbox on the
// checkout (no writes, no network), resuming the same thread. The changes to the review come whole with its final
// message, as JSON in REVIEW_SCHEMA's shape; what it reads and runs streams as activity meanwhile.
export function openCodex({ config, dir, system }: EngineOptions, hooks: EngineHooks): ReviewEngine {
  const codex = Bun.which('codex')!
  const cwd = dir ?? tmpdir()
  const { book } = hooks
  // Codex reads the schema from a file. Without the book (an explanation), its final message is the answer as it is.
  const schema = !book ? null : (async () => {
    const folder = await mkdtemp(join(tmpdir(), 'prs-review-schema-'))
    const path = join(folder, 'schema.json')
    await Bun.write(path, JSON.stringify(REVIEW_SCHEMA))

    return { folder, path }
  })()
  let thread: string | null = null
  let child: Subprocess | null = null
  let isStopping = false
  let isClosed = false
  // What did not apply last turn, which the next message tells the model.
  let unapplied: string[] = []

  const turn = async (prompt: string) => {
    const shared = [
      '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      ...(schema ? ['--output-schema', (await schema).path] : []),
      '-c', 'sandbox_mode="read-only"',
      // Nothing that reaches out: the sandbox has no network, and these would get around it.
      '-c', 'web_search="disabled"',
      '--disable', 'plugins', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'in_app_browser',
      '-c', `developer_instructions=${JSON.stringify(system)}`,
      '-c', `model_reasoning_effort="${EFFORTS[config.reviewEffort]}"`,
      ...(config.codexModel ? ['-m', config.codexModel] : []),
    ]
    const args = thread ? [codex, 'exec', 'resume', ...shared, thread, '-'] : [codex, 'exec', ...shared, '-C', cwd, '-']
    const told = unapplied.length > 0 ? `Last time, this did not apply: ${unapplied.join(' ')}\n\n` : ''
    unapplied = []
    if (isClosed) {
      return
    }
    const proc = Bun.spawn(args, { cwd, stdin: new Blob([told + prompt]), stdout: 'pipe', stderr: 'pipe' })
    child = proc
    let last = ''
    let failure = ''
    let pending = ''
    const decoder = new TextDecoder()
    for await (const chunk of proc.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseEvent(line)
        if (event?.type === 'thread.started' && event.thread_id) {
          thread = event.thread_id
        } else if (event?.type === 'item.started' && event.item?.type === 'command_execution' && event.item.command) {
          hooks.onActivity(`Running ${short(unwrapShell(event.item.command))}`)
        } else if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          // Every message but the last is a note on what it does next.
          if (last) {
            hooks.onActivity(short(noteOf(last)))
          }
          last = event.item.text
        } else if (event?.type === 'turn.failed' || event?.type === 'error') {
          failure = apiMessage(event.error?.message ?? event.message ?? '') || failure
        }
      }
    }
    const exitCode = await proc.exited
    child = null
    if (isClosed) {
      return
    }
    if (isStopping) {
      isStopping = false
      hooks.onDone(null, true)
      return
    }
    const parsed = book ? parseTurn(last) : last.trim() ? { answer: last } : null
    if (!parsed) {
      const stderr = (await new Response(proc.stderr).text()).trim().split('\n').pop()
      hooks.onDone(`The model did not answer (${failure || (last ? 'its answer was not the expected JSON' : stderr || `codex exited with ${exitCode}`)})`, false)
      return
    }
    unapplied = book && 'new_findings' in parsed ? applyTurn(book, parsed) : []
    if (parsed.answer.trim()) {
      hooks.onText(parsed.answer.trim(), true)
    }
    hooks.onDone(null, false)
  }

  return {
    send: prompt => {
      void turn(prompt).catch(err => hooks.onDone(err instanceof Error ? err.message : String(err), false))
    },
    stop: () => {
      if (child) {
        isStopping = true
        child.kill()
      }
    },
    close: () => {
      isClosed = true
      child?.kill()
      void schema?.then(({ folder }) => rm(folder, { recursive: true, force: true }))
    },
  }
}

function parseEvent(line: string): CodexEvent | null {
  try {
    return line.trim() ? (JSON.parse(line) as CodexEvent) : null
  } catch {
    return null
  }
}

function parseTurn(text: string): CodexTurn | null {
  try {
    const value = JSON.parse(text) as CodexTurn
    return Array.isArray(value.new_findings) && typeof value.answer === 'string' ? value : null
  } catch {
    return null
  }
}

// Its notes come in the schema's shape too, the note in answer.
function noteOf(text: string): string {
  try {
    const value = JSON.parse(text) as { answer?: unknown }
    return typeof value.answer === 'string' ? value.answer : text
  } catch {
    return text
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

// Codex runs each command through a login shell: `/bin/zsh -lc 'git log -5'` reads better as `git log -5`.
function unwrapShell(command: string): string {
  const inner = /^\S+ -lc (.*)$/s.exec(command)?.[1] ?? command

  return /^'(.*)'$/s.exec(inner)?.[1] ?? inner
}

const short = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}
