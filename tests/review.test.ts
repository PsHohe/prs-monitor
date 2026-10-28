import { expect, test } from 'bun:test'

import { mergeConfig } from '../src/lib/lib'
import { applyTurn, assessmentOf, commentableLines, DIFF_LIMIT, explainPrompt, explainSystem, EXPLAIN_SCHEMA, findingText, REVIEW_SCHEMA, reviewBook, describeTool, followUpPrompt, isReadOnlyCommand, priorPrompt, rereviewPrompt, revisedPrompt, reviewPayload, reviewPrompt, reviewSystem } from '../src/lib/review'
import type { CodexTurn, Finding, ReviewDraft, ReviewInput, ReviewState } from '../src/lib/review'

const INPUT: ReviewInput = {
  repo: 'acme/app',
  number: 7,
  title: 'Retry the sync job',
  author: 'dana',
  body: 'Adds a retry.',
  baseRef: 'main',
  headRef: 'retry',
  headSha: 'abc123',
  diff: '+retry()',
  threads: [],
  guide: null,
}

const finding = (id: number, title: string): Finding => ({
  id,
  severity: 'medium',
  category: 'bug',
  path: 'src/sync.ts',
  line: 10,
  title,
  body: '',
  suggestion: '',
  confidence: 'high',
  turn: 0,
  revisedTurn: null,
  withdrawn: null,
  addressed: null,
})

test('the review prompt carries the PR, its diff and the guidance', () => {
  const prompt = reviewPrompt(INPUT, 'Prefer small functions.')
  expect(prompt).toContain('PR acme/app#7: Retry the sync job')
  expect(prompt).toContain('By dana, merging retry into main.')
  expect(prompt).toContain('No review threads yet.')
  expect(prompt).toContain('+retry()')
  expect(prompt).toEndWith('Project guidance:\nPrefer small functions.')
})

test('the review prompt lists current threads only, so the model does not repeat them', () => {
  const comments = [{ author: 'lee', body: 'Why  a\nretry?', at: '' }]
  const prompt = reviewPrompt({
    ...INPUT,
    threads: [
      { path: 'src/sync.ts', line: 4, isResolved: true, isOutdated: false, comments },
      { path: 'src/old.ts', line: 1, isResolved: false, isOutdated: true, comments },
    ],
  })
  expect(prompt).toContain('- src/sync.ts:4 (resolved)\n  lee: Why a retry?')
  expect(prompt).not.toContain('src/old.ts')
})

test('a diff past the limit is cut and the model is told', () => {
  const prompt = reviewPrompt({ ...INPUT, diff: 'x'.repeat(DIFF_LIMIT + 10) })
  expect(prompt).toContain(`Diff (cut at ${DIFF_LIMIT} of ${DIFF_LIMIT + 10} characters; the rest was not shown):`)
  expect(prompt).not.toContain('x'.repeat(DIFF_LIMIT + 1))
})

test('a message names the attached findings and where my triage stands', () => {
  const findings = [finding(1, 'Retry is not idempotent'), finding(2, 'No test'), finding(3, 'Log level')]
  const prompt = followUpPrompt('  Is this reachable?  ', [1, 9], findings, {
    2: { state: 'kept', reason: '' },
    3: { state: 'dismissed', reason: 'we log at debug on purpose' },
  })
  expect(prompt).toBe(
    'About #1 (Retry is not idempotent):\nIs this reachable?\n\nWhere I stand: kept #2; dismissed #3 (we log at debug on purpose).',
  )
})

test('a message with nothing attached or triaged is just the text', () => {
  expect(followUpPrompt('Look for more.', [], [finding(1, 'A')], {})).toBe('Look for more.')
})

test('the review has its own model and effort, and an unknown effort keeps the default', () => {
  expect(mergeConfig([])).toMatchObject({ reviewModel: 'opus', reviewEffort: 'high' })
  expect(mergeConfig([{ values: { review_model: 'fable', review_effort: 'max' }, sections: {} }])).toMatchObject({ reviewModel: 'fable', reviewEffort: 'max' })
  expect(mergeConfig([{ values: { review_effort: 'extreme' }, sections: {} }]).reviewEffort).toBe('high')
})

