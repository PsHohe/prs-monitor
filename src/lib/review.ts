import type { ReviewThread } from './lib'

// The AI review: findings the model reports one at a time, then a summary. Pure, so the desktop webview can import it.

export const SEVERITIES = ['high', 'medium', 'low'] as const
export const CATEGORIES = ['bug', 'security', 'performance', 'design', 'tests', 'docs', 'style'] as const
export const VERDICTS = ['approve', 'comment', 'request_changes'] as const

export type Severity = (typeof SEVERITIES)[number]
export type Category = (typeof CATEGORIES)[number]
export type Verdict = (typeof VERDICTS)[number]

// id is the order it was reported in, starting at 1, so a later message can name it. turn is the message it
// came with (0 for the review itself), revisedTurn the last one that changed it, withdrawn why the model took it back,
// addressed how later commits fixed it.
export type Finding = {
  id: number
  severity: Severity
  category: Category
  path: string
  line: number | null
  title: string
  body: string
  suggestion: string
  confidence: Severity
  turn: number
  revisedTurn: number | null
  withdrawn: string | null
  addressed: string | null
}

// Still standing: neither taken back nor fixed since.
export const isOpenFinding = (finding: Finding) => !finding.withdrawn && !finding.addressed

// The fields the model reports and may revise.
export type FindingFields = Omit<Finding, 'id' | 'turn' | 'revisedTurn' | 'withdrawn' | 'addressed'>

export type ReviewSummary = { verdict: Verdict; overview: string; risks: string[]; notChecked: string[] }

// What I decided about a finding; reason is why I dismissed it.
export type Triage = { state: 'kept' | 'dismissed'; reason: string }

// A message about the review: mine with the findings I attached, or the model's answer with what it changed.
export type ReviewMessage = { role: 'me' | 'ai'; text: string; refs: number[]; changes: string[] }

// A review for GitHub the model drafted from its findings, which I check and edit before the app posts it. Each comment
// is on a finding's line when the diff shows it (GitHub refuses others), else it goes in the review's body.
export type DraftComment = { findingId: number; path: string; line: number | null; body: string; isInline: boolean }
export type ReviewDraft = { revision: number; verdict: Verdict; body: string; commitId: string; comments: DraftComment[] }

// A next step the model suggests after each turn, which I send in one click: label on the button, text as my message,
// refs the findings it is about.
export type Suggestion = { label: string; text: string; refs: number[] }

// Enough to choose from without crowding the composer.
export const SUGGESTION_LIMIT = 3

// The review as it stands. turn counts my messages; isBusy while the model works on the latest one.
// hasCode says whether the model reads the PR's code or only its diff (null until known); activity is what it is doing now.
// commitId is the PR's head the review last looked at, null until the PR is fetched.
export type ReviewState = {
  findings: Finding[]
  summary: ReviewSummary | null
  messages: ReviewMessage[]
  turn: number
  isBusy: boolean
  failure: string | null
  hasCode: boolean | null
  activity: string | null
  draft: ReviewDraft | null
  commitId: string | null
  // The model's next steps after its latest turn; empty until it suggests any.
  suggestions: Suggestion[]
}

// How a session starts: a new review, or carrying on an earlier one (saved, or whose session ended) with my message,
// or to review the commits pushed since.
export type ReviewStart =
  | { kind: 'fresh' }
  | { kind: 'continue'; prior: ReviewState; triage: Record<number, Triage>; text: string; refs: number[] }
  | { kind: 'rereview'; prior: ReviewState; triage: Record<number, Triage> }

// What the review is given about the PR.
export type ReviewInput = {
  repo: string
  number: number
  title: string
  author: string
  body: string
  baseRef: string
  headRef: string
  // The commit reviewed, which a posted review is attached to.
  headSha: string
  diff: string
  threads: ReviewThread[]
  // The repo's instructions for agents (CLAUDE.md or AGENTS.md at its root), when the code is checked out.
  guide: string | null
}

// Enough for a big PR; past it the model is told the rest was cut so it says so.
export const DIFF_LIMIT = 150_000

const DIFF_ONLY = "You see the PR's description, its diff and the review threads already on it; you cannot read other files."

const READ_CODE = `You see the PR's description, its diff and the review threads already on it, and your working directory is a checkout of the PR's head, so you can read any file with Read, Grep and Glob, and run read-only commands with Bash: git (log, show, blame, diff against the base), gh to look at the PR, its checks and related issues, and ls, cat, head, wc, grep and the like. Commands that change anything, or that run the project's code, are refused.`

