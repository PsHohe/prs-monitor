import Electrobun, { Electroview } from 'electrobun/view'

import type { Snapshot } from '../../../src/monitor'
import type { DesktopState } from '../shared/repos'
import type { ExplainUpdate, PrsRpc, ReportUpdate, ReviewUpdate } from '../shared/rpc'

// Snapshots the main process pushes on its own schedule, and reports and reviews as they are written; listeners are set once mounted.
export const pushed = {
  onSnapshot: (_snapshot: Snapshot) => {},
  onReport: (_update: ReportUpdate) => {},
  onReview: (_update: ReviewUpdate) => {},
  onExplain: (_update: ExplainUpdate) => {},
  onOpenSettings: () => {},
  onRepos: (_state: DesktopState) => {},
  onUpdateReady: (_version: string) => {},
}

const rpc = Electroview.defineRPC<PrsRpc>({
  maxRequestTime: 60 * 1000,
  handlers: {
    requests: {},
    messages: {
      snapshot: snapshot => pushed.onSnapshot(snapshot),
      report: update => pushed.onReport(update),
      review: update => pushed.onReview(update),
      explain: update => pushed.onExplain(update),
      openSettings: () => pushed.onOpenSettings(),
      repos: state => pushed.onRepos(state),
      updateReady: ({ version }) => pushed.onUpdateReady(version),
    },
  },
})

export const bun = new Electrobun.Electroview({ rpc }).rpc!.request

// Every link opens in the browser; the webview itself never navigates away from the app.
document.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('a') : null
  if (!link) {
    return
  }
  event.preventDefault()
  if (/^https?:\/\//.test(link.href)) {
    void bun.openUrl({ url: link.href })
  }
})