test("the review prompt carries the repo's instructions for agents", () => {
  const prompt = reviewPrompt({ ...INPUT, guide: '# Conventions\n\nUse tabs.' })

  expect(prompt).toContain("The repo's instructions for agents")
  expect(prompt).toContain('# Conventions\n\nUse tabs.')
})

test('the system prompt says whether the model can read the code', () => {
  expect(reviewSystem(true)).toContain('checkout of the PR')
  expect(reviewSystem(false)).toContain('you cannot read other files')
})

const ROOT = '/tmp/prs-review-abc'

test('read-only commands in the checkout are allowed', () => {
  for (const command of [
    'git log --oneline -20 -- src/sync.ts',
    'git diff main...HEAD --stat',
    'git blame -L 10,20 src/sync.ts',
    'gh pr view 7 --json files',
    'gh api repos/acme/app/pulls/7/comments',
    'grep -rn "retry" src | head -20',
    `cat ${ROOT}/src/sync.ts`,
    'find src -name "*.test.ts"',
    'ls -la',
    'git log --oneline -5 && git status --short | head -20',
    `cd ${ROOT}/src && grep -n retry sync.ts; wc -l sync.ts`,
  ]) {
    expect(isReadOnlyCommand(command, ROOT)).toBe(true)
  }
})

test('commands that write, chain, run code or leave the checkout are refused', () => {
  for (const command of [
    'git checkout main',
    'git push',
    'git diff --output=/tmp/x',
    'gh pr review 7 --approve',
    'gh pr comment 7 --body hi',
    'gh api -X POST repos/acme/app/issues',
    'gh api repos/acme/app/issues -f title=x',
    'ls; rm -rf .',
    'cat a && rm a',
    'git status; rm -rf .',
    'cat a & rm a',
    'cd /etc && cat passwd',
    'ls | xargs rm',
    'echo hi > file',
    'cat $(echo x)',
    'find . -delete',
    'find . -exec rm {} +',
    'rg --pre ./run.sh x',
    'sort -o out in',
    'bun test',
    'npm install',
    'cat /etc/passwd',
    'cat ~/.ssh/id_rsa',
    'cat ../../secret',
    `cat ${ROOT}-other/file`,
  ]) {
    expect(isReadOnlyCommand(command, ROOT)).toBe(false)
  }
})

test('tool calls read as what the model is doing', () => {
  expect(describeTool('Read', { file_path: 'src/sync.ts' })).toBe('Reading src/sync.ts')
  expect(describeTool('Grep', { pattern: 'retry', path: 'src' })).toBe('Searching for retry in src')
  expect(describeTool('Bash', { command: 'git log -5' })).toBe('Running git log -5')
  expect(describeTool('mcp__review__report_finding', {})).toBeNull()
})

const DIFF = `diff --git a/src/sync.ts b/src/sync.ts
index 1..2 100644
--- a/src/sync.ts
+++ b/src/sync.ts
@@ -10,4 +10,5 @@ export function sync() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 return a
@@ -40,2 +41,2 @@
 x
+y
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`

test('comments go on the lines the diff shows in the new version', () => {
  const lines = commentableLines(DIFF)

  expect([...(lines.get('src/sync.ts') ?? [])]).toEqual([10, 11, 12, 13, 41, 42])
  expect(lines.has('old.ts')).toBe(false)
})

const DRAFT: ReviewDraft = {
  revision: 1,
  verdict: 'request_changes',
  body: 'Solid retry, two issues.',
  commitId: 'abc123',
  comments: [
    { findingId: 1, path: 'src/sync.ts', line: 11, body: 'Off by one.', isInline: true },
    { findingId: 2, path: 'src/db.ts', line: 90, body: 'Missing index.', isInline: false },
  ],
}

