# Handoff — feat-544-watch-mode-batch-ui

**Phase at write time:** `plan_approved` (step 3 complete, step 4 starting).
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-544-watch-mode-batch-ui`
**Ticket:** #544 · **Wayfinder map:** #528 (destination ticket — closing it reaches the map's destination)

A resumed session bootstraps from the files below. **Do not re-read the grilling
conversation** — every decision it produced is on disk.

## Read these, in order

| What | Path |
|---|---|
| Locked intake contract (the drift detector) | `.feature/intake.json` — audit copy `docs/superpowers/plans/feat-544-watch-mode-batch-ui-intake.json` |
| Implementation plan (rev 4) | `docs/superpowers/plans/2026-07-25-544-watch-mode-batch-ui.md` |
| Deviations (append-only during execution) | `docs/superpowers/plans/feat-544-watch-mode-batch-ui-deviations.md` |
| Prototype decisions (#537 — rendering, placement, empty state) | ticket #537's closing comment; branch `prototype/537-watch-mode-batch-screen` |
| Restraint policy spec (#533) | `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md` |
| Executor shape spec + batch lifecycle (#534) | `docs/superpowers/specs/2026-07-23-run-engine-executor-shape.md` |
| Glossary | `CONTEXT.md` — "Solicitation (watch-mode)" section |

## Glossary excerpt to hand every subagent

Use these verbatim; do not paraphrase or coin synonyms.

- **Solicitation batch** — one evaluated cohort of candidates; lifecycle built → reviewed → *expired* (expired is **not implemented**, see below).
- **Ask** — one per-candidate decision, `send | withhold`. In watch-mode "send" means *would send*; nothing is transmitted.
- **Withhold reason** — one code from the closed six-reason enum (`no_consent`, `suppressed`, `already_reviewed`, `stale_visit`, `over_contacted`, `velocity_banked`). First-match precedence, one per withhold.
- **Evidence snapshot** — the immutable per-decision record; candidate by ID only, **never a star rating** (ADR 0012).
- **Spoilage report** — the batch display of withheld candidates with reasons; the visible-restraint aha of watch-mode.
- **Velocity banking** — withheld solely because the batch cap was reached. Volume shaping, *not* rejection.
- **Requests** — the owner-facing label for this surface (`/dashboard/requests`), coined by #544. `Solicitation` stays the internal/agent term.

## Decisions locked in grilling (do not re-litigate)

1. Requests is the section; `/dashboard/contacts` moves to `/dashboard/requests/contacts`.
2. Latest batch only — no `[batchId]` route, no history.
3. `reviewed_at` is written by a dedicated POST fired on first **render** of a built batch. (Was briefly folded into the GET; reverted — polling would have marked abandoned tabs as "opened".)
4. No `expired` state and no staleness constant this ticket — render relative build time. `CONTEXT.md` must be amended to say so (T5).
5. Three non-happy states: no batch (ghost pipeline, merged with "uploaded before the flag was on"), building (bounded poll), built-with-zero-asks (0-queued funnel, **not** the empty state).
6. Every funnel number derives from `solicitation_asks`. Pool truncation stays invisible in the UI (worker log only).
7. Owner-facing label is **Requests**.
8. Observability = `reviewed_at` + one structured log line per read. Back-out = the flag, in **both** Vercel staging and the Railway staging worker.
9. Withheld ledger is bounded 6 reasons × 10 evidence rows. No queued list, no filter chips, no pagination.

## Plan gate history

Three adversarial rounds, all `REVISE`; findings accepted and inlined (see the plan's three revision-log sections). The gate never returned `APPROVED` — round 3's two findings were narrow (`logger.info` doesn't exist; the POST needed `?scope=`), both verified against source and fixed, so there was no disagreement to escalate at the 3-round cap.

## Carried risk — must be resolved during T1, not assumed

`rg` finds **zero** prior uses of `ISOLATION LEVEL` / `REPEATABLE READ` / `SERIALIZABLE` in this repo. T1's `REPEATABLE READ, READ ONLY` wrapper (the purge-race fix) is unprecedented here and runs against Supabase PgBouncer in **transaction** pooling mode, where CLAUDE.md documents a silent no-op nearby (`SELECT … FOR UPDATE` outside `sql.begin()`). **Prove it takes effect against the live staging pool in T1 step 9.** If it does not, re-plan the fix — do not ship a wrapper that reads as protection but isn't.

Second carried item: Q3's query plan on a 5,000-ask batch. The ask indexes lead on `business_id`, not `batch_id`. T1 step 9 seeds 5,000 asks and records `EXPLAIN (ANALYZE, BUFFERS)`. A seq scan means a new index — that is a **migration**, which flips `db_touching` and the ship lane, so it escalates to the human.

## State of the branch

Nothing implemented. Commits so far: setup + intake + plan/handoff docs only.

## Next action

Re-arm (`mv .feature/intake.parked.json .feature/intake.json`) if parked, confirm `bash scripts/arm-check.sh` shows ARMED, then execute T1 → T6 per the plan via `superpowers:subagent-driven-development`. After the FIRST subagent task, diff `git status --porcelain` against `allowed_edit_surface` — an out-of-surface file means enforcement did not bind and execution must stop.

## Ship lane (RISK = high)

Staging ride first; flip `SOLICITATION_WATCH_ENABLED=true` in **both** Vercel staging and the Railway staging worker via the `flag-flip` skill; smoke the upload → building → funnel path; then PR to `main` and pause for merge approval. **No production flip — out of scope for #544.**
