# brief-hub

**English** | [简体中文](./README.zh-CN.md)

A local **brief hub** for the AI sessions on one machine: every session publishes a tagged brief when a task finishes, other sessions subscribe by **tags**, automatically read what concerns them, and never see it twice.

Coordination that costs almost no tokens. The hub, the CLI and the protocol need **no AI tool at all** — the pi / Claude Code / Codex / opencode integrations are optional adapters.

## What it solves

Several AI sessions running side by side are blind to each other. One changes a GitHub repo or a system config; the session that "owns" GitHub or PC tuning never learns about it. brief-hub is a publish/subscribe channel that puts content into a context **only when it is relevant**, and keeps the bill small.

## How it works

```
session A finishes ──► tagged brief ──► ~/.ai-brief-hub/briefs/YYYY-MM-DD.jsonl   (archive)
                                            └─► shards/<tag>.jsonl                (shared index)
session B (subscribed) ──► pure-code tag match ──► title digest injected ──► marked consumed
                                                          └─ next poll: never detected again
```

## One kind: the change brief

There is a single brief kind, `change`. It is published when a session **modified files in a folder** (or when a task-level failure occurred) — running commands alone no longer produces a brief.

- Title: `change <folder> · N files` (+ `· pushed` when the change was pushed)
- Tag: `dir:<folder>` — subscribe to a folder, e.g. `bh sub add dir:src --sess=<id>`
- Severity still separates signal: `info` (normal change), `warn` (tool-level failure), `err` (task-level failure)

## Noise control

The failure mode of any notification system is that noise crowds out signal. Three gates, all in the core so **every harness inherits them**:

| Class | Examples | What happens |
|---|---|---|
| **noise** | `[object Object]`, `[rtk] … No hook installed`, `SyntaxWarning`, `unexpected EOF`, `Could not find edits[0]`, `Dangerous command blocked`, our own maintenance commands, multi-line `123: code` output | **dropped** — no brief at all |
| **tool** | `ENOENT`, `EACCES`, timeouts, permission errors | published as `sev:warn` → lands in "check" / "fyi", never in "must handle" |
| **task** | `npm ERR!`, test `FAIL`, `Traceback`, `exit code N` | published as `sev:err` → must handle |

Other waste that was measured and removed:

- **Self-briefs are suppressed**: a session never receives a brief it published itself.
- **The receiver protocol is sent once**; later injections use a one-line header (saves ~120 tokens each time).
- **First-run alignment is explicit** (`alignedAt`), so a hub that is empty at alignment time no longer swallows the next batch.
- **`bh purge`** removes historical noise for good: the matching briefs are written to a file, that file goes to the **OS recycle bin**, then the archive and shards are rewritten. Sessions' `unread` lists are cleaned too.
- **`bh status --orphans`** lists briefs nobody ever handled — the way to find a remaining noise source.

## The token budget

| Mechanism | How | Effect |
|---|---|---|
| Zero-token matching | tag set operations + arithmetic scoring, no model call | deciding relevance is free |
| Zero extra tokens on publish | titles and facts are derived from artifacts the session already produced | publishing is free |
| Headline first | level 1 delivers a title digest (measured ≈17 tokens per brief); bodies come on demand via `bh read <id>` | irrelevant content never enters the context |
| Incremental reads | per-file **byte cursors**; a file that did not grow is not read at all | idle sessions cost ~0 |
| Coalescing | same dedupe key inside a 10-minute window merges (20 pushes → 1 brief) | no notification storms |
| Hourly budget | 2000 tokens/hour by default; overflow is queued by score and reported as a count | bursts cannot swamp a context |

Measured on 8 subscribers with 20 briefs arriving one per minute:

| Mode | Injections | Tokens |
|---|---|---|
| `immediate` | 152 | 3120 |
| `auto` (fanout ≥ 4 → hourly batching) | **8** | **160** |

## Scaling: fanout batching + shared shards

**Delivery.** When a brief's tags have **≥ 4 subscribers** (`fanoutBatchK`), `auto` subscriptions switch to hourly batching: one digest per hour, top 3 titles expanded, the rest counted. Errors (`sev:err`) and briefs addressed to a session (`sess:<name>`) are always immediate.

**IO.** Publishing writes each brief once into `shards/<tag>.jsonl` (along its tag chain), so every subscriber of a tag reads **the same file** instead of re-scanning the archive. A shard whose `size`/`mtime` is unchanged is skipped entirely.

Measured (8 subscribers × 20 briefs):

| Metric | Before | After |
|---|---|---|
| Bytes read | 853,248 | **77,768** |
| 160 idle polls | — | **0 bytes read, 160 shards skipped** |

## Receiver protocol

Injection arrives on the session's **next turn** (extensions cannot wake an idle session). Each brief is classified for the receiver:

| Class | Trigger | Expectation |
|---|---|---|
| **act** | `sev:err`, addressed by `sess:`, carries a suggested action | must handle; errors cannot merely be deferred |
| **check** | same repo / same directory / exact tag hit | read the body and verify |
| **fyi** | parent-tag hit, stale entry | read and move on |

```bash
bh read <id>                          # full brief: facts / artifacts / suggested action / source
bh handle <id> --note "conclusion"    # handled: never surfaces again
bh defer <id>                         # defer: resurfaces after 4 hours
bh pending --sess=<id>                # current queue, grouped by class
```