test('a submitted review carries its verdict; a pending one does not', () => {
  const submitted = reviewPayload(DRAFT, true)

  expect(submitted.event).toBe('REQUEST_CHANGES')
  expect(submitted.commit_id).toBe('abc123')
  expect(submitted.comments).toEqual([{ path: 'src/sync.ts', line: 11, side: 'RIGHT', body: 'Off by one.' }])
  expect('event' in reviewPayload(DRAFT, false)).toBe(false)
})

test("comments off the diff go in the review's body", () => {
  expect(reviewPayload(DRAFT, false).body).toBe('Solid retry, two issues.\n\n---\n\n**src/db.ts:90**\n\nMissing index.')
})

const PRIOR: ReviewState = {
  findings: [
    { ...finding(1, 'Retries forever'), suggestion: 'Cap it at 3.' },
    { ...finding(2, 'No test for the retry'), withdrawn: 'The test exists in sync.test.ts' },
    finding(3, 'Logs the token'),
    { ...finding(4, 'Swallows the error'), addressed: 'Now rethrown' },
  ],
  summary: { verdict: 'request_changes', overview: 'Adds a retry.', risks: [], notChecked: [] },
  messages: [
    { role: 'me', text: 'Is #1 real?', refs: [1], changes: [] },
    { role: 'ai', text: 'Yes, nothing caps it.', refs: [], changes: [] },
  ],
  turn: 1,
  isBusy: false,
  failure: null,
  hasCode: true,
  activity: null,
  draft: null,
  commitId: 'abcdef1234567890',
  suggestions: [],
}

test('a new session carries the earlier findings, where I stand on them and what we said', () => {
  const prompt = priorPrompt(PRIOR, { 1: { state: 'kept', reason: '' }, 3: { state: 'dismissed', reason: 'It is a test token' } })

  expect(prompt).toContain('at abcdef123456')
  expect(prompt).toContain('#1 [medium, bug, kept by me] src/sync.ts:10: Retries forever')
  expect(prompt).toContain('Suggestion: Cap it at 3.')
  expect(prompt).toContain('#2 [medium, bug, withdrawn by you: The test exists in sync.test.ts]')
  expect(prompt).toContain('#3 [medium, bug, dismissed by me: It is a test token]')
  expect(prompt).toContain('#4 [medium, bug, addressed: Now rethrown]')
  expect(prompt).toContain('Your verdict: request_changes. Adds a retry.')
  expect(prompt).toContain('Me: Is #1 real?\nYou: Yes, nothing caps it.')
})

test('a re-review gets the changes since, or says they could not be isolated', () => {
  expect(rereviewPrompt('+fix()', 2)).toContain('2 new commits')
  expect(rereviewPrompt('+fix()', 2)).toContain('```diff\n+fix()\n```')
  expect(rereviewPrompt(null, null)).toContain('could not be isolated')
})

const fresh = (): ReviewState => ({ ...structuredClone(PRIOR), findings: [finding(1, 'Retries forever'), finding(2, 'Logs the token')], turn: 1, draft: null })

test('the book changes the review and notes it under the latest answer', () => {
  const state = fresh()
  let changes = 0
  const book = reviewBook(state, () => ({ commitId: 'abc', lines: new Map([['src/sync.ts', new Set([10])]]) }), () => changes++)

  expect(book.report({ ...finding(0, 'Leaks a handle'), path: 'src/io.ts', line: 3 })).toBe('Recorded as #3.')
  expect(book.withdraw(2, 'It is redacted')).toBe('Withdrew #2.')
  expect(book.revise(1, { severity: 'high', line: undefined })).toBe('Revised #1.')
  expect(book.address(9, 'gone')).toBe('There is no finding #9.')
  expect(state.findings.map(one => [one.id, one.severity, one.line, !!one.withdrawn])).toEqual([[1, 'high', 10, false], [2, 'medium', 10, true], [3, 'medium', 3, false]])
  expect(state.messages.at(-1)?.changes).toEqual(['New #3', 'Withdrew #2', 'Revised #1'])
  expect(changes).toBe(3)
})

