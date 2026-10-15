import type { PrRow } from './types'
import { fetchThreads, run } from './github'
import { askPrompt, cleanupPrompt, repliesPrompt, rereviewPrompt, reviewPrompt } from './lib/lib'
import type { Config } from './lib/lib'

export type Action = 'ask' | 'review' | 'clean' | 'replies'

// Minutes east of UTC, so prompts show local times.
export function localOffset(): number {
  return -new Date().getTimezoneOffset()
}

// Re-review once we reviewed and something changed; Review when we are asked and never have.
export function reviewLabel(pr: PrRow): string {
  if (pr.state !== 'OPEN') {
    return ''
  }

  return pr.rereview ? 'Re-review' : pr.needsFirstReview ? 'Review' : ''
}

// The prompt for a Claude session, or why there is none.
export async function promptFor(
  action: Action,
  pr: PrRow,
  config: Config,
  me: string,
  report?: string,
): Promise<{ text: string } | { failure: string }> {
  if (action === 'ask') {
    return { text: askPrompt(pr, config, report) }
  }
  if (action === 'replies') {
    const text = repliesPrompt(pr, config)

    return text ? { text } : { failure: 'No threads are waiting for your reply' }
  }
  if (action === 'clean') {
    const text = cleanupPrompt(pr, config)

    return text ? { text } : { failure: 'No "## Cleanup" section in .claude/pr-monitor.md for this project' }
  }
  const last = pr.rereview
  if (!last) {
    return { text: reviewPrompt(pr, config) }
  }
  const data = pr.repo ? await fetchThreads(pr.repo, pr.number) : null
  const context = {
    me,
    headOid: data?.headOid ?? null,
    reviewBody: data?.reviews.find(r => r.author === me && r.at === last.at)?.body ?? '',
    offsetMinutes: localOffset(),
  }
  const text = rereviewPrompt(pr, data?.threads ?? [], context, config)

  return text ? { text } : { failure: 'Nothing to re-review' }
}

export async function copy(text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
    proc.stdin.write(text)
    await proc.stdin.end()

    return (await proc.exited) === 0
  } catch {
    return false
  }
}

export function openUrl(url: string): void {
  void run(['open', url])
}

// The terminal posts the notification, so clicking it focuses the terminal. herdr stops
// OSC sequences at its panes, so inside it we go through its own notification command.
export function notify(text: string): void {
  const clean = text.replace(/[\x00-\x1f\x7f]/g, ' ')
  if (process.env.HERDR_ENV) {
    void run([process.env.HERDR_BIN_PATH ?? 'herdr', 'notification', 'show', 'PRs', '--body', clean])
  } else {
    process.stdout.write(`\x1b]9;PRs: ${clean}\x07`)
  }
  process.stdout.write('\x07')
}
