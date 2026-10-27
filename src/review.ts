import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { fetchThreads, gh, run } from './github'
import type { Config } from './lib/lib'
import { commentableLines, explainPrompt, explainSystem, followUpPrompt, priorPrompt, rereviewPrompt, reviewBook, reviewPrompt, reviewSystem } from './lib/review'
import type { ExplainStart, ReviewBook, Reviewed, ReviewInput, ReviewMessage, ReviewStart, ReviewState, Triage } from './lib/review'
import { openClaude } from './review-claude'
import { openCodex } from './review-codex'

// A review that stays open for my messages until closed.
export type ReviewSession = {
  // False once the session ended, when a message has to start a new one.
  isOpen: () => boolean
  // False once the session ended, or while the model still works on the last message.
  send: (text: string, refs: number[], triage: Record<number, Triage>) => boolean
  // Stops the model's current answer; the session stays open.
  stop: () => void
  close: () => void
}

// A model behind the review: Claude through the Agent SDK, or Codex through its CLI. It takes my messages one at a
// time, changes the review through the book, and reports back through the hooks.
export type ReviewEngine = { send: (prompt: string) => void; stop: () => void; close: () => void }
export type EngineOptions = { config: Config; dir: string | null; system: string }
export type EngineHooks = {
  // The review's changes; null for an explanation, which has no tools to change it.
  book: ReviewBook | null
  onActivity: (activity: string) => void
  // isNewBlock starts a new paragraph of the answer.
  onText: (text: string, isNewBlock: boolean) => void
  // The message was answered, or stopped by me, or failed.
  onDone: (failure: string | null, isStopped: boolean) => void
  // The model went away on its own.
  onEnd: () => void
}

// Reviews the PR with the configured provider, then keeps the session open to talk about it. Every change to the
// review, from the first finding to the model's answers, reaches onUpdate as the whole state. With root, my clone of
// the repo, the model reads the PR's code in a checkout of its head; without it, only the diff.
export function openReview(
  repo: string,
  number: number,
  config: Config,
  root: string | null,
  start: ReviewStart,
  onUpdate: (state: ReviewState) => void,
): ReviewSession {
  const state = startState(start)
  const update = () => onUpdate({ ...state, findings: [...state.findings], messages: state.messages.map(message => ({ ...message })) })
  // Shows where it starts once the caller holds the session.
  queueMicrotask(update)
  // The model's answer to my latest message, which its text goes to; none for the review itself.
  const answer = (): ReviewMessage | null => (state.turn > 0 ? (state.messages.at(-1) ?? null) : null)
  // The diff and commit reviewed, which a draft for GitHub is placed on; known once the PR is fetched.
  let reviewed: Reviewed | null = null
  const book = reviewBook(state, () => reviewed, update)
  let engine: ReviewEngine | null = null
  let worktree: Worktree | null = null
  let isClosed = false

  const finish = (failure: string | null) => {
    state.isBusy = false
    state.failure = failure
    state.activity = null
    update()
  }
  const end = () => {
    isClosed = true
    void worktree?.remove()
  }
  const hooks: EngineHooks = {
    book,
    onActivity: activity => {
      state.activity = activity
      update()
    },
    onText: (text, isNewBlock) => {
      const current = answer()
      if (!current) {
        return
      }
      current.text += (isNewBlock && current.text ? '\n\n' : '') + text
      state.activity = null
      update()
    },
    onDone: (failure, isStopped) => {
      if (isStopped) {
        answer()?.changes.push('Stopped')
      }
      finish(failure ?? (state.turn === 0 && !state.summary && state.findings.length === 0 ? 'The model reported nothing' : null))
    },
    onEnd: () => {
      end()
      if (state.isBusy) {
        finish('The review session ended')
      }
    },
  }

  void (async () => {
    const [input, checkedOut] = await Promise.all([reviewInput(repo, number), root ? checkout(root, repo, number) : null])
    worktree = checkedOut
    if (isClosed || 'failure' in input) {
      end()
      if ('failure' in input) {
        finish(input.failure)
      }
      return
    }
    reviewed = { commitId: input.headSha, lines: commentableLines(input.diff) }
    const since = start.kind === 'rereview' && state.commitId ? await changesSince(repo, state.commitId, input.headSha, worktree?.dir ?? null) : null
    state.commitId = input.headSha
    state.hasCode = !!worktree
    update()
    const kind = config.reportProvider === 'codex' ? 'codex' : 'claude'
    const options = { config, dir: worktree?.dir ?? null, system: reviewSystem(!!worktree, kind) }
    engine = kind === 'codex' ? openCodex(options, hooks) : openClaude(options, hooks)
    const pr = reviewPrompt({ ...input, guide: worktree ? await guideIn(worktree.dir) : null }, config.sections.opinion)
    engine.send(
      start.kind === 'fresh'
        ? pr
        : [
            pr,
            priorPrompt(start.prior, start.triage),
            start.kind === 'continue' ? followUpPrompt(start.text, start.refs, start.prior.findings, start.triage) : rereviewPrompt(since?.diff ?? null, since?.commits ?? null),
          ].join('\n\n'),
    )
  })()

  return {
    isOpen: () => !isClosed,
    send: (text, refs, triage) => {
      if (isClosed || state.isBusy || !engine) {
        return false
      }
      state.turn++
      state.messages.push({ role: 'me', text: text.trim(), refs, changes: [] }, { role: 'ai', text: '', refs: [], changes: [] })
      state.isBusy = true
      state.failure = null
      // They were for where the review stood; the answer brings new ones.
      state.suggestions = []
      update()
      engine.send(followUpPrompt(text, refs, state.findings, triage))

      return true
    },
    stop: () => {
      if (state.isBusy && state.turn > 0) {
        engine?.stop()
      }
    },
    close: () => {
      engine?.close()
      end()
    },
  }
}

