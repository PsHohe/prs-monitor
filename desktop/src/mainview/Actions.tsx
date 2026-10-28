import type { PrRow } from '../../../src/types'
import { useAddress } from './addresses'
import { bun } from './bridge'
import { startReport, useReport } from './reports'
import { useReview } from './reviews'

type Props = { pr: PrRow; isAiOn: boolean; onReply: () => void; onAddress: () => void; onReview: () => void }

// What can be done with the selected PR, each with its key.
export function Actions({ pr, isAiOn, onReply, onAddress, onReview }: Props) {
  const report = useReport(pr)
  const address = useAddress(pr)
  const review = useReview(pr)
  const owed = pr.replies?.length ?? 0
  const isWriting = !!report && !report.isDone

  return (
    <div className="actions-panel">
      <section className="card">
        <Action label="Open on GitHub" shortcut="o" onClick={() => bun.openUrl({ url: pr.url })} />
        {owed > 0 && <Action label={`Reply to ${owed} thread${owed === 1 ? '' : 's'}`} shortcut="r" isPrimary onClick={onReply} />}
      </section>
      {isAiOn && (
        <section className="card">
          <Action label={isWriting ? 'Writing report…' : report ? 'Rewrite AI report' : 'Write AI report'} shortcut="g" isDisabled={isWriting} onClick={() => startReport(pr)} />
          {owed > 0 && (
            <Action label={!address ? 'Draft answers with AI' : address.isBusy ? 'Drafting answers…' : 'Show drafted answers'} shortcut="a" onClick={onAddress} />
          )}
          <Action label={!review ? 'Start AI review' : review.isBusy && review.turn === 0 ? 'Reviewing…' : 'Show AI review'} shortcut="v" onClick={onReview} />
        </section>
      )}
    </div>
  )
}

type ActionProps = { label: string; shortcut: string; isPrimary?: boolean; isDisabled?: boolean; onClick: () => void }

function Action({ label, shortcut, isPrimary = false, isDisabled = false, onClick }: ActionProps) {
  return (
    <button className={`action ${isPrimary ? 'primary' : ''}`} disabled={isDisabled} onClick={onClick}>
      <span>{label}</span>
      <kbd>{shortcut}</kbd>
    </button>
  )
}