test('a draft takes open findings only, inline where the diff shows the line', () => {
  const state = fresh()
  const book = reviewBook(state, () => ({ commitId: 'abc', lines: new Map([['src/sync.ts', new Set([10])]]) }), () => {})
  book.withdraw(2, 'It is redacted')

  expect(book.draft('comment', 'Looks fine.', [{ id: 2, body: 'x' }])).toBe('Not drafted: #2 is not open findings.')
  expect(book.draft('comment', 'Looks fine.', [{ id: 1, body: 'Cap it.' }])).toBe('Drafted; I will check it and post it.')
  expect(state.draft?.comments).toEqual([{ findingId: 1, path: 'src/sync.ts', line: 10, body: 'Cap it.', isInline: true }])
})

const TURN: CodexTurn = {
  answer: 'Done.',
  new_findings: [{ severity: 'low', category: 'docs', path: 'README.md', line: null, title: 'Stale docs', body: '', suggestion: '', confidence: 'medium' }],
  updates: [{ id: 1, severity: 'high', category: null, path: null, line: null, title: null, body: null, suggestion: null, confidence: null }],
  withdrawn: [],
  addressed: [{ id: 2, how: 'Now redacted' }, { id: 7, how: '?' }],
  summary: { verdict: 'comment', overview: 'Fine.', risks: [], notChecked: [] },
  draft: null,
  suggestions: [{ label: 'Check the retry', text: 'Does #1 also hit the CLI?', refs: [1] }],
}

test("Codex's final message applies like the tools, and says what did not", () => {
  const state = fresh()
  const unapplied = applyTurn(reviewBook(state, () => null, () => {}), TURN)

  expect(unapplied).toEqual(['There is no finding #7.'])
  expect(state.findings.map(one => [one.id, one.severity, one.line, one.addressed])).toEqual([[1, 'high', 10, null], [2, 'medium', 10, 'Now redacted'], [3, 'low', null, null]])
  expect(state.summary?.overview).toBe('Fine.')
  expect(state.suggestions).toEqual([{ label: 'Check the retry', text: 'Does #1 also hit the CLI?', refs: [1] }])
})

test('suggestions replace the last ones, capped, without empty ones or unknown findings, and note no change', () => {
  const state = fresh()
  const book = reviewBook(state, () => null, () => {})
  const one = (label: string, refs: number[] = []) => ({ label, text: `${label}?`, refs })
  book.suggest([one('Old')])
  book.suggest([one(' Check #1 ', [1, 9]), { label: 'Blank', text: ' ', refs: [] }, one('B'), one('C'), one('D')])

  expect(state.suggestions).toEqual([{ label: 'Check #1', text: 'Check #1 ?', refs: [1] }, one('B'), one('C')])
  expect(state.messages.at(-1)?.changes).toEqual([])
})

test("Codex's schema is strict: every object requires all its properties", () => {
  const objects: Record<string, unknown>[] = []
  const walk = (value: unknown) => {
    if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>
      if (node.type === 'object') {
        objects.push(node)
      }
      Object.values(node).forEach(walk)
    }
  }
  walk(REVIEW_SCHEMA)

  expect(objects.length).toBeGreaterThan(5)
  for (const node of objects) {
    expect(node.additionalProperties).toBe(false)
    expect(node.required).toEqual(Object.keys(node.properties as object))
  }
})

test('the Codex system prompt maps the tools to its final message', () => {
  expect(reviewSystem(true, 'codex')).toContain('no network')
  expect(reviewSystem(true, 'codex')).toContain('new_findings (report_finding')
  expect(reviewSystem(true, 'claude')).not.toContain('new_findings')
})