// An explanation as it stands: what we said, the model's answer streaming into the last message.
export type ExplainState = { messages: ReviewMessage[]; isBusy: boolean; failure: string | null; hasCode: boolean | null; activity: string | null }

export type ExplainSession = {
  isOpen: () => boolean
  // False once the session ended, or while the model still answers.
  send: (text: string) => boolean
  stop: () => void
  close: () => void
}

// Explains one finding of the review, then stays open for my questions. It reads the PR's code in its own checkout
// like the review does, but cannot change the review.
export function openExplain(
  repo: string,
  number: number,
  config: Config,
  root: string | null,
  start: ExplainStart,
  onUpdate: (state: ExplainState) => void,
): ExplainSession {
  const said = (role: ReviewMessage['role'], text: string): ReviewMessage => ({ role, text, refs: [], changes: [] })
  const state: ExplainState = {
    messages: [...start.prior.map(message => ({ ...message })), ...(start.text ? [said('me', start.text.trim())] : []), said('ai', '')],
    isBusy: true,
    failure: null,
    hasCode: null,
    activity: null,
  }
  const update = () => onUpdate({ ...state, messages: state.messages.map(message => ({ ...message })) })
  queueMicrotask(update)
  let engine: ReviewEngine | null = null
  let worktree: Worktree | null = null
  let isClosed = false

  const finish = (failure: string | null) => {
    state.isBusy = false
    state.failure = failure
    state.activity = null
    update()
  }
  const end = () => {
    isClosed = true
    void worktree?.remove()
  }
  const hooks: EngineHooks = {
    book: null,
    onActivity: activity => {
      state.activity = activity
      update()
    },
    onText: (text, isNewBlock) => {
      const answer = state.messages.at(-1)!
      answer.text += (isNewBlock && answer.text ? '\n\n' : '') + text
      state.activity = null
      update()
    },
    onDone: (failure, isStopped) => {
      if (isStopped) {
        state.messages.at(-1)!.changes.push('Stopped')
      }
      finish(failure ?? (state.messages.at(-1)!.text.trim() || isStopped ? null : 'The model said nothing'))
    },
    onEnd: () => {
      end()
      if (state.isBusy) {
        finish('The session ended')
      }
    },
  }

  void (async () => {
    const [input, checkedOut] = await Promise.all([reviewInput(repo, number), root ? checkout(root, repo, number) : null])
    worktree = checkedOut
    if (isClosed || 'failure' in input) {
      end()
      if ('failure' in input) {
        finish(input.failure)
      }
      return
    }
    state.hasCode = !!worktree
    update()
    const kind = config.reportProvider === 'codex' ? 'codex' : 'claude'
    const options = { config, dir: worktree?.dir ?? null, system: explainSystem(!!worktree, kind) }
    engine = kind === 'codex' ? openCodex(options, hooks) : openClaude(options, hooks)
    engine.send(explainPrompt({ ...input, guide: worktree ? await guideIn(worktree.dir) : null }, start))
  })()

  return {
    isOpen: () => !isClosed,
    send: text => {
      if (isClosed || state.isBusy || !engine) {
        return false
      }
      state.messages.push(said('me', text.trim()), said('ai', ''))
      state.isBusy = true
      state.failure = null
      update()
      engine.send(text.trim())

      return true
    },
    stop: () => {
      if (state.isBusy) {
        engine?.stop()
      }
    },
    close: () => {
      engine?.close()
      end()
    },
  }
}

