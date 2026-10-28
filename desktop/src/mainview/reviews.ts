import { useSyncExternalStore } from 'react'

import { rowKey } from '../../../src/lib/lib'
import type { ExplainStart, FindingFields, ReviewDraft, ReviewState, Triage } from '../../../src/lib/review'
import type { PrRow } from '../../../src/types'
import type { SavedReview } from '../shared/rpc'
import { bun, pushed } from './bridge'
import { restamp, stampOf } from './remote'

export type Review = SavedReview

// Saved on this machine, so a review and my triage outlast a restart; the model's session does not, and a message
// to a review without one starts a new session that carries on from it.
const reviews = new Map<string, Review>()
const listeners = new Set<() => void>()

// Saves each review a moment after it last changed, since an answer streams in many small updates.
const saving = new Map<string, ReturnType<typeof setTimeout>>()
const save = (key: string) => {
  clearTimeout(saving.get(key))
  saving.set(
    key,
    setTimeout(() => {
      saving.delete(key)
      void bun.saveReview({ key, review: reviews.get(key) ?? null })
    }, 1000),
  )
}

const changed = (key: string) => {
  save(key)
  listeners.forEach(listener => listener())
}

const change = (pr: PrRow, edit: (review: Review) => Partial<Review>) => {
  const key = rowKey(pr)
  const review = reviews.get(key)
  if (review) {
    reviews.set(key, { ...review, ...edit(review) })
    changed(key)
  }
}

// A review that moved on to new commits by itself is not stale for them, and what I posted was for the old ones.
pushed.onReview = ({ key, ...update }) => {
  const review = reviews.get(key)
  if (review) {
    const isMoved = !!update.commitId && !!review.commitId && update.commitId !== review.commitId
    const moved = isMoved ? { stamp: restamp(review.stamp, update.commitId!), posted: null } : {}
    reviews.set(key, { ...review, ...update, ...moved })
    changed(key)
  }
}

// An explanation for a finding the review no longer has (it started over) is dropped. A session carrying on from an
// ended one starts without its verdict, so the last one stands until it gives another; what I did with it is mine.
pushed.onExplain = ({ key, findingId, ...thread }) => {
  const review = reviews.get(key)
  if (review?.findings.some(finding => finding.id === findingId)) {
    const previous = review.explains[findingId]
    const merged = { ...thread, assessment: thread.assessment ?? previous?.assessment ?? null, settled: previous?.settled ?? null }
    reviews.set(key, { ...review, explains: { ...review.explains, [findingId]: merged } })
    changed(key)
  }
}

// A review started before they load wins over the saved one.
void bun.savedReviews({}).then(saved => {
  for (const [key, review] of Object.entries(saved)) {
    if (!reviews.has(key)) {
      reviews.set(key, review)
    }
  }
  listeners.forEach(listener => listener())
})

