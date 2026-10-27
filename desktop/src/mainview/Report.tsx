import { useEffect } from 'react'

import { ago, rowKey } from '../../../src/lib/lib'
import type { PrRow } from '../../../src/types'
import { toHtml } from './markdown'
import { stampOf } from './remote'
import { cancelReport, startReport, useReport } from './reports'

// PRs the automatic report already started for as they looked then, so a cancel or a failure is not retried.
const autoStarted = new Set<string>()

type Props = { pr: PrRow; now: number; isAuto: boolean }

// The AI status report: written on demand, or on opening a PR waiting on me when that setting is on.
export function ReportCard({ pr, now, isAuto }: Props) {
  const report = useReport(pr)
  const stamp = stampOf(pr)
  const isWriting = !!report && !report.isDone
  const isStale = !!report && report.stamp !== stamp

  // After a moment, so stepping through the list with the keyboard does not start a report for every PR passed.
  useEffect(() => {
    const tried = `${rowKey(pr)}|${stamp}`
    if (!isAuto || pr.bucket !== 'me' || isWriting || (report && !isStale) || autoStarted.has(tried)) {
      return
    }
    const timer = setTimeout(() => {
      autoStarted.add(tried)
      startReport(pr)
    }, 600)

    return () => clearTimeout(timer)
  }, [isAuto, stamp, isWriting, isStale, !!report])

  if (!report) {
    return (
      <section className="report">
        <div className="report-head">
          <span className="spark">✦</span>
          <b>AI report</b>
          <span className="muted">Where this PR stands and what to do next</span>
          <span className="spacer" />
          <button onClick={() => startReport(pr)} title="g">
            Write report
          </button>
        </div>
      </section>
    )
  }

  const status = isWriting ? `Writing${report.model ? ` · ${report.model}` : '…'}` : report.failure ? 'Failed' : `${report.model} · ${ago(report.at, now)}`

  return (
    <section className={`report ${isWriting ? 'writing' : ''}`} aria-busy={isWriting}>
      <div className="report-head">
        <span className="spark">✦</span>
        <b>AI report</b>
        <span className="muted">{status}</span>
        <span className="spacer" />
        {isWriting ? (
          <button className="link" onClick={() => cancelReport(pr)}>
            Cancel
          </button>
        ) : (
          <button className="link" onClick={() => startReport(pr)} title="g">
            {report.failure ? 'Try again' : 'Rewrite'}
          </button>
        )}
      </div>
      {isStale && !isWriting && <p className="notice muted">The PR changed since this report was written.</p>}
      {report.failure ? (
        <p className="error">{report.failure}</p>
      ) : report.text ? (
        <div className="md" dangerouslySetInnerHTML={{ __html: toHtml(report.text) }} />
      ) : (
        <p className="muted">Reading the PR…</p>
      )}
    </section>
  )
}
