import type { Done } from '../../../src/github'
import type { AddressState } from '../../../src/lib/address'
import type { Conversation, Effort, ReportProvider, ThreadDetail } from '../../../src/lib/lib'
import type { ExplainStart, FindingFields, ReviewDraft, ReviewStart, ReviewState, Triage } from '../../../src/lib/review'
import type { ExplainState } from '../../../src/review'
import type { Snapshot } from '../../../src/monitor'
import type { PrRow } from '../../../src/types'
import type { DesktopState } from './repos'

// Plain shapes so the webview can import them without pulling in the main-process SDK.
export type PrsRpc = {
  bun: {
    requests: {
      // force always asks GitHub; otherwise a cache under a minute old is used.
      refresh: { params: { force: boolean }; response: Snapshot }
      openUrl: { params: { url: string }; response: boolean }
      // Puts the text on the clipboard; false when that failed.
      copy: { params: { text: string }; response: boolean }
      // An image uploaded to a GitHub comment, fetched with my token since private repos' images need it.
      image: { params: { url: string }; response: { dataUrl: string } | { failure: string } }
      conversation: { params: { pr: PrRow }; response: Conversation | { failure: string } }
      // The unresolved threads, those waiting for my reply first.
      threads: { params: { pr: PrRow }; response: ThreadsData | { failure: string } }
      // The PR's unified diff, as gh pr diff prints it.
      diff: { params: { pr: PrRow }; response: { text: string } | { failure: string } }
      reply: { params: { threadId: string; body: string }; response: Done }
      resolve: { params: { threadId: string }; response: Done }
      repos: { params: {}; response: DesktopState }
      // Asks for a folder inside a clone; null when the picker was cancelled.
      addRepo: { params: {}; response: DesktopState | { failure: string } | null }
      removeRepo: { params: { repo: string }; response: DesktopState }
      // null shows every repo involving me.
      setActive: { params: { repo: string | null }; response: DesktopState }
      setAutoReport: { params: { isOn: boolean }; response: DesktopState }
      setKeepInTray: { params: { isOn: boolean }; response: DesktopState }
      // The providers this app may use; none turns its AI features off.
      setProviders: { params: { providers: ReportProvider[] }; response: DesktopState }
      settings: { params: {}; response: Settings }
      // Frontmatter keys for the home config file, shared with the CLI; an empty value removes the key.
      saveSettings: { params: { values: Record<string, string> }; response: Settings | { failure: string } }
      // Starts writing the PR's AI report, replacing one already being written; the text arrives as report messages.
      startReport: { params: { pr: PrRow }; response: boolean }
      cancelReport: { params: { key: string }; response: boolean }
      // Starts a session of the PR's AI review, replacing the one open: a new review, or a re-review carrying on an
      // earlier one; findings arrive as review messages.
      startReview: { params: { pr: PrRow; start: ReviewStart }; response: boolean }
      cancelReview: { params: { key: string }; response: boolean }
      // A message about the review; when its session ended, a new one carries on from prior. False while the model
      // still answers the last one.
      sendReview: { params: { pr: PrRow; text: string; refs: number[]; triage: Record<number, Triage>; prior: ReviewState }; response: boolean }
      // The reviews saved on this machine by row key, and saving one (null forgets it).
      savedReviews: { params: {}; response: Record<string, SavedReview> }
      saveReview: { params: { key: string; review: SavedReview | null }; response: boolean }
      // Stops the model's current answer; the review stays open.
      stopReview: { params: { key: string }; response: boolean }
      // The PR's head commit on GitHub now; null when GitHub cannot be reached.
      prHead: { params: { pr: PrRow }; response: string | null }
      // Posts the draft as I edited it: submitted with its verdict, or pending for me to finish on GitHub.
      postReview: { params: { pr: PrRow; draft: ReviewDraft; submit: boolean }; response: Done & { url: string | null } }
      // Explains a finding of the PR's review in a side conversation, replacing the one open for it; the answer
      // arrives as explain messages.
      startExplain: { params: { pr: PrRow; start: ExplainStart }; response: boolean }
      // My question about the finding; when its session ended, a new one carries on from start. False while the model
      // still answers.
      sendExplain: { params: { pr: PrRow; start: ExplainStart & { text: string } }; response: boolean }
      stopExplain: { params: { key: string; findingId: number }; response: boolean }
      // My revision of a finding from its explanation, for the open review session to keep and tell the model.
      reviseFinding: { params: { key: string; findingId: number; changes: Partial<FindingFields> }; response: boolean }
      // Drafts what to do about each thread waiting on me, replacing the drafts being made; they arrive as address messages.
      startAddress: { params: { pr: PrRow }; response: boolean }
      cancelAddress: { params: { key: string }; response: boolean }
      // A double click on the app's top bar, which stands in for the title bar.
      titleBarDoubleClick: { params: {}; response: boolean }
      // Restarts into the downloaded update.
      applyUpdate: { params: {}; response: boolean }
    }
    messages: {}
  }
  webview: {
    requests: {}
    messages: {
      snapshot: Snapshot
      report: ReportUpdate
      review: ReviewUpdate
      explain: ExplainUpdate
      address: AddressUpdate
      // The app menu's Settings item.
      openSettings: {}
      // The repo list and app settings, changed outside the webview (the question on the first close).
      repos: DesktopState
      // A newer version, downloaded and ready once the app restarts.
      updateReady: { version: string }
    }
  }
}

export type ThreadsData = { me: string; pages: { thread: ThreadDetail; isOwed: boolean }[] }

// The report so far for the PR with this row key; failure is set once it stopped without one.
export type ReportUpdate = { key: string; text: string; model: string; isDone: boolean; failure: string | null }

// The review as it stands for the PR with this row key.
export type ReviewUpdate = ReviewState & { key: string; model: string }

// The explanation of one finding of the review for the PR with this row key.
export type ExplainUpdate = ExplainState & { key: string; findingId: number; model: string }

// The drafts for the threads waiting on me in the PR with this row key.
export type AddressUpdate = AddressState & { key: string; model: string }

// settled is what I did with the verdict given at that message: applied its revision (before is what the fields were,
// to undo it) or ignored it. One for an earlier verdict no longer counts.
export type ExplainThread = ExplainState & { model: string; settled: { at: number; state: 'applied' | 'ignored'; before: Partial<FindingFields> | null } | null }

// A review as the app keeps it. stamp is what the PR looked like when the review started, so a later change shows
// it is out of date. triage and selected are mine: what I decided about each finding, and those attached to my next
// message. posted is the draft revision I posted, and where it shows on GitHub. explains are the findings' explanations by id.
export type SavedReview = ReviewState & {
  stamp: string
  at: string
  model: string
  triage: Record<number, Triage>
  selected: number[]
  posted: { revision: number; text: string; url: string | null } | null
  explains: Record<number, ExplainThread>
}

// The AI settings from the home config file, what can be picked, and the repos whose own files set something else.
// provider is what this app uses: savedProvider when it is on, else one that is.
export type Settings = {
  path: string
  provider: ReportProvider
  savedProvider: ReportProvider
  claudeModel: string
  codexModel: string
  reviewModel: string
  reviewEffort: Effort
  codexModels: string[]
  hasClaude: boolean
  hasCodex: boolean
  overrides: { repo: string; model: string }[]
}
