import type { PrRow } from './types'
import { fetchThreads, run } from './github'
import { askPrompt, cleanupPrompt, rereviewPrompt, reviewPrompt } from './lib/lib'
import type { Config } from './lib/lib'

export type Action = 'ask' | 'review' | 'clean'

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
export async function promptFor(action: Action, pr: PrRow, config: Config, me: string): Promise<{ text: string } | { failure: string }> {
  if (action === 'ask') {
    return { text: askPrompt(pr, config) }
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

export function notify(text: string): void {
  const quoted = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`
  void run(['osascript', '-e', `display notification ${quoted(text)} with title "PRs"`])
  process.stdout.write('\x07')
}
