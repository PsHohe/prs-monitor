import { ciChip, extraChips, reviewChip, threadsChip } from '../../../src/lib/lib'
import type { Chip } from '../../../src/lib/lib'
import type { PrRow } from '../../../src/types'

// The terminal's legend, as tooltips; checked in order, so longer prefixes come first.
const TIPS: [string, string][] = [
  ['✓ CI', 'CI passing'],
  ['✗ CI~', 'Only checks marked flaky are failing'],
  ['✗ CI', 'CI failing'],
  ['◐', 'CI running: checks done / total'],
  ['– CI', 'No CI checks'],
  ['✓ ready', 'Approved, green and without conflicts'],
  ['✓', 'Approvals'],
  ['✗ changes', 'Changes requested'],
  ['✗ conflicts', 'Merge conflicts with the base branch'],
  ['○ review', 'No reviews yet'],
  ['○', 'Reviews so far, none approving'],
  ['↓ behind', 'The branch is behind its base'],
  ['↩', 'Unresolved threads waiting for your reply'],
  ['⚑', 'Unresolved review threads'],
  ['Δ', 'Changed since your review'],
  ['◆ requested', 'Your review is requested'],
  ['↳', 'Stacked on another open PR'],
  ['⇄', 'Twin PR for the same ticket on the other base'],
  ['merged', 'Merged'],
  ['closed', 'Closed'],
]

export function chipsOf(pr: PrRow): Chip[] {
  return [reviewChip(pr), ciChip(pr), ...(pr.unresolved ? [threadsChip(pr)] : []), ...extraChips(pr)]
}

export function Chips({ pr }: { pr: PrRow }) {
  return (
    <span className="chips">
      {chipsOf(pr).map((chip, index) => (
        <span
          key={index}
          className={`chip ${chip.color ?? ''} ${chip.dim ? 'dim' : ''}`}
          title={TIPS.find(([prefix]) => chip.text.startsWith(prefix))?.[1]}
        >
          {chip.text}
        </span>
      ))}
    </span>
  )
}

export function Avatar({ login, size = 20 }: { login: string; size?: number }) {
  return <img className="avatar" src={`https://github.com/${login}.png?size=${size * 2}`} width={size} height={size} alt="" onError={event => (event.currentTarget.style.visibility = 'hidden')} />
}
