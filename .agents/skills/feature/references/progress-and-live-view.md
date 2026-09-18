# Progress and live view

Three surfaces report a run. All read the same durable state, so none can
drift from another or from the worktree. There is ONE progress ledger; a new
surface is a new reader of it, never a second file.

- **Terminal block** — a rendered step ladder printed at every phase boundary.
- **Status line** — one line, always visible between boundaries:
  `/feature 54% ▸ 4 execute 1/3`.
- **Live view** — a local page showing that ladder plus the Claude/Codex
  review exchange as it arrives.

Neither surface owns a fact. `state.json` owns phase, branch, SHAs and review
round counters. `gate-status.json` and the fingerprint own gate truth.
`progress.json` owns only the step ladder and the tracer list.
`review-transcript.jsonl` owns only the turns that have no other sink.

## Step ladder

Eight steps map to the workflow sections in `SKILL.md`:

| Step | Id | Set to `done` when |
|---|---|---|
| 0 | `orient` | classification is fixed |
| 1 | `intake` | `validate-intake.mjs` passes and the user signs off |
| 2 | `armed` | `arm-check.sh` reports `ARMED` |
| 3 | `plan` | the plan is approved (`transition-state.mjs plan_approved`) |
| 4 | `execute` | every tracer bullet is `done` |
| 5 | `gate` | `verified-gate.sh --review` is green and the fingerprint is current |
| 6 | `review` | every finding carries `ACCEPT` or `REJECT` |
| 7 | `ready` | the review-ready report is delivered |

Marking a step `done` opens the next one automatically. The ladder belongs to
guarded runs; lightweight runs create no ladder. Use `blocked` when the run
stops at an authority boundary; the terminal note carries the reason.

The percentage is derived, never stored. Each step contributes one eighth.
An active step contributes half, except `execute`, which contributes its own
tracer ratio, so the bar advances tracer by tracer.

### Commands

```bash
node .agents/skills/feature/scripts/progress.mjs init --size standard --risk high --surface backend
node .agents/skills/feature/scripts/progress.mjs step intake done --note "rev 2 · signed off"
node .agents/skills/feature/scripts/progress.mjs carry <parent-repo-root>
node .agents/skills/feature/scripts/progress.mjs tracers set "T1 gate constant|T2 veto window|T3 judge precondition"
node .agents/skills/feature/scripts/progress.mjs tracer T2 active
node .agents/skills/feature/scripts/progress.mjs render
node .agents/skills/feature/scripts/progress.mjs cost
```

Every write command prints the block, so a phase boundary is one command, not
two. Use `render` when nothing changed — on resume, or when the user asks
where the run stands.

### Status line

`progress.mjs statusline [<repo-root>]` prints the current step on one line,
for a status bar that refreshes constantly and from any directory:

```text
/feature 54% ▸ 4 execute 1/3      the active step; execute shows its tracer ratio
/feature 69% ▸ 5 gate (running)   while .feature/gate-heartbeat.json exists
/feature 63% ✗ 5 gate blocked     a blocked step outranks an active one
/feature 100% ✓ done
```

It prints NOTHING and exits 0 when no ladder exists, outside a repository, or
over a half-written `progress.json` — an error here would replace the whole
bar on every refresh; `render` reports the same state loudly. It skips the
fingerprint check (which spawns a process), so the gate's freshness is the
block's job, not the bar's. About 35 ms.

Wiring is per machine, not per repository. In Claude Code, the `statusLine`
command in `~/.claude/settings.json` calls it when
`<root>/.feature/progress.json` exists, passing the root so it need not `cd`:

```bash
node "$ROOT/.agents/skills/feature/scripts/progress.mjs" statusline "$ROOT" 2>/dev/null
```

Lightweight Codex runs create no ladder, so they show nothing here by design.

### Phase cost

Initialize native Codex runs with `progress.mjs init ... --runtime codex`.
Their phase-cost output explicitly says unavailable; this helper does not
read native Codex usage. Never substitute another Claude session's bill.
The accounting below applies only to Claude runs.

Marking a step `done` also prints that step's token bill, and `cost` (or the
standalone `scripts/phase-cost.mjs`) prints the whole table:

```
 intake locked      1.2M in (94% cached) ·   9K out ·  38 min · 41 turns
 plan approved      3.1M in (96% cached) ·  22K out ·  55 min · 88 turns  (2 sessions summed)
```

