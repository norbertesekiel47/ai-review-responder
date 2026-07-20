> **Correction (2026-07-20):** Migration numbers in this report are pre-renumber —
> `poller_cursors` shipped as **081**, not 079 (079/080 on `main` are agent-spine
> retention and scheduler dedup respectively). The `accounts(subscription_status, id)`
> composite index described here was **DROPPED before merge** per the staging
> EXPLAIN gate (commit `d93a62e8`) — it does not exist on `main`. See `TRIAGE.md`.
> Body below is a point-in-time record and is intentionally untouched.

# Spec & Correctness Review — #479 Stripe reconcile remainders

Branch: `feat/stripe-reconcile-remainders` · Diff: `git diff 96b4f28c HEAD`
Reviewed against `.feature/intake.json` (authoritative), plan Rev 5, ADR 0006,
deviations log. Review-only; no code changed.

**Overall verdict: the diff faithfully implements the locked intake contract and
the plan.** No runtime correctness bug found. The only concrete findings are
stale in-code comments left behind by the adversarial-fix rounds (FIX 2b / FIX 3)
that were not propagated to every consuming comment site — the executable code
and the pure-module docstrings are correct.

---

## Per-field verdict — the 7 intake sections

| # | Intake section | Verdict | Notes |
|---|---|---|---|
| 1 | **goal** (index / persisted cursor / truncation alert) | PASS | All three shipped. Migration 080 = `idx_accounts_reconcile_status_id (subscription_status, id)`, non-partial with documented rationale + mandatory staging EXPLAIN gate. Cursor persistence = migration 079 `poller_cursors` + `cursor-store.ts` write-seq CAS + `runOnce.finally` save, seeded at boot. Sustained-truncation alert = `truncation-alert.ts` + `classifyCycle`/`evaluateTruncation`, fires once at threshold 3. |
| 2 | **non_goals** | PASS | No auto-correct (detect-and-alert only, verified reconcile-account untouched by this diff). `ACCOUNT_FAN_OUT_CONCURRENCY=3`, `ACCOUNT_TIMEOUT_MS=60_000`, `CYCLE_TIMEOUT_MS=240_000`, `INITIAL_RUN_DELAY_MS=45_000` all unchanged. Reconciled statuses still `active/past_due/trialing`. No generic cursor framework — `poller_cursors` is a concrete table, `cursor-store.ts` is the poller's sole writer; `PollerCursor` type kept local (deviation, accepted). No Discord routing added. In-memory cursor + fan-out from #487 preserved; only durability + alert added underneath. |
| 3 | **user_visible_behavior** (3 ops-observable) | PASS | (a) restart-resume via persisted cursor — `beginCursorLoad` seeds `accountCursor`, query resumes `a.id > cursor`. (b) 3-consecutive-truncation warning-level Sentry alert w/ `feature:stripe_reconciliation` tag + structured-log fallback. (c) single truncation stays log-only (self-heals via cursor) — asserted by the "single truncated cycle stays log-only" test. No behavior added beyond these three; no scope creep. |
| 4 | **invariants** | PASS (with one wording gap, see below) | Tenant isolation: `poller_cursors` has `poller_name`/`cursor`/`write_seq`/`updated_at` only, no `account_id`; deny-all RLS. Inv #15: `cursor-store` takes `sql` param, poller (composition root) owns the singleton import. Inv #3: `inProgress` released in `finally` on every path; boot-load, re-seed, and save all `withTimeout`-bounded — verified by the never-settling-boot-load, failed-re-seed, and persist-timeout tests. Boot ordering: `runOnce` kicks `beginCursorLoad` then `reconcileCycle` awaits `cursorLoaded` before reading the cursor. **Cursor correctness — see MED-1 note on the "at all times" wording vs the ADR-documented one-cycle truncation lag.** |
| 5 | **edge_cases** (7) | PASS | (1) row absent on boot → `loadCursor` returns `{cursor:null, writeSeq:0}`. (2) read fails at boot → `.catch` logs, `accountCursor=null`, no crash. (3) upsert fails mid-cycle → `.catch` log-and-swallow, in-memory cursor already advanced. (4) single truncation → drain resets. (5) rotation-complete → `nextCursor` null, counted as drain. (6) empty list → drain + persist null. (7) `dispatched===0` after completed query → `classifyCycle` returns `truncated` (verified directly), cursor untouched (`if (dispatched>0)` guard). |
| 6 | **allowed_edit_surface** | PASS | Every changed path is inside a declared glob (poller, `billing-reconciliation/**`, `__tests__/**`, migrations 079/080, migrations-log, `.feature/**`, `docs/**`). No `scripts/ci/**` change needed (tenant-scope did not trip — accepted deviation). No out-of-surface files. (`poller_cursors.cursor` in the parent checkout's git status is untracked and NOT in this branch diff.) |
| 7 | **tests_to_add** (5 + adversarial) | PASS | All 5 present and exercise what they claim (see table below). All four adversarial fixes (1a, 2a, 2b, 3) have dedicated regression tests. |

### tests_to_add coverage

| Promised test | Present | Exercises the claim? |
|---|---|---|
| PROPERTY cursor round-trip / CAS monotonicity | `cursor-store.test.ts` | Yes — fast-check "persisted == highest-seq write" + decisive detached-save-after-higher-seq race + NULL-boundary variant + round-trip + bigint-string coercion. |
| PROPERTY truncation state machine | `reconcile-progress.test.ts` | Yes — fast-check fires exactly at first crossing, never re-fires, resets on drain AND stall (FIX 2b), + T,S,T,S,T streak-break. |
| UNIT boot-load seeds before first read | poller test "boot-load seeds accountCursor before the first cycle reads it" | Yes — persisted `acct-boot` appears in the accounts-query params. |
| UNIT upsert-failure log-and-swallow + inProgress released | poller test "a cursor persist timeout in finally is swallowed…" | Yes — parked save, `errors=0`, "Cursor persist failed" logged, next tick runs. |
| UNIT emitTruncationAlert Sentry+tag / log fallback | `truncation-alert.test.ts` | Yes — warning level + `feature:stripe_reconciliation` tag when DSN set; JSON `console.warn` line otherwise; mutual exclusion asserted. |

Adversarial regression tests: 1a → "FAILED boot-load re-seeds writeSeq… seq 6" + "failed boot-load AND failed re-seed skip persist". 2a → "NON-timeout error after the accounts query does NOT increment". 2b → the reconcile-progress T,S,T,S,T property + poller "stall … RESETS the streak". 3 → "defers the cursor boot-load past the boot-storm — start() queries NOTHING".

---

## Bugs

No runtime correctness bug. Concrete defects are stale comments:

### MED-1 — three comments assert "a stall leaves it untouched", contradicting the shipped FIX 2b behavior (a stall RESETS the counter)

FIX 2b (accepted deviation) changed `evaluateTruncation` so anything that is not
`truncated` resets the streak: `reconcile-progress.ts:100`
`if (cycle !== 'truncated') return { consecutive: 0, alert: false };`. A stall
therefore resets to 0 — verified by the T,S,T,S,T tests. But three consuming
comments still describe the pre-FIX-2b semantics:

- `billing-reconciliation/constants.ts:~29` — "a drain resets the run, a stall leaves it untouched."
- `StripeLocationsReconcilePoller.ts:127` — "a drain resets it, a stall leaves it untouched, a truncation bumps it".
- `StripeLocationsReconcilePoller.ts:253` — "a drain resets the counter, a stall leaves it untouched, a truncation…".

Failure scenario: a maintainer tuning the alert threshold reads these comments,
believes a stall preserves the truncation streak (so T,S,T,S,T would page at 3),
and reasons about the state machine incorrectly — the code does the opposite.
The pure-module docstring (`reconcile-progress.ts:88-90`) is correct; only the
three consuming comments are stale. One-authoritative-owner / broken-window
violation on a safety-relevant state machine. Fix: update the three comments to
"a stall (like a drain) resets the counter".

### LOW-2 — `constants.ts:19` comment "boot cursor load kicked from start()" is stale after FIX 3

FIX 3 moved the boot-load out of `start()` (which now queries nothing) into the
lazy first-tick kick in `runOnce` (`StripeLocationsReconcilePoller.ts:218`,
`504-507`). The `CURSOR_LOAD_TIMEOUT_MS` comment still says "kicked from start()".
Harmless at runtime; misdescribes when the SELECT fires.

### LOW-3 — file-header scope comment omits `trialing`

`StripeLocationsReconcilePoller.ts:11` header: "Only checks accounts with
subscription_status = 'active' or 'past_due'". The actual query
(`:373`) and the `reconcileCycle` docstring (`:323`) both include `trialing`.
Pre-existing (trial feature), not introduced by this diff, but sits in a file
this diff heavily edits and is internally contradictory. Fix in passing.

---

## Low-confidence appendix (speculative "might be nicer" — NOT in the returned table)

- **Invariant #4 wording vs the ADR one-cycle lag.** Intake invariant #4 says
  "persisted value equals the in-memory working copy **at all times**". On the
  truncation path this is not literally true: `runOnce.finally` reads/persists
  `accountCursor` while the detached `reconcileCycle` is still parked in
  `Promise.all` and has NOT yet reached its `accountCursor = nextCursor(...)`
  tail (line 464). So the persisted cursor lags the in-memory advance by one
  cycle until the next persist. This is exactly the ADR 0006 "lag note"
  (poller comment `:287-289`) and is **bounded-safe** per the never-skip
  invariant (a restart in the window re-walks one batch; drift is durable +
  idempotent). Not flagged as a bug — it is the accepted, ADR-documented design;
  only the intake invariant's absolute "at all times" phrasing overpromises
  relative to what was shipped and accepted. Could be reconciled by softening the
  invariant text to "…except the one-cycle truncation lag per ADR 0006".

- **FIX 1a re-seed overwrites the current cycle's cursor advance.** On the
  failed-boot-load path, `runOnce.finally` re-seed sets
  `accountCursor = reseeded.cursor` (`:299`), discarding whatever the just-run
  cycle advanced it to and persisting the re-seeded value instead. This is
  intentional per the FIX 1a deviation (avoids re-walking the prior process's
  rotation) and happens at most once (subsequent cycles are seeded). Bounded-safe
  (rotation eventually wraps; no permanent skip), but subtle — a one-time cursor
  regression on that path. Worth a one-line comment noting the discard is
  deliberate.

- **In-memory `accountCursor` mutation from a detached cycle vs the next cycle.**
  A detached (timed-out) cycle's tail (`:464`) can, in principle, write
  `accountCursor` after the next `runOnce` has already read it. In production
  this cannot race (hourly cadence ≫ the 60s detached-tail bound), and the
  persisted value is fenced by the write-seq CAS regardless. Noted only for
  completeness; the deviations log already reasons about the counter/alert being
  `runOnce.finally`-only.

- Migration 079/080 headers, RLS posture (deny-all, service-role bypass,
  `impersonation_sessions`/`agent_runs` precedent), CONCURRENTLY/non-transactional
  handling, and the migrations-log entries (head → 080) are all correct and
  complete.