test('an explanation is told it reads the code but cannot change the review', () => {
  expect(explainSystem(true)).toContain('checkout of the PR')
  expect(explainSystem(true)).toContain('You cannot change the review')
  expect(explainSystem(true)).not.toContain('report_finding')
  expect(explainSystem(false)).toContain('you cannot read other files')
  expect(explainSystem(true, 'codex')).toContain('no network')
})

test('the explanation prompt carries the PR, the finding and where I stand on it', () => {
  const one = { ...finding(3, 'The retry never stops'), body: 'It loops forever.', suggestion: 'Cap it at 3.' }
  const summary = { verdict: 'request_changes' as const, overview: 'Adds a retry.', risks: [], notChecked: [] }
  const prompt = explainPrompt(INPUT, { finding: one, summary, triage: { state: 'dismissed', reason: 'tested by hand' }, prior: [], assessed: null, text: null })
  expect(prompt).toContain('+retry()')
  expect(prompt).toContain('#3 (medium severity, bug, high confidence) at src/sync.ts:10: The retry never stops')
  expect(prompt).toContain('Suggested fix:\nCap it at 3.')
  expect(prompt).toContain('I dismissed it: tested by hand.')
  expect(prompt).toContain("The review's verdict: request_changes. Adds a retry.")
  expect(prompt).toEndWith('Explain this finding.')
})

test('an explanation carried on from an ended session hears what we said, then my question', () => {
  const said = (role: 'me' | 'ai', text: string) => ({ role, text, refs: [], changes: [] })
  const prompt = explainPrompt(INPUT, {
    finding: finding(1, 'Leak'),
    summary: null,
    triage: null,
    prior: [said('ai', 'It leaks the handle.'), said('me', ''), said('me', 'Where?')],
    assessed: { verdict: 'refined', settled: 'applied' },
    text: 'And on retry?',
  })
  expect(prompt).toContain('What we said:\nYou: It leaks the handle.\n\nMe: Where?')
  expect(prompt).toContain('I have not decided on it yet.')
  expect(prompt).toContain('You assessed it as refined. I applied your revision')
  expect(prompt).toEndWith('And on retry?')
})

test('the explanation gives its verdict with assess_finding, or in its JSON on Codex', () => {
  expect(explainSystem(true)).toContain('call assess_finding once')
  expect(explainSystem(true)).not.toContain('final message')
  expect(explainSystem(true, 'codex')).toContain('final message')
  expect(Object.keys(EXPLAIN_SCHEMA.properties)).toEqual(['answer', 'assessment'])
})

test('a verdict keeps only the fields a refined finding changes', () => {
  const revision = { severity: 'low' as const, category: null, path: null, line: null, title: 'Narrower', body: null, suggestion: null, confidence: null }
  expect(assessmentOf({ verdict: 'refined', note: ' Overstated. ', revision })).toEqual({ verdict: 'refined', note: 'Overstated.', revision: { severity: 'low', title: 'Narrower' } })
  expect(assessmentOf({ verdict: 'disputed', note: 'Wrong.', revision })).toEqual({ verdict: 'disputed', note: 'Wrong.', revision: null })
  expect(assessmentOf({ verdict: 'refined', note: 'Same.', revision: { title: null } }).revision).toBeNull()
})

test('the review hears of findings I revised from their explanations', () => {
  const prompt = revisedPrompt([{ ...finding(2, 'Narrower'), body: 'Only one note.' }])
  expect(prompt).toStartWith('I revised a finding after a closer look')
  expect(prompt).toContain('#2 [medium, bug, revised by me] src/sync.ts:10: Narrower\n  Only one note.')
})

test('a copied finding carries where it is, what it says and the fix', () => {
  const one = { ...finding(2, 'The retry never stops'), body: 'It loops forever.\n', suggestion: 'Cap it at 3.' }
  expect(findingText(one)).toBe(
    '**The retry never stops**\nmedium severity · bug · high confidence · `src/sync.ts:10`\n\nIt loops forever.\n\n**Suggested fix**\n\nCap it at 3.',
  )
  expect(findingText({ ...one, suggestion: '' })).not.toContain('Suggested fix')
})