The numbers are derived, never entered: the ladder owns WHEN each step
closed, the harness transcripts under `~/.claude/projects/<slug>/` own how
much every model turn cost, and `lib/phase-cost.mjs` joins the two. A step's
bill is every assistant turn between the previous step's close and its own;
an open step shows its cost so far. Work before `init` is not measured, so
the `orient` row is always empty. Turns are deduplicated by message id.
Subagent turns are included; Codex rounds run elsewhere and are not.

Steps 0-1 run in the parent checkout, whose transcript directory every
session on the repo shares. When `.feature/sessions` exists only those
sessions count; otherwise every session whose cwd is the root counts and the
row says how many it summed — read such a row as an upper bound. The table is
cached at `.feature/phase-cost.json` so the handoff can cite it. Its purpose
is the post-merge read-back in the routers' step 8: after five runs the most
expensive step is the next thing to trim.

`carry` exists because steps 0 and 1 run before the worktree does. It reads
the parent checkout's ladder, writes it into the current worktree, and marks
`armed` done. Run it once, from the worktree, right after `arm-check.sh`
reports `ARMED`. It never deletes the parent copy; `.feature/` is gitignored,
so the orphan is harmless.

## Review transcript

Native Codex reviews use `attach-review --id <agent-or-session-id> --report
<report.md>` after completion. It stores the reviewer ID and report in the
durable transcript, so snapshots and resume need no companion installation.
Root turns use `say --actor codex`; a ladder initialized with runtime codex
also selects that actor by default.

For Claude codex-companion jobs only, `attach-codex --job <exact-id>` records
a pointer to the job files. Never use `--latest`: it can select a different
run. Root turns and triage verdicts are written here in either runtime.

```bash
L=".agents/skills/feature/scripts/review-log.mjs"

node $L round-start --axis plan-skeptic
node $L say --text "Plan rev 2 sent. 9 tracer bullets, surface locked to 4 files."
node $L attach-review --id <reviewer-id> --report <completed-report.md>
node $L finding --id F1 --severity high --title "Veto window keys on sent_at" --at "worker/jobs/publisher/veto-window.ts:212"
node $L triage --id F1 --verdict ACCEPT --reason "Reproduced: delivery lag opens a silent 15-min gap."
node $L round-end --verdict REVISE
node $L render
```

Rules the scripts enforce:

- `triage` refuses an unknown finding id. Log the finding before triaging it.
- `triage --verdict ACCEPT` also appends the finding (title, location,
  reason, branch, date) to the committed per-axis checklist
  `docs/reviews/finding-checklists/<axis>.md`, deduped by title. Future
  reviews on that axis receive the file — the feedback loop that stops every
  review from starting at zero. See [review-prompts.md](review-prompts.md).
- `round-end` refuses a round with no logged turns, findings, or codex jobs —
  an empty round would bless a review that left no record.
- `round-start` warns when the live view is not running.
- The open round is the highest `round-start` with no `round-end`. Every
  command without `--round` lands in that round.
- `attach-codex` resolves the codex-companion job by workspace root, so it
  works from any worktree without knowing how the companion names its state
  directory.

Axes: `plan-skeptic`, `spec-correctness`, `standards-maintainability`,
`security`, `database`, `billing`, `async`, `ui`. They match
[review-prompts.md](review-prompts.md); do not invent a ninth.

## Live view

```bash
node .agents/skills/feature/scripts/live-view.mjs start     # prints the URL
node .agents/skills/feature/scripts/live-view.mjs status
node .agents/skills/feature/scripts/live-view.mjs stop
```

The server binds `127.0.0.1` only, defaults to port 7717, and steps forward
up to 20 ports when that one is taken. It holds no state: every poll rebuilds
the view from disk, so it survives a compaction, a resume, or a restart of
this session. It is a viewer, never a writer.

Start it before the first review round. Stop it at step 7, or when the user
asks. A stale registration after a crash is cleared by `stop`.

### Publishing the record

```bash
node .agents/skills/feature/scripts/live-view.mjs snapshot
```

This writes `.feature/live/snapshot.html` — the same page with the data
inlined and every machine-local path stripped. The file is an
Artifact-compatible fragment: no doctype, `html`, `head` or `body` tags.
In Codex, open the snapshot with `open_in_codex` and provide its absolute file
link. External publishing is optional and requires an available authorized
publishing capability. Do this once the rounds close, not per round.

The page renders identically from either source. A published snapshot never
polls.
