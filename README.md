# brief-hub

**English** | [简体中文](./README.zh-CN.md)

A local **brief hub** for every AI session on your machine: each session publishes a tagged brief when a task finishes, other sessions subscribe by **tags**, automatically read what is relevant to them, mark it consumed, and never check it again.

The single design goal: **coordination that costs almost no tokens**.

**Standalone first**: the hub, the CLI and the protocol need **no AI tool at all** — `bh publish` / `bh sub add` / `bh digest` work on their own. The pi / Claude Code / Codex / opencode integrations are *optional* adapters that are wired in only when that tool is detected.

## What it solves

When you run several AI sessions in parallel they are blind to each other: session A changes a GitHub repo or a system config, while session B (the one that "owns" GitHub or "owns" PC tuning) never learns about it. brief-hub is a publish/subscribe channel that only puts content into a context **when it is actually relevant**.

## How it works

```
session A finishes ──► publishes a tagged brief ──► ~/.ai-brief-hub/briefs/YYYY-MM-DD.jsonl
                                                          │
session B (subscribed to git/config) ──► polls; pure-code tag match ──► matched briefs
                                          delivered as a title digest + marked consumed
                                                          │
                                        next poll: the same brief is never detected again
```

## The six token-saving mechanisms

| Mechanism | How | Effect |
|---|---|---|
| **Zero-token matching** | tag set operations + arithmetic scoring, no model call | deciding relevance is free |
| **Zero extra tokens on publish** | title/facts are derived from artifacts the session already produced (changed paths, commands, error text) — no LLM summarisation | publishing is free |
| **Headline first** | level 1 delivers only a title digest (measured ≈17 tokens per brief); the body is fetched on demand with `bh read <id>` | irrelevant content never enters the context |
| **Incremental reads** | the cursor is a **per-file byte offset**; when a file has not grown, nothing is read and nothing is injected | idle sessions cost ~0 |
| **Coalescing** | same dedupe key within a 10-minute window merges into one entry (20 pushes → 1 brief) | no notification storms |
| **Hourly budget** | default 2000 tokens/hour; overflow is queued by score and reported as a single "N more not expanded" line | bursts cannot swamp the context |

The first run **only aligns the cursor and delivers no history** (so you never get a flood of old briefs).

## Install

```bash
bash setup.sh
```

It creates `~/.ai-brief-hub/`, installs the `bh` command, and wires the adapters of whichever AI tools it detects (pi / Claude Code / Codex / opencode). Nothing else is required — Node >= 24 is the only dependency.

## Usage

```bash
bh doctor                                   # self-check: dirs, command, detected harnesses
bh publish --tool manual --sess-id demo --title "first brief" --changed a.txt
bh sub add git config --sess=<session>      # subscribe by domain tag
bh sub add "repo:owner/name" --sess=<session>
bh sub add sev:err --sess=<session>         # errors only
bh digest --sess=<session>                  # print pending digest (marks it consumed)
bh list --unread --sess=<session>
bh read <id>                                # full brief
bh status                                   # hub overview: briefs / subs / per-consumer unread + budget
bh poll --sess=<session>                    # run one polling round manually (debugging)
```

## Tag system

| Namespace | Examples | Source |
|---|---|---|
| Domain | `git` `git.push` `git.commit` `config` `deps` `system` `github` `pi.config` | derived from executed commands and changed paths |
| Repo | `repo:owner/name` | `.git/config` of the session directory |
| Project | `proj:<dir>` | working directory name |
| Tool / session | `tool:pi` `sess:<name>` | session metadata |
| Severity | `sev:err` `sev:warn` `sev:info` | error ⇒ err |
| Event kind | `task.done` `task.error` `git.push` | event type |

**Subscribing to a parent matches its children**: subscribing to `git` also receives `git.push` / `git.commit`.

## Harness coverage (cross-AI)

The core is harness-agnostic; each AI only needs a thin adapter.

