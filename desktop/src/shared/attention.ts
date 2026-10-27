import type { PrRow } from '../../../src/types'

// What a PR in "waiting on me" or "ready to merge" wants from me, in words, most urgent first.
export function reasonsOf(pr: PrRow): string[] {
  if (pr.bucket === 'ready') {
    return ['Approved and green, ready to merge']
  }
  const reasons: string[] = []
  const owed = pr.replies ?? []
  if (owed.length > 0) {
    const who = [...new Set(owed.map(thread => thread.last).filter(Boolean))]
    reasons.push(`${count(owed.length, 'thread')} waiting for your reply${who.length > 0 ? ` (${who.join(', ')})` : ''}`)
  }
  if (pr.isMine && pr.ci === 'fail' && !pr.isFlakyOnly) {
    reasons.push(`CI failing: ${pr.failingChecks.join(', ') || 'a check'}`)
  }
  if (pr.isMine && pr.hasConflicts) {
    reasons.push(`Merge conflicts with ${pr.baseRef}`)
  }
  if (pr.isRequestedFromMe && !pr.hasLastWord) {
    if (pr.needsFirstReview) {
      reasons.push(`${pr.author} asked for your review`)
    } else if (pr.rereview) {
      const { commits } = pr.rereview
      reasons.push(commits > 0 ? `${count(commits, 'new commit')} since your review` : 'New replies since your review')
    } else {
      reasons.push(`${pr.author} asked for your review again`)
    }
  }
  if (pr.isNew && pr.lastOtherWhat && reasons.length === 0) {
    reasons.push(`New ${pr.lastOtherWhat}`)
  }

  return reasons
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