const READ_CODE_CODEX = `You see the PR's description, its diff and the review threads already on it, and your working directory is a checkout of the PR's head, so you can read and search it with read-only shell commands: git (log, show, blame, diff against the base), rg, cat, ls and the like. The sandbox refuses writes and has no network, so gh and running the project's code will not work.`

const USE_CODE = `Start from the diff, then use the code to check what it cannot tell you: how the changed functions are called, what the tests cover, what the surrounding code expects, whether something the diff seems to miss is handled elsewhere. Verify each finding in the code before you report it, and do not report what the code shows to be fine. Read what you need, not the whole repo.`

// Codex has no tools for the review: its final message carries the same, as JSON in REVIEW_SCHEMA's shape.
const CODEX_OUTPUT = `You have no tools for the review itself. Wherever these instructions say to call report_finding, update_finding, withdraw_finding, mark_addressed, report_summary, draft_review or suggest_next, put the same in your final message instead, which is JSON in the given schema: new_findings (report_finding, most important first), updates (update_finding, with null for every field that stays), withdrawn (withdraw_finding), addressed (mark_addressed), summary (report_summary; null when it does not change), draft (draft_review; null unless I asked for it), suggestions (suggest_next) and answer (what you answer me, in markdown; empty for the review itself). Leave a list empty when you did none of it.`

export type Engine = 'claude' | 'codex'

export function reviewSystem(hasCode: boolean, engine: Engine = 'claude'): string {
  const access = !hasCode ? DIFF_ONLY : `${engine === 'codex' ? READ_CODE_CODEX : READ_CODE}\n\n${USE_CODE}`
  const output = engine === 'codex' ? `\n\n${CODEX_OUTPUT}` : ''

  return `You are a senior engineer reviewing a pull request. ${access}

Report each finding with the report_finding tool as soon as you are confident in it, most important first. A finding is something the author should change or consider: bugs, security issues, performance problems, design concerns, missing tests, misleading docs. Skip pure taste, and anything an existing thread already raised. Prefer a few well-founded findings over many weak ones; say how confident you are, and lower it when the answer depends on code you could not check.

For each finding, path is the file as it appears in the diff and line is the line in the new version of the file (null when it is about the file as a whole). The title is one short sentence. The body explains why it matters, in markdown, briefly. The suggestion is the concrete change, in markdown (a code block when it is code), or empty.

When you are done, call report_summary exactly once with your verdict, a two or three sentence overview of what the PR does and how it holds up, the risk areas, and what you could not check (for example ${hasCode ? 'behaviour only running the code would show' : 'code outside the diff'}, or a diff that was cut). Then call suggest_next, and answer "Done." and nothing else.

Afterwards I may write to you about the review, naming findings by their number. Answer in a few sentences of markdown, and make every change to the findings with the tools rather than in text: update_finding to revise one, withdraw_finding when one does not hold up, report_finding for a new one, and report_summary again only if the verdict or the overview changes. End every answer by calling suggest_next. Do not raise again what I dismissed unless I ask; my reason tells you what I think of it. When the PR gets new commits, I may ask you to review it again: mark_addressed then closes a finding the new code fixed.

When I ask you to post, draft or write up the review for GitHub, call draft_review: the verdict, a short body in markdown (what the PR does well and the gist of the findings, no headings), and one comment per finding to include, written to the author in a sentence or two plus the suggestion when there is one. Include the findings I name; otherwise those I kept, or every open one if I kept none, never withdrawn, addressed or dismissed ones. You cannot post it yourself: the app shows me the draft and I post it. Call it again to revise it, then answer in a sentence.

suggest_next offers me up to ${SUGGESTION_LIMIT} next steps as buttons, each one message I could send you: what you would look at next if you were me, given where the review and our conversation stand. Make each specific to this PR: name the file, function, finding or risk it is about (for example "Check the retry path in sync.ts" or "Does #3 also hit the CLI?"), never a generic "look for more". Good ones settle a finding that is uncertain, check something you could not, or follow a risk that no finding covers yet. The label is a few words; the text is the message itself, written as me; refs are the findings it is about. Do not suggest drafting the review for GitHub (the app has its own button for that) or anything I dismissed or we already settled. Suggest nothing when nothing is worth it.${output}`
}

