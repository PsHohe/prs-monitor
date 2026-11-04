# Team PRs

A desktop app for the GitHub pull requests that involve you: what is waiting on you, what is ready to merge, and an AI report and review for any of them. It is an Electrobun app (system webview, Bun main process).

## Install

Download it from the [latest release](https://github.com/PsHohe/prs-monitor/releases/latest), for macOS (Apple Silicon), Linux (x64) or Windows (x64). It updates itself.

Needs [`gh`](https://cli.github.com) (logged in) and, for the AI features, [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex) (logged in).

## Repos

The repo selector shows every repo involving you (the default) or one repo you added by picking its local clone; one repo uses that clone's config files and its branch. The added repos and the active one are saved in `~/.claude/pr-monitor/desktop.json`.

## AI report and settings

The AI report card in a PR's detail writes a status report, on demand, with the provider and model from your `report_provider`/`report_model`/`codex_model` settings. It streams in, keeps being written while you look at another PR, and says so once the PR has changed since. Settings (⚙ at the bottom of the list, or `⌘,`) turns each AI provider on or off for this app (with both off, the report and every AI feature are gone; a provider that is off falls back to the other), picks the provider and the report's model, and the AI review's own model and effort (`review_model`, `review_effort`; opus and high by default, since a full review deserves more than a quick report), saved to `~/.claude/pr-monitor.md`, and can turn on writing the report on its own when you open a PR waiting on you (saved in `desktop.json`). Reports last while the app runs.

## Files

The Files tab (`f`) shows the PR's changed files as a tree (folders with one folder inside are joined, each file with its status and +/−) beside every file's diff stacked in the tree's order, like GitHub's Files changed: old and new line numbers, a header that stays on top while you scroll its file and folds it with a click (files over 800 changed lines start folded), a click in the tree scrolls to the file, and the tree marks the file you are reading; it is fetched with `gh pr diff` when the tab opens and again once the PR changes.

## AI review

The AI review tab (`v`) has Claude read the PR's diff, its description and the review threads already on it, and file findings one at a time. When the repo has a clone (added with Add repo…, or remembered from the archived CLI), the review gets a temporary checkout of the PR's head beside it (a detached git worktree, removed when the review ends, so your working tree is untouched) and reads the code like Claude Code would: it can open any file, search, and run read-only commands, alone, piped or chained (git log/show/blame/diff, gh views and GET API calls, cd, ls, cat, grep…). Anything that writes, runs the project's code or reads outside the checkout is refused, and the checkout's own Claude settings and hooks are not loaded; its CLAUDE.md or AGENTS.md is passed along as the repo's conventions. While it works, the panel shows what it is reading or running. Without a clone it reviews the diff only and says so. Each finding is a card with its severity, category, file and line (a click opens it in the PR's files on GitHub), confidence, and why and a suggested fix to expand. Keep or dismiss each one (with an optional reason); dismissed ones fold away. A summary on top gives the recommended verdict, the risk areas and what the review could not check.

Once the review is done you can talk to it underneath. Tick findings to attach them to your next message (they show as chips above the box; `⌘↵` sends), or click a button: Verify (re-checks the ticked findings, or every open one, and withdraws those that do not hold up), or one of the next steps the model suggests (✦) after the review and after each answer, specific to the PR and where the conversation stands, which sends it with the findings it is about (shift-click puts it in the box to edit first; the last ones are kept with the review). Each message also tells the model what you kept and dismissed, with your reasons, so it does not raise those again. The model answers briefly and changes the cards rather than repeating them: new and revised cards are marked for its latest answer, withdrawn ones move to "set aside" with its reason, and the changes listed under its answer scroll to their card. To post it, ask for it ("post a review with these", or the Draft review quick action with findings ticked, or by default those you kept): the model drafts it and a Review for GitHub card shows the verdict, the body and one comment per finding, each on its line when the diff shows that line (GitHub refuses others) and in the body otherwise. Edit any of it, leave comments out, then Create pending review (only you see it until you submit it on GitHub; GitHub allows one per PR) or Submit with the verdict; both ask first, and the model never posts anything itself. Stop interrupts an answer; Review again starts over and clears the conversation and your triage, asking first when there is any to lose. The review uses the provider picked in Settings. With Codex, it runs `codex exec` with its own login in a read-only sandbox on the checkout (no writes, no network, web search, plugins or browser off), with the Codex model from Settings and the review's effort (max becomes xhigh); follow-ups resume the same Codex thread. Codex has no tools for the review, so its findings and changes arrive together when each turn ends, while what it reads and runs streams meanwhile. Codex still loads your own Codex skills and `~/.codex/AGENTS.md`, and its sessions are kept in `~/.codex/sessions` so they can be resumed.

Reviews are saved on this machine (`~/.claude/pr-monitor/reviews/`, one file per PR, dropped after a month untouched) with your triage and the draft, so they come back after a restart. The model's session does not: writing to a saved review, or to one whose session ended, starts a new session that is given the findings (keeping their numbers), where you stand on each and what was said, and carries on. When the PR gets new commits, Re-review checks every open finding against them (fixed ones are marked addressed with how, and fold away with the set-aside ones), reviews what changed since the reviewed commit, and updates the verdict; your triage stays, and the draft is cleared since it was for the old commits.

## Window and keys

The window has no title bar: the app's own top bar moves it, and double-clicking it does what your OS does on a title bar. The list on the left and the actions for the selected PR on the right can be resized by dragging their edges, and hidden with the buttons in the top bar or `[` and `]`; their widths are remembered per machine. On a smaller window the actions panel narrows, then hides, so the PR keeps room. PRs that need you (waiting on you, ready to merge) get a full row with why; the rest a compact one. Folded groups are remembered per machine. Keys: `↑↓`/`jk` move, `⏎` opens the detail on a narrow window (`esc` goes back), `o` opens the PR on GitHub, `m` merges it once GitHub would (approved, required checks passed, no conflicts; anyone's PR, after asking, with your `merge_method`), `u` refreshes, `c`/`t`/`f` switch between the Conversation, Threads and Files tabs, `r` replies to the first thread waiting on you (`⌘↵` posts, `esc` closes; unsent drafts are kept while the app runs), `g` writes the AI report (and does nothing while the report is still current; Rewrite does it on purpose), `v` opens the AI review tab (pressed there, it starts a review if there is none), `z` snoozes a PR until new activity and `Z` until 9:00 tomorrow or new activity (`z` wakes it; snoozed PRs wait in their own group at the bottom).

