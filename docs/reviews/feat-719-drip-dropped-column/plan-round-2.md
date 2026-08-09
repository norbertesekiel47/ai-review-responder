# Plan review — round 2 (verification-only)

**Verdict: APPROVED for execution**, with the weakening below stated plainly.

## How this round was performed, and why that matters

Round 2 was **self-performed by the orchestrator**, not by an external adversarial reviewer. Two
Codex dispatches were killed by the harness's 10-minute Bash ceiling (`timeout` maxes at 600000ms;
a 900000 request is silently clamped) while still crawling the repo — the second even after being
budget-fenced with citations pre-verified and MCP graph search forbidden. Neither emitted a single
finding or a verdict; both spent their whole budget reading.

**This is a real reduction in review quality and is recorded as such.** Round 1's value came from
adversarial independence — it found ten ways the eval could pass while the feature stayed wrong,
including two helpers I was about to reinvent because I had read `outbox.ts:1-150` and stopped. A
self-review cannot reproduce that. The mitigation is that round 2's remit is narrow and largely
mechanical (did v2 address round 1's findings; is the arithmetic right), and that the **step-7
branch review runs against real code with fresh agents** and carries the adversarial load for this
feature. It is a weaker round 2, not a substitute for step 7.

Round counter: `planReviewRounds = 2`. The two killed dispatches were not counted separately — a
run producing zero output is not a round in substance. One substantive round remains.

## Round-1 finding closure

All 16 accepted findings verified closed against plan v2.1. The four structural ones:

| R1 # | Fix | Verified how |
|---|---|---|
| 1,2,4,5 | Sink writes nothing to `job_outbox`; Sentry only | Task 5's code contains no outbox import beyond `isTerminalAttempt`; `src/lib/shared/outbox.ts` absent from `allowed_edit_surface` (checked programmatically) |
| 3 | `isTerminalAttempt` imported, not redefined | Confirmed at `outbox.ts:211` (round 1 cited `:210` — corrected) |
| 11 | `runOnboardingDripCycle(exec, asOf)` throws; wrapper swallows | Task 4 Steps 2–3 |
| 12 | `COALESCE(completed_at, dispatched_at, created_at)` | Task 4 Step 2; both poller paths re-read |

## Boundary arithmetic — evaluated by hand (day_1, grace 3)

SQL predicates: due `activated <= asOf - 1d`; outer `activated > asOf - 5d`;
`too_late` = `activated < asOf - 4d`; churn `COALESCE(...) > asOf - 24h`.

| Fixture | too_late | outer | Outcome | Title | OK |
|---|---|---|---|---|---|
| `asOf - 4d` exactly | `4d < 4d` → false | true | selected, actionable → **queues** | 12 | ✓ |
| `asOf - 4d - 1m` | true | true | selected → `tooLate` 1, no row | 13 | ✓ |
| `asOf - 5d` exactly | — | `5d > 5d` → false | not selected, `tooLate` 0 | 14 | ✓ |
| `asOf - 10d` | — | false | not selected, `tooLate` 0 | 14 | ✓ |
| churn clock `asOf - 24h` exactly | — | — | `>` strict → uncounted → 0 < 3 → **queues** | 15 | ✓ |
| 4 failures at `asOf - 1h` | — | — | 4 ≥ 3 → capped | 16 | ✓ |
| `completed_at` NULL, `dispatched_at asOf-1h`, `created_at asOf-30h` | — | — | COALESCE → `asOf-1h` → counted → capped | 17 | ✓ |

The v1 `<=` bug (which skipped the boundary the locked intake says must send) is gone. The reported
window is exactly one day wide — `activated ∈ (asOf-5d, asOf-4d)` — as designed.

## Red-before-fix

- **Titles 2–7** — `resolveDashboardUrl` does not exist until T2 → red (import error).
- **Titles 8–11** — `handleOnboardingDrip` exists but throws `42703` at step 5, which precedes
  every drip branch → red for day_1, day_7 and both day_30 cases.
- **Titles 12–20** — `runOnboardingDripCycle` does not exist until T4 → red.
- **Titles 21–25** — `worker/job-failure-sink.ts` does not exist until T5 → red.
- **Title 1** — **green before implementation, by design.** It asserts infrastructure ("did the
  live-DB guard run"), not behaviour. Called out explicitly so it is never mistaken for a
  discriminator; round 1's complaint was about tests that *should* discriminate and did not.

24 of 25 red. No test passes for the wrong reason.

## NEW defects found this round

Two, both found by the orchestrator while verifying citations rather than by any reviewer:

**N1 — the execution sentinel was inside `describeWithDb`, so it would skip under exactly the
condition it exists to detect.** `describeWithDb` registers *skipped* suites when
`TEST_DATABASE_POOL_URL` is unset; a sentinel inside it disappears whenever it is needed. This was
a fix for round-1 finding 7 that reintroduced finding 7. **Fixed**: the sentinel now sits outside
`describeWithDb` in its own `describe.skipIf(REPWORTH_DISABLE_LIVE_DB_SUITES === '1')` block, so an
accidental missing URL fails loudly while the repo's sanctioned deliberate opt-out stays quiet.

**N2 — the scheduler suite's assertions were contaminable.** `runOnboardingDripCycle` scans **every**
business in the database, so a leftover eligible business from another suite lands in the returned
counts and in `job_outbox`; `result.queued === 1` is not a safe assertion. Found by asking why
`ArchivalPoller.integration.test.ts` takes `acquireLiveDbLock` — because its subject sweeps shared
tables, exactly like this one. **Fixed** in v2.1: global counts are forbidden, every assertion
scopes to the seeded `business_id`, the inherently-global skip counts are asserted as a delta
against a baseline cycle, and the suite enrols in `acquireLiveDbLock`.

## Citations (v2 additions, all re-read directly)

`outbox.ts:183` ✓ · `outbox.ts:211` ✓ (was cited `:210`, **corrected**) ·
`OutboxPoller.ts:140-143` sets `last_error` unconditionally ✓ · `:293-296` omits `completed_at` ✓ ·
`csv-ingest/failed-hook.ts:34,93` PII contract ✓ · `generate-failed-hook.ts:263` ✓ ·
`ArchivalPoller.integration.test.ts:250-261` singleton redirect ✓ ·
`assertSchemaReady` at `src/lib/shared/__tests__/helpers/schema-ready.ts:481` ✓ (v1's guess at its
location was unverified; now pinned).

## Carried into step 7

The step-7 spec agent must re-check, against real code, the two things a self-review is weakest on:
whether the sink's synchronous listener genuinely cannot interfere with the six domain `'failed'`
hooks, and whether any of the 25 tests passes for a reason other than the behaviour it names.