## Install

```bash
bash setup.sh
```

Creates `~/.ai-brief-hub/`, installs the `bh` command (bash + cmd), and wires the adapters of whichever AI tools it detects. Node ≥ 24 is the only dependency.

| Harness | Publish | Consume |
|---|---|---|
| **pi** | extension `brief-publisher` (on settle / error) | extension `brief-subscriber` (injects on the next turn, `/hub`) |
| **Claude Code** | hook `adapters/claude/hook.mjs` (`PostToolUse` accumulates → `Stop`/`SessionEnd` publishes) | same hook, `UserPromptSubmit` prints the digest (needs `disableAllHooks: false`) |
| **Codex** | `notify` hook `adapters/codex/notify.mjs` (payload is the last argv; also mines the rollout) | `bh digest` |
| **opencode** | plugin `adapters/opencode/plugin.js` (`session.idle` / `session.error`) | same plugin, `chat.message` injects into `output.parts` |
| anything else | `bh publish --tool=<name> --sess-id=<id> …` | `bh digest --sess=<id>` |

Adding a harness: turn its facts into a snapshot and call `bh publish` (or `bh publish-from <file> --harness <name>`); call `bh digest --sess=<id>` to consume; `bh sub add <tag> --sess=<id>` to subscribe. Tag derivation, noise filtering, coalescing, budget and consumed-marking all happen in the core.

## Usage

```bash
bh doctor                             # self-check: dirs, command, detected harnesses
bh status                             # overview: briefs, subscriptions, per-consumer unread + budget
bh status --orphans                   # briefs nobody handled (find noise sources)
bh list [--unread] [--sess=<id>]      # recent briefs (bounded tail read)
bh read <id>                          # full brief
bh publish --tool manual --sess-id demo --title "first brief" --changed a.txt [--tag system]
bh sub add git config "repo:owner/name" --sess=<id>
bh digest --sess=<id>                 # print pending digest and mark it consumed
bh poll --sess=<id>                   # one polling round (debugging)
bh purge --noise                      # preview: drop noise-class briefs
bh purge --noise --yes                # execute: purged briefs go to the OS recycle bin
bh purge --kind task.error --before 2026-09-22 --yes
```

## Tag system

| Namespace | Examples | Derived from |
|---|---|---|
| Domain | `git`, `git.push`, `config`, `deps`, `system`, `github`, `pi.config` | executed commands, changed paths |
| Repo | `repo:owner/name` | `.git/config` of the session directory |
| Project | `proj:<dir>` | working directory name |
| Tool / session | `tool:pi`, `sess:<name>` | session metadata |
| Severity | `sev:err`, `sev:warn`, `sev:info` | error classification |
| Kind | `change` (single kind) | folder change |

Subscribing to a parent matches its children: `git` also receives `git.push` / `git.commit`.

## Environment variables

| Variable | Effect |
|---|---|
| `BRIEF_HUB=0` | disable publishing and subscribing |
| `BRIEF_HUB_HOME` | repository directory (default `~/brief-hub`) |
| `BRIEF_HUB_HOME_OVERRIDE` | override the **data** directory (default `~/.ai-brief-hub`) |

## Architecture

```
src/schema.ts        data model + defaults (pure)
src/tags.ts          tag derivation, hierarchy, scoring (pure)
src/errors.ts        failure-text extraction + noise/tool/task classification (pure)
src/brief.ts         brief construction, noise filtering, shouldPublish (pure)
src/match.ts         delivery plan: filter/score/coalesce/budget, digest rendering (pure)
src/handling.ts      receiver protocol: classify / shouldSurface / renderProtocol (pure)
src/purge.ts         purge selection + JSONL line stripping (pure)
src/transcript.ts    cross-harness fact extraction (Codex payload, generic JSONL)
src/shards.ts        tag shards: write once, many readers, mtime skip
src/inbox.ts         one polling round (io)
src/store.ts         append-only JSONL + cursor reads (io)
src/store-config.ts  subscriptions / state / config / fanout index / stats (io)
src/recycle.ts       move a file to the OS recycle bin
src/inject.ts        injection wording shared by all harnesses
src/cli.ts           CLI commands
src/cli-support.ts   argument parsing, readers, doctor, orphans, purge
extensions/          pi publisher + subscriber
adapters/            Claude hook · Codex notify · opencode plugin
test/                58 cases (pure logic + adapter end-to-end on a temp hub)
```

## Verification

```bash
node --test test/*.test.js      # 58/58
```

Cross-harness round trip (real run): a pi session publishes → a Claude session's `UserPromptSubmit` prints `1 relevant`, marks it consumed, and the next round prints nothing. Standalone check (temporary `HOME`, no AI tool installed): `setup.sh` created the hub, installed `bh`, wired 0 adapters, and the CLI round trip worked.

## Boundaries

- Local only; cross-machine transport is out of scope (a git-backed or ntfy transport could be added).
- Titles are rule-generated, ≤60 chars, at most 3 facts — no model call.
- A consumer only ever sees briefs inside its own subscription.
- Extensions cannot wake an idle session; delivery happens on its next turn.

## License

MIT