A PR you pick stops being new once you have looked at it for a moment with the window in front: the dot goes while it is selected, and when you move on or leave the window it is marked as seen, so it leaves "waiting on me" unless something else still needs you. The PR selected on its own at launch does not count until you pick it.

## Configuration

Settings writes the common ones. The files are merged in this order: `~/.claude/pr-monitor.md`, then the repo's `.claude/pr-monitor.md` and `.claude/pr-monitor.local.md`. "All repos" applies each repo's own files once you have added the repo with Add repo….

```markdown
---
poll_interval: 3m                           # read when the app starts
report_provider: claude                     # claude | codex
report_model: sonnet                        # Claude's model for reports
codex_model: gpt-6.1-sol                    # Codex's model; leave out for Codex's default
review_model: opus                          # Claude's model for the AI review
review_effort: high
automated_comments: "^(🚀|Tests failed)"   # comments under your account that are not you
ticket_pattern: "PD-\d+"                    # links hotfix twins by ticket
twin_bases: prod, develop
flaky_checks: jenkins/e2e-tests             # failing checks shown as flaky, not blocking
merge_method: merge                         # merge | squash | rebase, for m
---

## Opinion
Guidance added to the AI review.

## Report focus
What the AI report should focus on.
```

## GitHub API budget

A refresh is one GraphQL query of about 2–4 points. PRs with unresolved threads get a second query (about 2 points each) only when they changed since the last one. Results are cached in `~/.claude/pr-monitor/cache/`, shared with the `pr-monitor` Claude Code plugin, so running both does not cost extra quota. Polling pauses when fewer than 300 points remain, until the budget resets; `u` still asks.

## Develop

Needs [Bun](https://bun.sh) and [Hutch](https://hutch.blackboard.sh) (`npx electrobun` installs it).

```sh
bun install             # the core's dependencies
bun test                # the core's and the app's tests
bun run typecheck       # the core

cd desktop
bun run typecheck       # the app
hutch run install       # the app's dependencies
hutch run dev           # build and launch, rebuilding on changes
hutch run build         # stable build in build/
```

- `desktop/src/bun/index.ts`: main process; window, RPC handlers, polling
- `desktop/src/mainview/`: React UI in the webview; imports only the pure `src/lib/` and types
- `desktop/src/shared/rpc.ts`: the RPC schema both sides share
- `desktop/src/shared/attention.ts`: why a PR needs you, in words (tested in `desktop/tests/`)
- `src/`: the core the app imports: GitHub queries and cache, PR buckets, config, AI report and review engines (tested in `tests/`)
- `archive/cli/`: the former `prs` terminal app, frozen at v0.2.1; see [its README](archive/cli/README.md)