| Harness | Publish | Consume | Status |
|---|---|---|---|
| **pi** | extension `brief-publisher` (auto on finish / error) | extension `brief-subscriber` (poll → title digest → `/hub`) | implemented |
| **Claude Code** | hook `adapters/claude/hook.mjs` (`PostToolUse` accumulates → `Stop`/`SessionEnd` publishes; parses the session JSONL as a fallback) | same hook, `UserPromptSubmit` branch: prints the digest to stdout, which Claude injects as context | implemented (needs `disableAllHooks: false`) |
| **Codex** | `notify` hook: `adapters/codex/notify.mjs` (Codex passes the `agent-turn-complete` JSON as the last argv; the adapter also mines the rollout for tool facts) | `bh digest` (or run it yourself) | implemented |
| **opencode** | plugin `adapters/opencode/plugin.js` (`session.idle` / `session.error`) | same plugin, `chat.message`: injects the digest into `output.parts` before the message is sent | implemented |
| any other CLI | `bh publish --tool=<name> --sess-id=<id> …` | `bh digest --sess=<id>` | implemented (generic contract) |

### Adding a harness in three steps

1. **Publish** — turn that harness' facts into a `SessionSnapshot` (changed paths / commands / error / cwd / session id) and call `bh publish` (or `bh publish-from <session-file> --harness <name>`); the core handles tag derivation and dedupe.
2. **Consume** — call `bh digest --sess=<that session id>`; matching, budget, coalescing and consumed-marking already happen inside. Inject it wherever the harness allows (before a user message, on idle), otherwise let the human run it.
3. **Subscribe** — `bh sub add git config --sess=<that session id>`. All harnesses share the same subscription data (`~/.ai-brief-hub/subs/`).

## Environment variables

| Variable | Effect |
|---|---|
| `BRIEF_HUB=0` | disable publishing and subscribing completely |
| `BRIEF_HUB_HOME` | repository directory (default `~/brief-hub`) |
| `BRIEF_HUB_HOME_OVERRIDE` | override the **data** directory (default `~/.ai-brief-hub`; used by tests) |

## Architecture (every file ≤200 lines)

```
src/schema.ts       data model + defaults (pure)
src/tags.ts         tag derivation, hierarchy, scoring (pure)
src/brief.ts        brief construction (pure, zero extra tokens)
src/match.ts        delivery plan: filter/score/coalesce/budget + rendering (pure)
src/transcript.ts   cross-harness fact extraction (tool-call accumulation, Codex payload, generic JSONL)
src/inbox.ts        one polling round (io)
src/store.ts        append-only JSONL + cursor reads (io)
src/store-config.ts subscriptions / state / config / stats (io)
src/cli.ts          CLI commands
src/cli-support.ts  argument parsing, reading helpers, doctor
extensions/         two pi extensions (publisher / subscriber)
adapters/claude/    Claude Code hook + idempotent settings merge
adapters/codex/     Codex notify hook
adapters/opencode/  opencode plugin
test/               31 cases (pure logic + adapter end-to-end with a temp hub)
```

## Verification

```bash
node --test test/*.test.js      # 31/31
```

Cross-harness round trip (real run):

```
[1] Claude SessionStart          -> subscription created for that session
[2] another session publishes    -> published b-…-f8b1 [git.push] new Codex/opencode adapters
[3] Claude UserPromptSubmit      -> brief hub: 1 relevant  - [git.push] … (b-…-f8b1)
[4] again                        -> (no output)   <- already consumed, not repeated
[5] bh status                    -> consumer claude-live-…: unread 0 · consumed 1 · budget 16
```

Standalone check (temporary HOME, no AI tool installed): `setup.sh` created the hub, installed `bh`, wired 0 AI adapters, and the CLI round trip worked.

## Boundaries

- Local only; cross-machine is out of scope for v1 (a git-backed or ntfy transport could be added later)
- Brief titles are rule-generated (no model call); titles ≤60 chars, at most 3 facts — bounded by design
- A consumer only ever sees briefs inside its own subscription; everything else never enters a context

## License

MIT
