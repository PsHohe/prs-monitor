import type { ThreadDetail } from './lib'
import { codeAccess, reviewPrompt } from './review'
import type { Engine, ReviewInput } from './review'

// Answering the review threads that wait on me: for each, the model says whether the code should change, with a spec
// to hand to a coding agent or a developer, or drafts the reply I could post. Pure, so the webview can import it.

export const PLAN_ACTIONS = ['change', 'reply'] as const
export type PlanAction = (typeof PLAN_ACTIONS)[number]

// thread is the thread's number in the prompt, from 1; summary is one sentence to me on what it asks and the call.
export type PlanFields = { thread: number; action: PlanAction; summary: string; reply: string; spec: string }

// A plan as the app keeps it, by the thread's GitHub id.
export type ThreadPlan = { threadId: string; action: PlanAction; summary: string; reply: string; spec: string }

// The answers so far. count is how many threads they are for; commitId the PR's head they were drafted at.
export type AddressState = {
  plans: ThreadPlan[]
  count: number
  isBusy: boolean
  failure: string | null
  hasCode: boolean | null
  activity: string | null
  commitId: string | null
}

// Codex has no tool to plan a thread: its final message carries the plans, as JSON in ADDRESS_SCHEMA's shape.
const CODEX_PLANS = `You have no tools for this. Wherever these instructions say to call plan_thread, put the same in your final message instead, which is JSON in the given schema: plans (one per thread, in order) and answer ("Done.").`

export function addressSystem(hasCode: boolean, isMine: boolean, engine: Engine = 'claude'): string {
  const output = engine === 'codex' ? `\n\n${CODEX_PLANS}` : ''
  const choices = isMine
    ? `- change, when the point holds and the code should change. spec is a change spec in markdown for a coding agent or a developer who has not seen the thread: what to change and where (files, functions, lines), why (the reviewer's point, in a sentence), how (the approach, with a short code sketch when it helps), and how to tell it is done (what to test or check). Keep it to what the thread asks. reply is empty: I reply once the change is pushed.
- reply, when no code change is needed: the code already handles it, the point does not hold, it is out of scope, or it is a question to answer. reply is what I would post, written as me to the reviewer: direct, friendly and specific, a few sentences, quoting the code when it helps. spec is empty.`
    : `- reply, always: I reviewed this PR and its author or someone else answered my comment. reply is what I would post, written as me: accept the answer, follow up on what is still open, or hold my point and say why. spec is empty.`

  return `You are a senior engineer helping me answer the review threads that wait for my reply on a pull request ${isMine ? 'I wrote' : 'I am reviewing'}. ${codeAccess(hasCode, engine)}

For each thread under "Threads to answer", check the point against the ${hasCode ? 'code' : 'diff'} and call plan_thread once, in order, with one of:
${choices}

summary is one sentence to me: what the thread asks and your call. Do not agree just to please the reviewer, nor brush off a valid point. When the answer needs a decision only I can make, say so in summary and draft a reply that asks or proposes. When you are unsure, say so in summary.

When every thread has its plan, answer "Done." and nothing else.${output}`
}

export function addressPrompt(input: ReviewInput, owed: ThreadDetail[]): string {
  const threads = owed.map((thread, index) => {
    const where = `${thread.path}${thread.line ? `:${thread.line}` : ''}${thread.isOutdated ? ' (outdated: the code changed since)' : ''}`
    const hunk = thread.diffHunk.split('\n').slice(1).slice(-8).join('\n')
    const comments = thread.comments.map(comment => `${comment.author}:\n${comment.body.trim()}`).join('\n\n')

    return `Thread ${index + 1}, on ${where}\n${hunk ? `\`\`\`diff\n${hunk}\n\`\`\`\n` : ''}${comments}`
  })

  return [reviewPrompt(input), '', 'Threads to answer:', '', threads.join('\n\n---\n\n')].join('\n')
}

// Keeps the model's plan for a thread, replacing one it gave before; what it did, for the model.
export function recordPlan(state: AddressState, owed: ThreadDetail[], isMine: boolean, plan: PlanFields): string {
  const thread = owed[plan.thread - 1]
  if (!thread) {
    return `There is no thread ${plan.thread}.`
  }
  if (plan.action === 'change' && !isMine) {
    return `Thread ${plan.thread} is on a PR I am reviewing, so it can only be a reply.`
  }
  const kept: ThreadPlan = { threadId: thread.id, action: plan.action, summary: plan.summary.trim(), reply: plan.reply.trim(), spec: plan.spec.trim() }
  state.plans = [...state.plans.filter(one => one.threadId !== thread.id), kept]

  return `Recorded thread ${plan.thread}.`
}

// The change specs as one document to paste into a coding agent or hand to a developer: the PR, then each change
// with the thread it answers.
export function specText(pr: { repo: string; number: number; title: string; headRef: string }, items: { plan: ThreadPlan; thread: ThreadDetail }[]): string {
  const changes = items.map(({ plan, thread }, index) => {
    const where = `${thread.path}${thread.line ? `:${thread.line}` : ''}`
    const heading = items.length > 1 ? `## ${index + 1}. ${where}` : `## ${where}`

    return [heading, '', plan.spec, '', `From review thread: ${thread.url}`].join('\n')
  })
  const intro =
    items.length > 1
      ? `Changes asked for in review on ${pr.repo}#${pr.number} (${pr.title}), branch \`${pr.headRef}\`. Make each one, then check it as it says.`
      : `A change asked for in review on ${pr.repo}#${pr.number} (${pr.title}), branch \`${pr.headRef}\`. Make it, then check it as it says.`

  return [intro, '', changes.join('\n\n')].join('\n')
}

// The shape of Codex's final message, strict as OpenAI's structured output wants it.
export const ADDRESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'plans'],
  properties: {
    answer: { type: 'string' },
    plans: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['thread', 'action', 'summary', 'reply', 'spec'],
        properties: {
          thread: { type: 'integer' },
          action: { type: 'string', enum: PLAN_ACTIONS },
          summary: { type: 'string' },
          reply: { type: 'string' },
          spec: { type: 'string' },
        },
      },
    },
  },
} as const

export type CodexAddressTurn = { answer: string; plans: PlanFields[] }