async function reviewInput(repo: string, number: number): Promise<ReviewInput | { failure: string }> {
  const [viewed, diff, threads] = await Promise.all([
    gh(['pr', 'view', String(number), '--repo', repo, '--json', 'title,body,author,baseRefName,headRefName,headRefOid']),
    gh(['pr', 'diff', String(number), '--repo', repo]),
    fetchThreads(repo, number),
  ])
  if (viewed.exitCode !== 0) {
    return { failure: viewed.stderr.trim() || 'gh pr view failed' }
  }
  if (diff.exitCode !== 0) {
    return { failure: diff.stderr.trim() || 'gh pr diff failed' }
  }
  const pr = JSON.parse(viewed.stdout) as { title: string; body: string; author: { login: string }; baseRefName: string; headRefName: string; headRefOid: string }

  return {
    repo,
    number,
    title: pr.title,
    author: pr.author.login,
    body: pr.body,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    headSha: pr.headRefOid,
    diff: diff.stdout,
    threads: threads?.threads ?? [],
    guide: null,
  }
}

// The first state of a session: empty for a new review; else the earlier one with my message, or the re-review's, under way.
function startState(start: ReviewStart): ReviewState {
  const fresh = { isBusy: true, failure: null, hasCode: null, activity: null }
  if (start.kind === 'fresh') {
    return { ...fresh, findings: [], summary: null, messages: [], turn: 0, draft: null, commitId: null, suggestions: [] }
  }
  const { prior } = start
  const mine =
    start.kind === 'continue'
      ? { role: 'me' as const, text: start.text.trim(), refs: start.refs, changes: [] }
      : { role: 'me' as const, text: 'Review the new commits', refs: [], changes: [] }

  return {
    ...fresh,
    findings: prior.findings.map(finding => ({ ...finding, addressed: finding.addressed ?? null })),
    summary: prior.summary,
    messages: [...prior.messages.map(message => ({ ...message })), mine, { role: 'ai', text: '', refs: [], changes: [] }],
    turn: prior.turn + 1,
    // A draft from before new commits would post on the old ones.
    draft: start.kind === 'continue' ? prior.draft : null,
    commitId: prior.commitId,
    suggestions: [],
  }
}

// What the commits since the reviewed one changed, from the checkout or else GitHub; null when that commit is gone
// (a force push) or nothing could tell.
async function changesSince(repo: string, from: string, to: string, dir: string | null): Promise<{ diff: string; commits: number | null } | null> {
  const [diff, count] = dir
    ? await Promise.all([run(['git', 'diff', `${from}..${to}`], dir), run(['git', 'rev-list', '--count', `${from}..${to}`], dir)])
    : await Promise.all([
        gh(['api', '-H', 'Accept: application/vnd.github.diff', `repos/${repo}/compare/${from}...${to}`]),
        gh(['api', `repos/${repo}/compare/${from}...${to}`, '--jq', '.total_commits']),
      ])

  return diff.exitCode === 0 ? { diff: diff.stdout, commits: count.exitCode === 0 ? Number(count.stdout.trim()) : null } : null
}

type Worktree = { dir: string; remove: () => Promise<void> }

// The checkouts of the reviews open in this process; any other is left from one that quit mid-review.
const checkouts = new Set<string>()

async function removeLeftovers(root: string) {
  const listed = await run(['git', 'worktree', 'list', '--porcelain'], root)
  const dirs = listed.stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
    .filter(dir => basename(dir).startsWith('prs-review-') && !checkouts.has(dir))
  await Promise.all(dirs.map(dir => run(['git', 'worktree', 'remove', '--force', dir], root)))
  await run(['git', 'worktree', 'prune'], root)
}

// A detached checkout of the PR's head beside my clone, so the review reads the code without touching my working
// tree; null when it cannot be made, and the review reads only the diff.
async function checkout(root: string, repo: string, number: number): Promise<Worktree | null> {
  // The remote that is the PR's repo, which is not origin in a fork's clone.
  const remotes = await run(['git', 'remote', '-v'], root)
  const remote =
    remotes.stdout
      .split('\n')
      .map(line => line.split(/\s+/))
      .find(([, url]) => !!url && url.toLowerCase().replace(/\.git$/, '').endsWith(repo.toLowerCase()))?.[0] ?? 'origin'
  const fetched = await run(['git', 'fetch', '--no-tags', '--quiet', remote, `pull/${number}/head`], root)
  const head = fetched.exitCode === 0 ? await run(['git', 'rev-parse', 'FETCH_HEAD'], root) : null
  if (!head || head.exitCode !== 0) {
    return null
  }
  await removeLeftovers(root)
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'prs-review-')))
  const added = await run(['git', 'worktree', 'add', '--detach', '--quiet', dir, head.stdout.trim()], root)
  checkouts.add(dir)
  const remove = async () => {
    await run(['git', 'worktree', 'remove', '--force', dir], root)
    checkouts.delete(dir)
  }
  if (added.exitCode !== 0) {
    await remove()
    return null
  }

  return { dir, remove }
}

// The checkout's instructions for agents, read as text: the model follows its conventions but does not run anything from it.
async function guideIn(dir: string): Promise<string | null> {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = Bun.file(join(dir, name))
    if (await file.exists()) {
      return file.text()
    }
  }

  return null
}
