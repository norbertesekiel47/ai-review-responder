# progresstracking.md — archived history 2026-08-21 → 2026-08-23

Archived verbatim from [`docs/progresstracking.md`](../progresstracking.md) (the live file) on 2026-09-13; frozen history — never edit or summarise.

## 2026-08-21 — #898: **Send governors** — the schema and the three governors #899/#900 stand on (PR #904)

Wayfinder map #617, child of #630. Design of record:
`docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` §3.2A/§3.2B/§3.3/§3.4/§4,
`…-send-mode-executor-approval-design.md` D19/D20, and
`…-send-mode-cross-spec-amendments.md` **B3/B6/B13/B14** (the amendments doc wins on conflict).
Plan: `docs/superpowers/plans/2026-08-19-solicitation-send-governors.md` — 8 tracer tasks,
eval-first (Task 1 was 30 failing tests that ARE the spec).

**Nothing in this PR sends mail.** #899 builds the send worker and #900 the release-side
consumer that actually refuses to send while a trip is open. This ticket holds the migration
slot and the read models so those two land without a migration between them. Today the breaker
can trip, page and be reset; nothing reads it on the send path.

**What shipped.**

| Governor | File | Behaviour |
|---|---|---|
| Send caps | `src/lib/solicitation/send-caps.ts` | platform ceiling resolver + per-account daily cap, UTC-day dispatch counters |
| Send breaker | `src/lib/solicitation/send-breaker.ts` | 7-day window read model, one-open trip latch, fail-closed read, admin reset |
| Bounce discrimination | `worker/ingress/resend/solicitation-lane.ts` | records `bounce_kind` beside `bounced_at` |

Plus migration **110** (two withhold members, `bounce_kind` + two CHECKs + a partial index,
the `solicitation_send_breaker` latch table with deny-all RLS), the `HealthAlertPoller` check
that is the breaker's ONLY tripper, `/admin/solicitation` (Island system, AAL2) with its reset
route, and `docs/runbooks/solicitation-sending-domain.md` §8 as the operational procedure.

**Seven decisions locked in grilling**, none re-litigable on a later branch: `bounce_kind` is a
new column rather than a `provider_error` prefix match (`recordFailure` COALESCEs `failed:<reason>`
into that column, so an `email.failed` before an `email.bounced` would mask a real hard bounce —
fail-OPEN on a governor specified fail-CLOSED); the `withheld` CHECK gains exactly two members and
dispatch-gate item 3 deliberately gets none (a lapsed subscription DEFERS, `send_window_elapsed`
terminalizes); the latch is append-only with a one-open partial unique index, not a mutable
singleton; the window basis is asymmetric (denominator send-dated, numerators signal-dated —
errs toward tripping); `HealthAlertPoller` trips and pages while #900's releaser is a pure reader,
accepting one poll interval of trip latency; no new runbook file; and the reset lives on a new
`/admin/solicitation` page rather than folded into `/admin/autonomy`.

**Review: 2 rounds, 23 findings (6 high) then verification-only. 11 follow-ups filed (B3.1–B3.11).**
Three defects are worth remembering, because in each case the test and the implementation shared
the same wrong assumption and no amount of reading would have found them:

1. **UTC-day boundary** — the fixture used the same expression as production, so both were wrong
   together. Found by a subagent escalating rather than silently deviating.
2. **Breaker recovery** — the asymmetric window was tuned to err toward tripping and never checked
   in the other direction. Fixed once (denominator only), then properly in round 2 with TWO floors:
   `signal_floor` (rolling 7d, dates the numerators) and `reset_floor` (bounds rows by `sent_at` on
   BOTH sides). The first fix's own test seeded `bouncedDaysAgo: 1` and structurally could not see
   the gap — a single trailing complaint read as 1.00% against a fresh denominator and re-tripped a
   legitimate recovery, making recovery arithmetically unreachable.
3. **Edge-triggered paging** — the plan specified the bug as a feature and the eval test asserted
   it, so one dropped Sentry event meant a silent permanent platform-wide halt. Now level-triggered:
   the poller probes for an open trip FIRST and re-pages every tick under a constant title.

