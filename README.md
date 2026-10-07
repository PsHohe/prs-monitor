# prs

A terminal monitor for the GitHub pull requests that involve you. It is the standalone version of the `pr-monitor` Claude Code plugin: same buckets, chips, prompts and AI report, with one poller instead of one per Claude session.

Needs [`gh`](https://cli.github.com) (logged in) and, for reports, [Claude Code](https://claude.com/claude-code) (logged in).

## Use

```sh
prs                 # interactive view of the current repo's PRs
prs --all           # every repo involving you
prs list [--all]    # print once
prs status          # one line for a status line; reads only the cache
prs report 425      # AI status report (or owner/name#425 from anywhere)
```

In the view: `↑↓`/`jk` move, `⏎` folds a group, `u` refreshes, `q` quits. On a PR:

| Key | Does |
| --- | --- |
| `v` | Review / Re-review: copies a review prompt (Re-review includes your earlier threads) |
| `a` | Ask: copies a prompt asking Claude's opinion on the PR |
| `c` | Clean (merged PRs): copies the project's post-merge cleanup prompt |
| `r` | Report: an AI status report; in it `a` copies Ask with the report, `c` copies the report, `x` redoes it |
| `s` | Marks new activity as seen |
| `o` | Opens the PR in the browser |

Prompts go to the clipboard: paste them into whichever Claude session you want.

While open, the view checks every minute whether the poll interval passed or the branch changed, and sends a macOS notification on new activity or when a PR becomes ready to merge.

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
report_model: sonnet
automated_comments: "^(🚀|Tests failed)"   # comments under your account that are not you
ticket_pattern: "PD-\d+"                    # links hotfix twins by ticket
twin_bases: prod, develop
flaky_checks: jenkins/e2e-tests             # failing checks shown as flaky, not blocking
---

## Opinion
Guidance added to Ask and Review prompts.

## Re-review
Guidance added to Re-review prompts.

## Cleanup
Steps for the Clean prompt.

## Report focus
What the AI report should focus on.
```

`--all` applies each repo's own files once `prs` has been run inside that repo.

## GitHub API budget

A refresh is one GraphQL query of about 2–4 points. Results are cached in `~/.claude/pr-monitor/cache/`, shared with the plugin, so the two reuse each other's fetches. Polling pauses when fewer than 300 points remain, until the budget resets; `u` still asks.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run build       # single binary at dist/prs; reports use the claude on your PATH
```