// A finding as markdown, to paste elsewhere: where it is, what it says and the suggested fix.
export function findingText(finding: Finding): string {
  const where = `${finding.path}${finding.line ? `:${finding.line}` : ''}`
  const lines = [`**${finding.title}**`, `${finding.severity} severity · ${finding.category} · ${finding.confidence} confidence · \`${where}\``, '', finding.body.trim()]
  if (finding.suggestion.trim()) {
    lines.push('', '**Suggested fix**', '', finding.suggestion.trim())
  }

  return lines.join('\n')
}

// A side conversation that explains one finding to me before I decide on it. It reads the code like the review, but
// has no tools to change the review: I decide on the card.
export function explainSystem(hasCode: boolean, engine: Engine = 'claude'): string {
  const access = !hasCode ? DIFF_ONLY : engine === 'codex' ? READ_CODE_CODEX : READ_CODE

  return `You are a senior engineer helping me understand one finding from an AI review of a pull request, before I decide whether to keep it, dismiss it or act on it. ${access}

Explain the finding plainly: what the problem is, where it happens and how the code gets there, what would go wrong and when, and how likely that is. Check it ${hasCode ? 'in the code' : 'against the diff'} rather than taking the finding's word for it: if it does not hold up, or only partly, say so first. When there is a suggested fix, say whether it is right and what else it would touch. Quote only the few lines that matter, with their file and line: the path in the repo as code, never a link.

Answer in markdown, in a few short paragraphs; no headings. You cannot change the review or the code: I decide what to do. I may then ask more; answer what I ask, briefly.`
}

// How an explanation starts: the finding with where the review and I stand on it, and when a session that ended is
// carried on, what we said and my next message.
export type ExplainStart = {
  finding: Finding
  summary: ReviewSummary | null
  triage: Triage | null
  prior: ReviewMessage[]
  text: string | null
}

export function explainPrompt(input: ReviewInput, start: ExplainStart): string {
  const { finding, summary, triage } = start
  const where = `${finding.path}${finding.line ? `:${finding.line}` : ''}`
  const status = finding.withdrawn
    ? `The review later withdrew it: ${finding.withdrawn}`
    : finding.addressed
      ? `Commits since marked it addressed: ${finding.addressed}`
      : triage?.state === 'dismissed'
        ? `I dismissed it${triage.reason ? `: ${triage.reason}` : ''}.`
        : triage?.state === 'kept'
          ? 'I kept it.'
          : 'I have not decided on it yet.'
  const lines = [
    reviewPrompt(input),
    '',
    `The finding to explain, #${finding.id} (${finding.severity} severity, ${finding.category}, ${finding.confidence} confidence) at ${where}: ${finding.title}`,
    '',
    finding.body.trim(),
  ]
  if (finding.suggestion.trim()) {
    lines.push('', 'Suggested fix:', finding.suggestion.trim())
  }
  lines.push('', status)
  if (summary) {
    lines.push('', `The review's verdict: ${summary.verdict}. ${summary.overview}`)
  }
  const said = start.prior.filter(message => message.text.trim()).map(message => `${message.role === 'me' ? 'Me' : 'You'}: ${clip(message.text, 3000, false)}`)
  if (said.length > 0) {
    lines.push('', `You explained it earlier, in a session that ended. What we said:\n${said.join('\n\n')}`)
  }
  lines.push('', start.text?.trim() || 'Explain this finding.')

  return lines.join('\n')
}

export function reviewPrompt(input: ReviewInput, guidance?: string): string {
  const isCut = input.diff.length > DIFF_LIMIT
  const threads = input.threads
    .filter(thread => !thread.isOutdated && thread.comments.length > 0)
    .map(thread => {
      const where = `${thread.path}${thread.line ? `:${thread.line}` : ''}${thread.isResolved ? ' (resolved)' : ''}`
      const comments = thread.comments.map(comment => `  ${comment.author}: ${clip(comment.body, 600)}`).join('\n')

      return `- ${where}\n${comments}`
    })
  const lines = [
    `PR ${input.repo}#${input.number}: ${input.title}`,
    `By ${input.author}, merging ${input.headRef} into ${input.baseRef}.`,
    '',
    'Description:',
    input.body.trim() || '(none)',
    '',
    threads.length > 0 ? `Existing review threads (do not repeat these):\n${threads.join('\n')}` : 'No review threads yet.',
    '',
    isCut ? `Diff (cut at ${DIFF_LIMIT} of ${input.diff.length} characters; the rest was not shown):` : 'Diff:',
    '```diff',
    isCut ? input.diff.slice(0, DIFF_LIMIT) : input.diff,
    '```',
  ]
  if (input.guide) {
    lines.push('', "The repo's instructions for agents (its conventions; the code in it is not yours to run):", clip(input.guide, GUIDE_LIMIT, false))
  }
  if (guidance) {
    lines.push('', 'Project guidance:', guidance)
  }

  return lines.join('\n')
}