**Staging ride** (`docs/runbooks/evidence/2026-08-21-898-send-governors-staging.md`) — complete.
Migration 110 applied to staging and verified by introspection. **9-assertion latch smoke**, all
PASS, including the module's exact `ON CONFLICT ((reset_at IS NULL)) WHERE reset_at IS NULL`
against the real index — the clause that fails at *runtime*, on the second breach, if it ever
drifts. **13-assertion admin smoke** through an authenticated AAL2 browser session, all PASS; the
actor guarantee proved stronger than designed, since the route schema is `strict` and rejects a
body carrying `reset_by` with 400 rather than ignoring it.

**The ride's most useful evidence was accidental.** The 898 code sat on the staging worker for two
days while the database was still pre-110, so the breaker check queried a table that did not
exist. It logged its `health_check_error` warning finding on every one of five `HealthAlertPoller`
ticks and never crashed, then went silent on the first tick after 110 applied. That is a live proof
of both halves of the round-1 isolation fix — the failure class that used to take the whole cycle
down and discard the nine findings collected before it — under real conditions rather than a
harness. Staging was left clean: 0 breaker rows, 0 open trips, 0 outreach rows.

**One red PR, worth recording.** CI failed on `fallow`, the one gate `verify-gate.sh` deliberately
excludes (`ci:fallow*` is `CI_ONLY_BY_DESIGN`). Two findings: an unused export, and the
`gate → parse → safeParse → 400` preamble as a 3-instance clone. **The extraction was built and
reverted.** A `requireAdminJson(request, schema)` in the canonical gate module cleared fallow,
lint, typecheck and build — and failed `ci:admin-aal2` on all three routes, which is that audit's
stated design: it is a fail-closed allowlist of recognized gate SHAPES, and "a gate hidden behind
an imported wrapper is not visible to this audit and does not count." Clearing it would have meant
widening a security control to satisfy a duplication linter, after both review rounds closed.
Acknowledged in `.fallowrc.jsonc` with the blocking reason recorded; follow-up **B3.11** carries the
extraction AND the gate-shape change together, under one review. Kept from the reverted attempt:
`BREAKER_TRIP_REASONS` became a union type (un-exporting it merely handed the finding to ESLint as
"assigned a value but only used as a type"), and `reset-route.test.ts` now mocks the auth PRIMITIVES
rather than `requireAdminWithAal2` — it claimed to mirror the autonomy suite but mocked one level
shallower, which is why that route survived the refactor untouched while six promised tests here
went 401. It still passes after the revert, which is the proof it was a real fix.

**Surface amendments: 4 against a budget of 2**, all owner-approved — `schema-ready.ts`, the
`nav-config.ts` row, the cross-spec amendments doc, and `.fallowrc.jsonc`. None was scope sprawl;
all four were files the work structurally owed. Two of them are the same recurring shape, now in
lab-notes: every new admin page owes a `nav-config.ts` row and every new migration owes a
`schema-ready` requirement, and both are filesystem-walked so the obligation is invisible in the
file you are actually writing.

**Promotion.** Migration 110 applied to **production before the merge**, which is 109's reasoning
verbatim: the change is additive and #898 ships no writer for either new withheld reason, so a
widened CHECK is inert — whereas merging first would have opened the exact window staging proved
survivable but which there is no reason to open in prod. Pre-flight showed prod at 109 with **0**
rows in `solicitation_outreach`, so the no-backfill proof held there too, and confirmed the **078
standing exception untouched** before and after. All three databases agree byte-for-byte:
`md5(pg_get_constraintdef(...)) = 3e644c28c60a3d6135ed3eea7acee224` on prod, staging and local head.
Lockstep complete, no standing exception. All send flags remain OFF.

---

## 2026-08-22 — #899 Solicitation send worker (PR #912, squash `2204e6a6`)

**The first code in this repo that can put a real email in front of a real customer.** Merged
inert: `SOLICITATION_SEND_ENABLED` is off everywhere, and issue **#915** records that it must
stay off until #900 ships. **No migration** — #898's 110 carried this family's schema work.

