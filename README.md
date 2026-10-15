# prs

A terminal monitor for the GitHub pull requests that involve you. It is the standalone version of the `pr-monitor` Claude Code plugin: same buckets, chips, prompts and AI report, with one poller instead of one per Claude session.

Needs [`gh`](https://cli.github.com) (logged in) and, for reports, [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex) (logged in).

## Use

```sh
prs                 # interactive view of the current repo's PRs
prs --all           # every repo involving you
prs list [--all]    # print once
prs status          # one line for a status line; reads only the cache
prs report 425      # AI status report (or owner/name#425 from anywhere)
prs digest [--all]  # AI summary of what to do first
prs team [--all]    # who reviews whom across the open PRs
```

In the view: `↑↓`/`jk` move, `⏎` folds a group (on a PR, opens it), `/` filters by number, title, author or repo (`esc` clears it), `A` switches between this repo and all repos, `D` opens the digest, `T` the team view, `u` refreshes, `S` opens the settings (the AI provider and model, saved to `~/.claude/pr-monitor.md`), `?` lists every key and symbol, `q` quits. The mouse works too: the wheel moves the selection (or scrolls a panel), a click picks a PR and a second click opens it, and a click on a group folds it; hold ⌥ (or shift) to select text. On a PR (the area above the footer shows its details and the keys that apply, grouped as copy │ view │ change │ mark, with the keys that change GitHub or git in yellow):

| Key | Does |
| --- | --- |
| `⏎` | View the PR: its description, then every comment, review and review thread (with replies) in order; in it `a` copies Ask and `v` Review / Re-review |
| `t` | Unresolved review threads, one per page, those waiting for your reply first: why it waits on you, the code it's on and every comment. In it `←→` switch thread, `r` replies (`⏎` posts), `s` resolves (asks first), `o` opens the thread on GitHub, `a` copies a prompt to draft the replies |
| `v` | Review / Re-review: copies a review prompt (Re-review includes your earlier threads) |
| `d` | Changes since your review: the new commits and the PR's files they touched |
| `a` | Ask: copies a prompt asking Claude's opinion on the PR |
| `r` | Report: an AI status report; in it `a` copies Ask with the report |
| `c` | Clean (merged PRs): copies the project's post-merge cleanup prompt |
| `m` | Merge a PR that is ready (asks first; `merge_method` in the config) |
| `R` | On your PR, ask reviewers whose last review was not an approval to review again (asks first) |
| `b` | Update a branch that is behind its base (asks first) |
| `g` | Check out the PR's branch in the current repo |
| `s` | Marks new activity as seen |
| `z` / `Z` | Snooze until new activity / until 9:00 tomorrow or new activity; `z` again wakes it |
| `o` | Opens the PR in the browser |

Panels (report, changes, digest) scroll with `↑↓`, `space`/`b` page, `g`/`G` jump to the top or bottom; `c` copies, `x` redoes, `esc` goes back.

## Team view

`T` in the view, or `prs team`, shows every open PR in the repo (with `--all`, in each repo you have PRs in), not only yours, as a matrix: a row per reviewer, a column per author, and in each cell how many of that author's PRs the reviewer is on, marked with the most urgent state (`◆` asked and waiting, `✗` changes requested, `○` commented, `✓` approved). The last column counts the requests waiting on each reviewer and how old the oldest is, red with `⚠` after two days. Below it come the longest-waiting requests and the PRs nobody has been asked to review. Drafts and bots are left out. It is one query of about 3 points, made when you open it (`x` asks again).

Prompts go to the clipboard: paste them into whichever Claude session you want. In "waiting on me" the age turns yellow after a day and red after three.

A review thread waits for your reply (`↩`, and the PR moves to "waiting on me") when it is unresolved and someone else wrote last: any thread on your PR, or one you started on someone else's. Your own comments matching `automated_comments` don't count as replies.

While open, the view checks every minute whether the poll interval passed or the branch changed, and sends a terminal notification (OSC 9: iTerm2, Ghostty, WezTerm, kitty; `herdr notification show` inside herdr) on new activity or when a PR becomes ready to merge. Clicking it focuses the terminal.

## Status line

`prs status` never calls GitHub unless you add `--fetch`, which refreshes when the cache is older than the poll interval. For Claude Code's status line, in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "prs status --color" } }
```

## Configuration

The plugin's files, merged in this order: `~/.claude/pr-monitor.md`, then the repo's `.claude/pr-monitor.md` and `.claude/pr-monitor.local.md`.

```markdown
---
poll_interval: 3m
report_provider: claude                     # claude | codex, for reports and the digest
report_model: sonnet                        # Claude's model
codex_model: gpt-6.1-sol                    # Codex's model; leave out for Codex's default
automated_comments: "^(🚀|Tests failed)"   # comments under your account that are not you
ticket_pattern: "PD-\d+"                    # links hotfix twins by ticket
twin_bases: prod, develop
flaky_checks: jenkins/e2e-tests             # failing checks shown as flaky, not blocking
merge_method: merge                         # merge | squash | rebase, for m
---

## Opinion
Guidance added to Ask and Review prompts.

## Re-review
Guidance added to Re-review prompts.

## Cleanup
Steps for the Clean prompt.

## Report focus
What the AI report should focus on.

## Digest focus
What the digest should weigh (read from the home file, or the current repo's).
```

`--all` applies each repo's own files once `prs` has been run inside that repo.

## GitHub API budget

A refresh is one GraphQL query of about 2–4 points. PRs with unresolved threads get a second query (about 2 points each) only when they changed since the last one. Inside a repo `prs` has seen before, `prs status` and cached views make no GitHub calls at all. Results are cached in `~/.claude/pr-monitor/cache/`, shared with the plugin, so the two reuse each other's fetches. Polling pauses when fewer than 300 points remain, until the budget resets; `u` still asks.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run build       # single binary at dist/prs; reports use the claude or codex on your PATH
```