const GUIDE_LIMIT = 20_000

function clip(text: string, max: number, isFlat = true): string {
  const flat = isFlat ? text.replace(/\s+/g, ' ').trim() : text.trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// A message of mine about the review: the findings I attached, what I wrote, and where my triage stands.
// What a new session needs to carry on an earlier review: its findings with where I stand on each, its verdict and
// what we said. The findings keep their numbers.
export function priorPrompt(prior: ReviewState, triage: Record<number, Triage>): string {
  const findings = prior.findings.map(finding => {
    const where = `${finding.path}${finding.line ? `:${finding.line}` : ''}`
    const mine = triage[finding.id]
    const status = finding.withdrawn
      ? `withdrawn by you: ${finding.withdrawn}`
      : finding.addressed
        ? `addressed: ${finding.addressed}`
        : mine?.state === 'dismissed'
          ? `dismissed by me${mine.reason ? `: ${mine.reason}` : ''}`
          : mine?.state === 'kept'
            ? 'kept by me'
            : 'open'
    const suggestion = finding.suggestion.trim() ? `\n  Suggestion: ${clip(finding.suggestion, 800)}` : ''

    return `#${finding.id} [${finding.severity}, ${finding.category}, ${status}] ${where}: ${finding.title}\n  ${clip(finding.body, 1200)}${suggestion}`
  })
  const said = prior.messages
    .filter(message => message.text.trim())
    .map(message => `${message.role === 'me' ? 'Me' : 'You'}: ${clip(message.text, 1500)}`)
  const lines = [
    `You reviewed this PR earlier${prior.commitId ? ` at ${prior.commitId.slice(0, 12)}` : ''}; this is a new session, so here is where that review stands. Keep the findings' numbers, and do not report them again.`,
    '',
    findings.length > 0 ? `Findings:\n${findings.join('\n')}` : 'No findings.',
  ]
  if (prior.summary) {
    lines.push('', `Your verdict: ${prior.summary.verdict}. ${prior.summary.overview}`)
  }
  if (said.length > 0) {
    lines.push('', `What we said about it:\n${said.join('\n')}`)
  }

  return lines.join('\n')
}

// Asks for a second look after new commits: settle each open finding, then review what changed.
export function rereviewPrompt(since: string | null, commits: number | null): string {
  const isCut = !!since && since.length > DIFF_LIMIT
  const lines = [
    `The PR has ${commits === null ? 'new commits' : `${commits} new commit${commits === 1 ? '' : 's'}`} since that review. Review it again:`,
    '- For each open or kept finding, check the new code: call mark_addressed when it is fixed (say how, in one sentence), update_finding when it still holds but moved or changed, and leave it alone otherwise.',
    '- Then look at the new changes for anything new and report it with report_finding.',
    '- Call report_summary with the verdict as it now stands.',
    'Then answer in two or three sentences: what was addressed, what still stands, what is new.',
    '',
  ]
  if (since) {
    lines.push(isCut ? `Changes since that review (cut at ${DIFF_LIMIT} characters):` : 'Changes since that review:', '```diff', isCut ? since.slice(0, DIFF_LIMIT) : since, '```')
  } else {
    lines.push('The changes since that review could not be isolated (the old commit may be gone after a force push); compare the findings with the current diff.')
  }

  return lines.join('\n')
}

export function followUpPrompt(text: string, refs: number[], findings: Finding[], triage: Record<number, Triage>): string {
  const lines: string[] = []
  const attached = refs.map(id => findings.find(finding => finding.id === id)).filter(finding => !!finding)
  if (attached.length > 0) {
    lines.push(`About ${attached.map(finding => `#${finding.id} (${finding.title})`).join(', ')}:`)
  }
  lines.push(text.trim())
  const kept = findings.filter(finding => triage[finding.id]?.state === 'kept').map(finding => `#${finding.id}`)
  const dismissed = findings
    .filter(finding => triage[finding.id]?.state === 'dismissed')
    .map(finding => `#${finding.id}${triage[finding.id]?.reason ? ` (${triage[finding.id]?.reason})` : ''}`)
  const stand = [kept.length > 0 ? `kept ${kept.join(', ')}` : '', dismissed.length > 0 ? `dismissed ${dismissed.join(', ')}` : ''].filter(Boolean)
  if (stand.length > 0) {
    lines.push('', `Where I stand: ${stand.join('; ')}.`)
  }

  return lines.join('\n')
}

// Commands the review may run in its checkout: they read the repo or GitHub and change nothing. Pipes and chains of
// them are fine; redirects, substitution and background jobs are not, nor flags that write files or run other programs.
const READERS: Record<string, (args: string[]) => boolean> = {
  git: ([sub, ...rest]) =>
    ['log', 'show', 'blame', 'diff', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'status', 'merge-base', 'shortlog', 'describe', 'cat-file'].includes(
      sub ?? '',
    ) && !rest.some(arg => arg.startsWith('--output') || arg.startsWith('--ext-diff') || arg.startsWith('--textconv') || arg === '-O' || arg.startsWith('--open-files-in-pager')),
  gh: ([group, sub, ...rest]) =>
    group === 'api'
      ? ![sub ?? '', ...rest].some(arg => /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/.test(arg) || /^-[XfF]./.test(arg))
      : (['pr', 'issue', 'run', 'release', 'repo'].includes(group ?? '') && ['view', 'list', 'diff', 'checks', 'status'].includes(sub ?? '')) ||
        (group === 'search' && !!sub),
  find: args => !args.some(arg => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg)),
  rg: args => !args.some(arg => arg.startsWith('--pre')),
  sort: args => !args.some(arg => arg === '-o' || arg.startsWith('--output') || /^-[^-]*o/.test(arg)),
  ...Object.fromEntries(['cd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'uniq', 'cut', 'tr', 'nl', 'file', 'stat', 'pwd', 'echo', 'jq', 'tree', 'basename', 'dirname'].map(name => [name, () => true])),
}

// root is the checkout: paths outside it, home-relative or climbing out with .. are refused too.
export function isReadOnlyCommand(command: string, root: string): boolean {
  // Redirects, substitution, escapes and line breaks are refused, then a lone & (a background job) between commands.
  if (/[<>`$\n\\(){}]/.test(command)) {
    return false
  }
  const stages = command.split(/&&|\|\||;|\|/).map(stage => stage.trim())
  if (stages.some(stage => stage.includes('&'))) {
    return false
  }

  return (
    stages.length > 0 &&
    stages.every(stage => {
      const [name, ...args] = stage.split(/\s+/).map(word => word.replace(/^(['"])(.*)\1$/, '$2'))
      const check = name ? READERS[name] : undefined
      const isInside = (arg: string) =>
        !arg.includes('~') && !/(^|[/=])\.\.([/]|$)/.test(arg) && (!/(^|=)\//.test(arg) || arg.replace(/^[^=]*=/, '') === root || arg.replace(/^[^=]*=/, '').startsWith(`${root}/`))

      return !!check && check(args) && args.every(isInside)
    })
  )
}

// What the model is doing, from one of its tool calls, in a few words for the review's status.
export function describeTool(name: string, input: Record<string, unknown>): string | null {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const short = (value: string) => (value.length > 80 ? `${value.slice(0, 79)}…` : value)
  switch (name) {
    case 'Read':
      return `Reading ${short(text('file_path'))}`
    case 'Grep':
      return `Searching for ${short(text('pattern'))}${text('path') ? ` in ${short(text('path'))}` : ''}`
    case 'Glob':
      return `Looking for ${short(text('pattern'))}`
    case 'Bash':
      return `Running ${short(text('command'))}`
    default:
      return null
  }
}

// The lines of each file that GitHub takes a comment on: those the diff shows in the new version, added or context.
export function commentableLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>()
  let lines: Set<number> | null = null
  let line = 0
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git')) {
      lines = null
    } else if (text.startsWith('+++ ')) {
      const path = text.slice(4).replace(/^b\//, '')
      lines = path === '/dev/null' ? null : new Set()
      if (lines) {
        files.set(path, lines)
      }
    } else if (text.startsWith('@@')) {
      line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0)
    } else if (lines && (text.startsWith('+') || text.startsWith(' '))) {
      lines.add(line++)
    }
  }

  return files
}

const EVENTS: Record<Verdict, string> = { approve: 'APPROVE', comment: 'COMMENT', request_changes: 'REQUEST_CHANGES' }

// The body of GitHub's create-review request. Without submit the review stays pending, for me to finish on GitHub.
export function reviewPayload(draft: ReviewDraft, submit: boolean): Record<string, unknown> {
  const inline = draft.comments.filter(comment => comment.isInline && comment.line !== null)
  const loose = draft.comments.filter(comment => !inline.includes(comment))
  const body = [draft.body.trim(), ...loose.map(comment => `**${comment.path}${comment.line ? `:${comment.line}` : ''}**\n\n${comment.body.trim()}`)]
    .filter(Boolean)
    .join('\n\n---\n\n')

  return {
    commit_id: draft.commitId,
    body,
    comments: inline.map(comment => ({ path: comment.path, line: comment.line, side: 'RIGHT', body: comment.body.trim() })),
    ...(submit ? { event: EVENTS[draft.verdict] } : {}),
  }
}

// The changes the model makes to the review, from Claude's tools or Codex's final answer. Each says what it did, for
// the model; reviewed is the commit and diff a draft is placed on, null until the PR is fetched.
export type ReviewBook = {
  report: (fields: FindingFields) => string
  revise: (id: number, changes: Partial<FindingFields>) => string
  withdraw: (id: number, reason: string) => string
  address: (id: number, how: string) => string
  summarize: (summary: ReviewSummary) => string
  draft: (verdict: Verdict, body: string, comments: { id: number; body: string }[]) => string
  suggest: (suggestions: Suggestion[]) => string
}

export type Reviewed = { commitId: string; lines: Map<string, Set<number>> }

export function reviewBook(state: ReviewState, reviewed: () => Reviewed | null, onChange: () => void): ReviewBook {
  // Changes go under the model's answer to my latest message; the review itself has none.
  const note = (change: string) => (state.turn > 0 ? state.messages.at(-1)?.changes.push(change) : undefined)
  const findingAt = (id: number) => state.findings.find(finding => finding.id === id)
  const changed = (change: string | null, result: string) => {
    if (change) {
      note(change)
    }
    onChange()

    return result
  }
  const closing = (id: number, close: (finding: Finding) => void, change: string, result: string) => {
    const finding = findingAt(id)
    if (!finding) {
      return `There is no finding #${id}.`
    }
    close(finding)
    finding.revisedTurn = state.turn

    return changed(change, result)
  }

  return {
    report: fields => {
      const id = state.findings.length + 1
      state.findings.push({ ...fields, id, turn: state.turn, revisedTurn: null, withdrawn: null, addressed: null })

      return changed(`New #${id}`, `Recorded as #${id}.`)
    },
    revise: (id, changes) => {
      const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined && value !== null))

      return closing(id, finding => Object.assign(finding, defined), `Revised #${id}`, `Revised #${id}.`)
    },
    withdraw: (id, reason) => closing(id, finding => (finding.withdrawn = reason), `Withdrew #${id}`, `Withdrew #${id}.`),
    address: (id, how) => closing(id, finding => (finding.addressed = how), `Addressed #${id}`, `Marked #${id} addressed.`),
    summarize: summary => {
      const change = state.summary ? 'Updated the summary' : null
      state.summary = summary

      return changed(change, 'Recorded.')
    },
    draft: (verdict, body, comments) => {
      const missing = comments
        .filter(comment => {
          const finding = findingAt(comment.id)

          return !finding || !isOpenFinding(finding)
        })
        .map(comment => `#${comment.id}`)
      if (missing.length > 0) {
        return `Not drafted: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not open findings.`
      }
      const placed = reviewed()
      if (!placed) {
        return 'Not drafted: the PR is not loaded yet.'
      }
      const draft: ReviewDraft = {
        revision: (state.draft?.revision ?? 0) + 1,
        verdict,
        body,
        commitId: placed.commitId,
        comments: comments.map(comment => {
          const finding = findingAt(comment.id)!

          return {
            findingId: finding.id,
            path: finding.path,
            line: finding.line,
            body: comment.body,
            isInline: finding.line !== null && !!placed.lines.get(finding.path)?.has(finding.line),
          }
        }),
      }
      state.draft = draft
      const loose = draft.comments.filter(comment => !comment.isInline).map(comment => `#${comment.findingId}`)
      const where = loose.length > 0 ? ` ${loose.join(', ')} go in the body, since the diff does not show ${loose.length === 1 ? 'its line' : 'their lines'}.` : ''

      return changed(draft.revision > 1 ? 'Revised the draft' : 'Drafted the review', `Drafted; I will check it and post it.${where}`)
    },
    // Not a change to the review, so nothing is noted under the answer. Refs to findings it does not have are dropped.
    suggest: suggestions => {
      state.suggestions = suggestions
        .filter(one => one.label.trim() && one.text.trim())
        .slice(0, SUGGESTION_LIMIT)
        .map(one => ({ label: one.label.trim(), text: one.text.trim(), refs: one.refs.filter(id => !!findingAt(id)) }))

      return changed(null, 'Shown.')
    },
  }
}

const FINDING_SCHEMA = {
  severity: { type: 'string', enum: SEVERITIES },
  category: { type: 'string', enum: CATEGORIES },
  path: { type: 'string' },
  line: { type: ['integer', 'null'] },
  title: { type: 'string' },
  body: { type: 'string' },
  suggestion: { type: 'string' },
  confidence: { type: 'string', enum: SEVERITIES },
} as const

const strict = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })

// The shape of Codex's final message each turn, strict as OpenAI's structured output wants it.
export const REVIEW_SCHEMA = strict({
  answer: { type: 'string' },
  new_findings: { type: 'array', items: strict(FINDING_SCHEMA) },
  updates: {
    type: 'array',
    items: strict({
      id: { type: 'integer' },
      ...Object.fromEntries(Object.entries(FINDING_SCHEMA).map(([key, schema]) => [key, key === 'line' ? schema : nullable(schema)])),
    }),
  },
  withdrawn: { type: 'array', items: strict({ id: { type: 'integer' }, reason: { type: 'string' } }) },
  addressed: { type: 'array', items: strict({ id: { type: 'integer' }, how: { type: 'string' } }) },
  summary: nullable(
    strict({
      verdict: { type: 'string', enum: VERDICTS },
      overview: { type: 'string' },
      risks: { type: 'array', items: { type: 'string' } },
      notChecked: { type: 'array', items: { type: 'string' } },
    }),
  ),
  draft: nullable(
    strict({
      verdict: { type: 'string', enum: VERDICTS },
      body: { type: 'string' },
      comments: { type: 'array', items: strict({ id: { type: 'integer' }, body: { type: 'string' } }) },
    }),
  ),
  suggestions: { type: 'array', items: strict({ label: { type: 'string' }, text: { type: 'string' }, refs: { type: 'array', items: { type: 'integer' } } }) },
})