### Files

New: `src/lib/solicitation/dispatch.ts` (2001), `src/lib/solicitation/send-retry.ts` (181),
`worker/jobs/solicitation-send.ts` (41), `worker/jobs/solicitation-send/failed-hook.ts` (346).
Modified: `run-spine.ts` (+52 — two `STEP_PERSONA` keys plus `findActiveSolicitationSendBatchRun`),
`queue-names.ts` (+5), `worker-types.ts` (+15), `worker/index.ts` (+26), `worker/queues.ts` (+5),
`ask-compliance-lint.ts` (+44 — the new `lintInputFromSnapshot` mapper), `ask-generation.ts` (+34/-23
— routed through it), `outcome-anchor-pairing.test.ts` (+42 — two new spine callers allowlisted),
`CONTEXT.md`, `docs/directory.md`, the cross-spec amendments doc. Tests: 3,602 lines across five suites.

### Shape

`tx1` (stale-attempt guard → advisory lock → batch row → outreach row → seven-item **Dispatch gate**
→ consent snapshot → **Lazy child** → token mint → CAS `queued`→`sending`), then the provider call
with **no lock held** and bounded in-process retry, then `tx2` committing five terminal facts at once
(CAS, child terminal, `solicitation_sent`, outbox completion, `closeBatchIfSettled`).

### Decisions (ten locked; six recorded upstream as amendment **B15**)

1. Slow gate items (re-lint, re-moderation) run **above** `tx1` — a ~10s provider call must not be
   held under the batch lock. `tx1` verifies a digest of the bytes those verdicts saw, so the
   **Owner approval** byte-for-byte contract is checked, not assumed.