const subscribe = (listener: () => void) => {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

export function useReview(pr: PrRow): Review | null {
  const key = rowKey(pr)

  return useSyncExternalStore(subscribe, () => reviews.get(key) ?? null)
}

// The review as the model knows it, without what only this app keeps.
function stateOf(review: Review): ReviewState {
  const { stamp: _stamp, at: _at, model: _model, triage: _triage, selected: _selected, posted: _posted, explains: _explains, ...state } = review

  return state
}

export function startReview(pr: PrRow): void {
  const key = rowKey(pr)
  reviews.set(key, {
    stamp: stampOf(pr),
    at: new Date().toISOString(),
    model: '',
    findings: [],
    summary: null,
    messages: [],
    turn: 0,
    isBusy: true,
    failure: null,
    hasCode: null,
    activity: null,
    draft: null,
    commitId: null,
    suggestions: [],
    triage: {},
    selected: [],
    posted: null,
    explains: {},
  })
  explaining.delete(key)
  changed(key)
  void bun.startReview({ pr, start: { kind: 'fresh' } })
}

// Reviews the commits pushed since, carrying the findings and my triage over.
export function rereview(pr: PrRow): void {
  const review = reviews.get(rowKey(pr))
  if (!review || review.isBusy) {
    return
  }
  // The draft, and so what I posted of it, belongs to the commits reviewed before.
  change(pr, () => ({ stamp: stampOf(pr), at: new Date().toISOString(), isBusy: true, failure: null, selected: [], posted: null }))
  void bun.startReview({ pr, start: { kind: 'rereview', prior: stateOf(review), triage: review.triage } })
}

// Asks GitHub whether commits came since the review looked, without waiting for the list to refresh, and re-reviews
// them if so; else says why nothing happened.
export async function checkCommits(pr: PrRow): Promise<string | null> {
  const head = await bun.prHead({ pr })
  const review = reviews.get(rowKey(pr))
  if (!head) {
    return 'Could not reach GitHub.'
  }
  if (!review || review.isBusy || head === review.commitId) {
    return review?.isBusy ? null : 'No new commits since this review.'
  }
  rereview(pr)

  return null
}

// Cancels the review being made, and forgets it.
export function cancelReview(pr: PrRow): void {
  const key = rowKey(pr)
  reviews.delete(key)
  explaining.delete(key)
  changed(key)
  void bun.cancelReview({ key })
}

// null puts the finding back to triage.
export function setTriage(pr: PrRow, id: number, triage: Triage | null): void {
  change(pr, review => {
    const { [id]: _, ...rest } = review.triage

    return { triage: triage ? { ...rest, [id]: triage } : rest }
  })
}

export function toggleSelected(pr: PrRow, id: number): void {
  change(pr, review => ({ selected: review.selected.includes(id) ? review.selected.filter(one => one !== id) : [...review.selected, id] }))
}

// Sends my message with the findings given; the main process confirms it with the next update.
export async function sendMessage(pr: PrRow, text: string, refs: number[]): Promise<void> {
  const review = reviews.get(rowKey(pr))
  if (!review || review.isBusy) {
    return
  }
  change(pr, () => ({ selected: [], isBusy: true, failure: null }))
  if (!(await bun.sendReview({ pr, text, refs, triage: review.triage, prior: stateOf(review) }))) {
    change(pr, () => ({ isBusy: false, failure: 'The model is still answering; try again once it is done.' }))
  }
}

// Posts the draft as I edited it; the failure when GitHub refused it.
export async function postDraft(pr: PrRow, draft: ReviewDraft, submit: boolean): Promise<string | null> {
  const done = await bun.postReview({ pr, draft, submit })
  if (done.ok) {
    change(pr, () => ({ posted: { revision: draft.revision, text: done.text, url: done.url } }))
  }

  return done.ok ? null : done.text
}

export function stopAnswer(pr: PrRow): void {
  void bun.stopReview({ key: rowKey(pr) })
}

// The finding whose explanation shows beside each PR, by row key; for this run only.
const explaining = new Map<string, number>()

export function useExplaining(pr: PrRow | null): number | null {
  const key = pr ? rowKey(pr) : null

  return useSyncExternalStore(subscribe, () => (key ? (explaining.get(key) ?? null) : null))
}

// The explanation's latest verdict on the finding, and what I did with it; null until it gives one.
export function verdictOf(review: Review, id: number) {
  const thread = review.explains[id]
  const assessment = thread?.assessment ?? null
  const settled = assessment && thread?.settled?.at === assessment.at ? thread.settled : null

  return assessment ? { ...assessment, settled } : null
}

const explainStart = (review: Review, id: number, text: string | null): ExplainStart => {
  const verdict = verdictOf(review, id)

  return {
    finding: review.findings.find(finding => finding.id === id)!,
    summary: review.summary,
    triage: review.triage[id] ?? null,
    // An answer that failed or never came says nothing to carry on.
    prior: (review.explains[id]?.messages ?? []).filter(message => message.text.trim()),
    assessed: verdict && { verdict: verdict.verdict, settled: verdict.settled?.state ?? null },
    text,
  }
}

const changeExplain = (pr: PrRow, id: number, edit: Partial<Review['explains'][number]>) =>
  change(pr, review => {
    const thread = review.explains[id] ?? { messages: [], isBusy: false, failure: null, hasCode: null, activity: null, assessment: null, settled: null, model: review.model }

    return { explains: { ...review.explains, [id]: { ...thread, ...edit } } }
  })

// Shows the finding's explanation beside the PR, asking for it the first time.
export function explain(pr: PrRow, id: number): void {
  const key = rowKey(pr)
  const review = reviews.get(key)
  if (!review?.findings.some(finding => finding.id === id)) {
    return
  }
  explaining.set(key, id)
  if (review.explains[id]) {
    listeners.forEach(listener => listener())
  } else {
    restartExplain(pr, id)
  }
}

// Asks for the explanation anew, forgetting the one so far.
export function restartExplain(pr: PrRow, id: number): void {
  const review = reviews.get(rowKey(pr))
  if (!review) {
    return
  }
  const start = { ...explainStart(review, id, null), prior: [], assessed: null }
  changeExplain(pr, id, { messages: [{ role: 'ai', text: '', refs: [], changes: [] }], isBusy: true, failure: null, activity: null, assessment: null, settled: null })
  void bun.startExplain({ pr, start })
}

export function closeExplain(pr: PrRow): void {
  explaining.delete(rowKey(pr))
  listeners.forEach(listener => listener())
}

// My question about the finding; the main process confirms it with the next update.
export async function askExplain(pr: PrRow, id: number, text: string): Promise<void> {
  const review = reviews.get(rowKey(pr))
  if (!review || review.explains[id]?.isBusy) {
    return
  }
  const start = { ...explainStart(review, id, text), text }
  changeExplain(pr, id, { isBusy: true, failure: null })
  if (!(await bun.sendExplain({ pr, start }))) {
    changeExplain(pr, id, { isBusy: false, failure: 'The model is still answering; try again once it is done.' })
  }
}

export function stopExplain(pr: PrRow, id: number): void {
  void bun.stopExplain({ key: rowKey(pr), findingId: id })
}

// Changes the finding here and in the open review session, which tells the model with my next message.
function reviseFinding(pr: PrRow, id: number, changes: Partial<FindingFields>): void {
  change(pr, review => ({ findings: review.findings.map(finding => (finding.id === id ? { ...finding, ...changes } : finding)) }))
  void bun.reviseFinding({ key: rowKey(pr), findingId: id, changes })
}

// Applies the explanation's revision to the finding, keeping what the fields were to undo it.
export function applyRevision(pr: PrRow, id: number): void {
  const review = reviews.get(rowKey(pr))
  const finding = review?.findings.find(one => one.id === id)
  const assessment = review?.explains[id]?.assessment
  if (!finding || !assessment?.revision) {
    return
  }
  const before = Object.fromEntries(Object.keys(assessment.revision).map(field => [field, finding[field as keyof FindingFields]]))
  reviseFinding(pr, id, assessment.revision)
  changeExplain(pr, id, { settled: { at: assessment.at, state: 'applied', before } })
}

export function ignoreVerdict(pr: PrRow, id: number): void {
  const assessment = reviews.get(rowKey(pr))?.explains[id]?.assessment
  if (assessment) {
    changeExplain(pr, id, { settled: { at: assessment.at, state: 'ignored', before: null } })
  }
}

// Puts the finding back as it was when I applied the revision, or the verdict back to decide on.
export function undoVerdict(pr: PrRow, id: number): void {
  const settled = reviews.get(rowKey(pr))?.explains[id]?.settled
  if (settled?.before) {
    reviseFinding(pr, id, settled.before)
  }
  changeExplain(pr, id, { settled: null })
}