type Nullable<T> = { [K in keyof T]: T[K] | null }

export type CodexTurn = {
  answer: string
  new_findings: FindingFields[]
  updates: ({ id: number } & Nullable<FindingFields>)[]
  withdrawn: { id: number; reason: string }[]
  addressed: { id: number; how: string }[]
  summary: ReviewSummary | null
  draft: { verdict: Verdict; body: string; comments: { id: number; body: string }[] } | null
  suggestions: Suggestion[]
}

// Applies Codex's final message to the review; its answer is for the caller. What did not apply is returned, so the
// model hears of it next turn.
export function applyTurn(book: ReviewBook, turn: CodexTurn): string[] {
  const results = [
    ...turn.withdrawn.map(one => book.withdraw(one.id, one.reason)),
    ...turn.addressed.map(one => book.address(one.id, one.how)),
    // A null line is "stays" here, since the schema cannot tell it from "the file as a whole".
    ...turn.updates.map(({ id, ...changes }) =>
      book.revise(id, Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null)) as Partial<FindingFields>),
    ),
    ...turn.new_findings.map(fields => book.report(fields)),
    ...(turn.summary ? [book.summarize(turn.summary)] : []),
    ...(turn.draft ? [book.draft(turn.draft.verdict, turn.draft.body, turn.draft.comments)] : []),
    book.suggest(turn.suggestions ?? []),
  ]

  return results.filter(result => result.startsWith('There is no') || result.startsWith('Not drafted'))
}