2. Retry is **in-process only**. A fresh process never re-sends: the raw unsubscribe token existed
   only in memory (invariant #5), so no correct message can be rebuilt.
3. A flag-off **defers**; 091/110 carry no `flag_off` withheld reason.
4. The dispatch moderation verdict never overwrites `moderation_status` (render provenance, B1).
5. Review link is `writereview?placeid=…`, and **throws** on a null or non-canonical place id —
   migration 007's legacy hex CIDs would mint a URL resolving to nothing.
6. `QUEUE_NAMES.SOLICITATION_SEND` ships with the consumer; the typed helper ships with its
   producer (#900), which is B10 clarified for the post-decomposition world.

### Review — one round, three axes; four defects fixed

**Two reviewers independently found the same bug:** `tx1` short-circuited only on `cancelled` and
`sending`, so any other status walked the whole gate and committed writes. A never-released
`rendered` row would have been silently terminalized `withheld` (091's CHECKs accept it), and on a
gate pass the token row committed before the CAS failed — after which #900's later legitimate
release would hit `token_conflict` and refuse that contact **forever**.

Also fixed: the exhaustion hook wrote `failed`/`send_exhausted` for a `sending` row (D12d's
lie-with-teeth — it can email someone twice), `tx2` emitted `solicitation_sent` even when its
terminal CAS matched nothing (losing the only bounce-attribution key), and the gate trusted a byte
immutability only a domain module enforces. Plus a glossary violation, a stale directory row, a
tautological property assertion, and a fifth copy of `boundedErrorClass`.

Reports and triage verdicts: `docs/reviews/feat-899-solicitation-send-worker/`.

### Gotchas found (promoted to lab-notes 2026-08-22)

`timeout(1)` is absent on macOS and its absence looks like success · `solicitation_suppressions`
and `job_outbox` carry no tenant columns · hard-coded restraint-policy fixture dates are time bombs
(detonated mid-feature, fixed in #911) · `docs/analytics/events.md` owns event keys, not the code ·
local `fallow` cannot predict its own CI gate · every new run-spine caller owes three allowlist
edits · `sending_at` and `sending_started_at` are different columns with different owners.

### Follow-ups

**#913** relocate the provider-agnostic error vocabulary out of `src/lib/payments/`.
**#914** Send handoff should withhold a location with no canonical place id.
**#915** enablement blocker: #900 before any flag flip.

## 2026-08-23 — #900 Solicitation release poller (PR #920, squash `a321634a`)

`SolicitationReleasePoller` — the one Postgres-state-driven loop that drives the send lane.
Five phases in a fixed order, every 60s. **No migration**: 091 and 110 already carried every
column, CHECK member and index this feature writes.

Lane: RISK = high · SURFACE = backend · `db_touching: true`. Rode `staging` first (Railway
deploy verified: worker boots clean, poller registers at the 60s default, three cycles land
exactly 60s apart, zero errors, and staging holds no send-mode rows so the zero counts are
honest rather than a silent skip).

### The five phases

1. **`unknown` sweep (D12d)** — an Outreach row wedged in `sending` past 60 minutes with no
   in-flight outbox row terminalizes `unknown`, terminalizes its **Lazy child**, joins, and
   raises a Sentry alert. This frees the location's one-active-send slot under 091's
   `solicitation_batches_one_active_send_per_business`, which is **#915's blocker**.
2. **`send_window_elapsed`** — a batch past its 72h send window is latched with no actor.
3. **`batch_expired` (B7)** — a batch never approved inside its 7-day approval window, same
   latch. Makes `STALLED_THRESHOLD_SEND_BATCH_DAYS` (11) unreachable rather than unlikely.
4. **Release** — the four send governors in amendment B6's fixed order (Send breaker →
   platform ceiling → account cap → per-child), then the `rendered → queued` CAS and one
   `solicitation_send` job per row. **The only phase `SOLICITATION_SEND_ENABLED` gates.**
5. **Backstop join** — a second CALLER of `closeBatchIfSettled`, never a second implementation.

### Files

| File | What it owns |
|---|---|
| `src/lib/solicitation/release.ts` (new, 1,739 lines) | `runReleaseCycle`, `sweepSystemHalt`, `runAccountArm` / `runBatchArm`, `capacityStop`, the P1–P4 predicates. |
| `worker/background/pollers/SolicitationReleasePoller.ts` (new) | Composition root only. Owns `sql`, the interval, the guarded-poll scaffolding. |
| `src/lib/solicitation/approval.ts` | + `latchSystemHalt`, the Halt latch's third and actor-less arm. |
| `src/lib/shared/job-outbox-helpers.ts` | + `enqueueSolicitationSend` (B10). |
| `src/lib/agents/run-spine.ts` | + `approval_downgraded` in `STEP_PERSONA`. |

### Decisions worth keeping

- **The poller does NOT read `SOLICITATION_SEND_ENABLED`, departing from its `JudgeSweepPoller`
  precedent.** The flag gates phase 4 inside the domain module. Gating the cycle would stop the
  sweeps, so a batch flipped off mid-drip would keep its `queued` rows forever and 091's index
  would block that location permanently — the wedge #915 exists to close.
- **`latchSystemHalt` applies NO guard list.** The human arms refuse `halted`, `closed` and
  `pending` because an actor is owed an answer; a clock is owed nothing, so `latchHalt`'s
  `halted_at IS NULL` CAS is the whole of its idempotence.
- **Two isolation units, each the unit its work belongs to.** Account for the two per-account
  gate reads; batch for everything inside. Without the inner unit one poisoned batch discarded
  the account's whole remaining tick every tick — #915's wedge narrowed, not closed.
- **The account cap is checked BEFORE the subscription** (B6's closing paragraph). Both gates
  refuse; only the reported reason differs, and getting it wrong sends the operator to the
  wrong dial.

### Env vars

`SOLICITATION_RELEASE_POLL_INTERVAL_MS` — optional, 60s default. Parsed like
`JUDGE_POLL_INTERVAL_MS` with one extra rejection: a value at or below the 45s
`CYCLE_TIMEOUT_MS` is invalid, because `GuardedPollOptions` requires the per-cycle deadline
to sit below the interval.

### Review

19 accepted findings across 3 rounds (12/5/2 found; 11/5/2 accepted; 13 fixed, 5 deferred to
#919, 1 rejected). Round counters hit the cap at 3/3. The rejected finding was module shape:
the standards agent — whose axis it is — examined the single-export file and declined to flag
it; the adversarial agent asserted the opposite without naming a seam.

Reports and triage verdicts: `docs/reviews/feat-900-solicitation-release-poller/`.

### Step 8 cost two extra CI cycles, and both are worth recording

- **CI run 1: `fallow` red** on three new findings — `runReleasePhase` CRITICAL (cyclomatic 25,
  cognitive 58, 205 lines) and two clone groups, all one root: the three capacity gates
  re-spelled at three nesting depths. Fixed by `capacityStop` + `ReleaseCounters` + extracting
  the two arms (205 → 135 lines), and by unifying the two sweeps into `sweepSystemHalt`.
  **This discharged round 1's Finding 2, which had been accepted and deferred to #919** — so
  that deferral shrank. A fourth finding, clone `dup:ddc3f485` in `approval.ts`, was proven
  pre-existing on `main` and needed nothing.
- **CI run 2: `test` red — the clock, not the code.** That run spanned 23:59:14 → 00:01:34 UTC.
  Three fixtures seed "an attempt already made today" as `NOW() - '5 minutes'`; the account cap
  counts on a UTC-day predicate, so after midnight the row lands in yesterday and the cap stops
  binding. Fixed with an opt-in `queuedWithinUtcDay` clamp, proven by reproducing the exact
  assertion and clearing it on the same clock.

### Gotchas found (promoted to lab-notes 2026-08-22/23)

Eight false rationales on one branch, every one a claim about the module's own internals ·
a lint suppression is a claim, so delete it and re-run before keeping it · any fixture meaning
"already happened today" must be clamped inside the UTC day · `prettier --write` reformats the
whole file because this repo has no prettier config · the `fallow` PR gate IS reproducible
locally, but only with **both** `TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL` exported ·
a cross-account spine-writing loop owes FOUR governance registries · the reclassify trigger
measures the diff, not the lane · `it.fails` is not evidence without a sensitivity probe.

### Follow-ups

**#917** B14's gap — a halt-aware send window OR a distinct `platform_halt` reason.
**CLOSED by #926 (2026-08-22), and it took the SECOND option**: migration 111 widened 091's
halt-reason CHECK and 110's outreach disposition CHECK to admit `platform_halt`, adding it to
the REASON list and deliberately not to the ACTOR list, so it is a third actor-less
`SystemHaltReason` needing no new actor semantics. The halt-aware window was NOT built and must
not be revisited casually: B14's argument against it stands — holding batches past their window
blows past the "≤10 days by construction" bound `STALLED_THRESHOLD_SEND_BATCH_DAYS = 11` derives
from. The sweep still runs on the same 72h clock; `resolveWindowHaltReason` reads the breaker once
per tick and picks which reason it writes, through the ONE sanctioned `try/catch` around
`readSendBreaker` — label-only, because a rethrow would stop the sweep and reopen #915's wedge.
**#923** the §7.1 yield-to-transactional obligation — **split out of #917 on 2026-08-22**, because
implementing #917's send window would have closed it silently. Different trigger, different fix.
**CLOSED by ADR 0022**: the refusal is recorded rather than the yield built. Two per minute against
ten per second is not contention (~0.33% of the team limit; ~0.6% at §3.3's 5,000/day ceiling), and
`dispatch-rate-bound.test.ts` pins the four dials that would invalidate that.
**#918** no CI audit enforces the `env-vars.md` registry row.
**#919** `seedUpload` hand-copied in six test files · no `CONTEXT.md` term for the release lane ·
the sub-default configured-cap gap · the subscription gate's structural shape · and new: extract
a shared `lockBatchForHalt` preamble for `haltBatch`/`adminHaltBatch`.
**#915** CLOSED by this merge (verified: 60-min grace > the watchdog's 15-min re-pend; `unknown`
counts as possibly-contacted structurally, because `over_contacted` keys on `solicitation_asks.status`
and the terminalization never writes that table). **Its content was the BLOCKER, not the enablement
decision** — an earlier draft of this line said otherwise and was wrong. The flip itself is governed
by design doc §8.4 + the `flag-flip` skill and currently has **no tracking issue**.
