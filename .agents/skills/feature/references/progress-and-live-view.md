# Progress and live view

Two surfaces report a run. Both read the same durable state, so neither can
drift from the other or from the worktree.

- **Terminal block** — a rendered step ladder printed at every phase boundary.
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

Marking a step `done` opens the next one automatically. Use `skipped` for a
step a lane does not run — a `trivial` lane skips `armed` and `plan`. Use
`blocked` when the run stops at an authority boundary; the terminal note
carries the reason.

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
```

Every write command prints the block, so a phase boundary is one command, not
two. Use `render` when nothing changed — on resume, or when the user asks
where the run stands.

`carry` exists because steps 0 and 1 run before the worktree does. It reads
the parent checkout's ladder, writes it into the current worktree, and marks
`armed` done. Run it once, from the worktree, right after `arm-check.sh`
reports `ARMED`. It never deletes the parent copy; `.feature/` is gitignored,
so the orphan is harmless.

## Review transcript

Codex output is not copied into the transcript. `attach-codex` records a
pointer to the codex-companion job files, and the live view reads verdict,
findings and log tail from those files. The companion stays the single owner
of its own output, so a running job streams into the page without any
polling on this side.

Claude's own turns and triage verdicts have no other sink, so they are
written here.

```bash
L=".agents/skills/feature/scripts/review-log.mjs"

node $L round-start --axis plan-skeptic
node $L say --text "Plan rev 2 sent. 9 tracer bullets, surface locked to 4 files."
node $L attach-codex --latest --axis plan-skeptic
node $L finding --id F1 --severity high --title "Veto window keys on sent_at" --at "worker/jobs/publisher/veto-window.ts:212"
node $L triage --id F1 --verdict ACCEPT --reason "Reproduced: delivery lag opens a silent 15-min gap."
node $L round-end --verdict REVISE
node $L render
```

Rules the scripts enforce:

- `triage` refuses an unknown finding id. Log the finding before triaging it.
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
Publish it with the Artifact tool to give the user a shareable record of the
review. Do that once the rounds close, not per round.

The page renders identically from either source. A published snapshot never
polls.
