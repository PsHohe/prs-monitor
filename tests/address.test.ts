import { expect, test } from 'bun:test'

import { ADDRESS_SCHEMA, addressPrompt, addressSystem, recordPlan, specText } from '../src/lib/address'
import type { AddressState } from '../src/lib/address'
import type { ThreadDetail } from '../src/lib/lib'
import type { ReviewInput } from '../src/lib/review'

const thread = (id: string, path: string, line: number | null, body: string): ThreadDetail => ({
  id,
  path,
  line,
  isResolved: false,
  isOutdated: false,
  comments: [{ author: 'ana', body, at: '2026-10-27T10:00:00Z' }],
  diffHunk: '@@ -1,2 +1,2 @@\n-old\n+new',
  url: `https://github.com/o/r/pull/1#discussion_${id}`,
  canReply: true,
  canResolve: true,
})

const owed = [thread('T1', 'src/a.ts', 10, 'Handle the null case'), thread('T2', 'src/b.ts', null, 'Why not a map?')]
const empty = (): AddressState => ({ plans: [], count: 2, isBusy: true, failure: null, hasCode: true, activity: null, commitId: null })
const input: ReviewInput = { repo: 'o/r', number: 1, title: 'Fix it', author: 'me', body: '', baseRef: 'main', headRef: 'fix', headSha: 'abc', diff: '', threads: owed, guide: null }

test('a plan is kept by thread id, and a later one for the same thread replaces it', () => {
  const state = empty()
  expect(recordPlan(state, owed, true, { thread: 1, action: 'change', summary: ' Agree ', reply: '', spec: 'Add a guard' })).toBe('Recorded thread 1.')
  expect(recordPlan(state, owed, true, { thread: 1, action: 'reply', summary: 'Already handled', reply: 'It is checked in c.ts', spec: '' })).toBe('Recorded thread 1.')
  expect(state.plans).toEqual([{ threadId: 'T1', action: 'reply', summary: 'Already handled', reply: 'It is checked in c.ts', spec: '' }])
})

test('a plan for a thread that does not exist, or a change on a PR I review, is refused', () => {
  const state = empty()
  expect(recordPlan(state, owed, true, { thread: 3, action: 'reply', summary: '', reply: 'x', spec: '' })).toBe('There is no thread 3.')
  expect(recordPlan(state, owed, false, { thread: 1, action: 'change', summary: '', reply: '', spec: 'x' })).toContain('can only be a reply')
  expect(state.plans).toEqual([])
})

test('the prompt numbers the threads to answer with their code and comments', () => {
  const prompt = addressPrompt(input, owed)
  expect(prompt).toContain('Threads to answer:')
  expect(prompt).toContain('Thread 1, on src/a.ts:10')
  expect(prompt).toContain('Thread 2, on src/b.ts\n')
  expect(prompt).toContain('+new')
  expect(prompt).toContain('ana:\nWhy not a map?')
})

test('only my own PR offers changes', () => {
  expect(addressSystem(true, true)).toContain('- change, when')
  expect(addressSystem(true, false)).not.toContain('- change, when')
  expect(addressSystem(false, true, 'codex')).toContain('final message')
})

test('specs read as one document with each thread they answer', () => {
  const pr = { repo: 'o/r', number: 1, title: 'Fix it', headRef: 'fix' }
  const plan = (threadId: string, spec: string) => ({ threadId, action: 'change' as const, summary: '', reply: '', spec })
  const one = specText(pr, [{ plan: plan('T1', 'Add a guard'), thread: owed[0]! }])
  expect(one).toStartWith('A change asked for in review on o/r#1 (Fix it), branch `fix`.')
  expect(one).toContain('## src/a.ts:10\n\nAdd a guard\n\nFrom review thread: https://github.com/o/r/pull/1#discussion_T1')
  const both = specText(pr, [
    { plan: plan('T1', 'Add a guard'), thread: owed[0]! },
    { plan: plan('T2', 'Use a map'), thread: owed[1]! },
  ])
  expect(both).toContain('## 1. src/a.ts:10')
  expect(both).toContain('## 2. src/b.ts\n')
})

test("Codex's schema is strict: every property required, no others", () => {
  const item = ADDRESS_SCHEMA.properties.plans.items
  expect([...item.required].sort() as string[]).toEqual(Object.keys(item.properties).sort())
  expect(item.additionalProperties).toBe(false)
})
