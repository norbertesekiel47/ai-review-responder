# Pathfinder 2026-08-22 — guard integrity, measured by mutation

Every Phase 1 agent carried the same gap: ~13,000 lines of new tests unread, so no
boundary was checked against its test surface. This axis closes it the way the
2026-08-18 pass did — **by deleting the guard and running the suite**, not by
reading.

**Eight guards measured. None skipped. No verdict is inferred.**

Environment: `repworth-testdb` up, `test_ws4` at **migrations head 111** (51
tables, `solicitation_send_breaker` present, the halt CHECK contains
`'platform_halt'`). Both `TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL` exported
on every run. Integration suites confirmed **executing, not skipping** (baseline
`release.integration` + `dispatch.integration` + `send-breaker.integration` = 80
tests, 0 skipped). Clean-tree baseline: **52 files / 812 tests passing.**

## Results

| # | Guard | Mutation | Result | Verdict |
|---|---|---|---|---|
| 1a | `applyDispatchGate` order, `dispatch.ts:238-257` | swapped `suppression` ↔ `consent` | **RED** — 2/2 (`:84` repair *and* `:237` property) | **PINNED** |
| 1b | same, intra-defer | swapped `batch_open` ↔ `send_flag` | **RED** — 2/2 | **PINNED** — *refutes F2's hypothesis* |
| 2a | `queued → sending` CAS, `dispatch.ts:1723` | deleted `AND delivery_status = 'queued'` | **GREEN** — 756/756 | **UNPINNED** |
| 2b | terminal CAS, `dispatch.ts:1125` | deleted `AND delivery_status = 'sending'` | **GREEN** — 756/756 | **UNPINNED** |
| 3a | `release.ts` governor order | swapped `breaker_open` ↔ `platform_ceiling` | **RED** — `release.integration.test.ts:1131` | **PINNED** |
| 3b | `flag_off` vs `breaker_open` | moved `flag_off` **after** `breaker_open` | **GREEN** — 713/713 | **UNPINNED** — *confirms F1* |
| 4 | `per_tick_budget <= 0`, `release.ts:1362-1365` | deleted the branch | **GREEN** — 713/713 | **UNPINNED + dead** |
| 5 | `readSendBreaker` fail-closed, `release.ts:1341` | wrapped in a swallowing `try/catch` | **RED** — 3 tests | **PINNED** |
| 6 | `evaluatedBytesDigest` A4 check, `dispatch.ts:1520-1529` | deleted the comparison | **GREEN** — 712/712 | **PROSE-ONLY** |
| 7a | `HALT_BODY` totality | deleted `platform_halt` (`ApprovalPanel.tsx:292`) | tests **GREEN** 39/39; `tsc` **RED** `TS2741` | **TYPE-PINNED ONLY** |
| 7b | `HALT_REASON_LABELS` totality | deleted `platform_halt` (`SolicitationBatchPanel.tsx:58`) | tests **GREEN** 9/9; `tsc` **RED** `TS2741` | **TYPE-PINNED ONLY** |
| 8 | outbox in-flight triple, `job-outbox-helpers.ts:747` | reordered to `('pending','dispatched','dispatching')` | **RED** — audit names `:747`, prints required order | **PINNED (by audit)** |

*(Already measured by F4's agent, not repeated: `latchHalt`'s CAS at
`approval.ts:554` — two tests RED. See `01-flowcharts/F4-halt-latch.md`.)*

## The priority hypothesis was WRONG, and that is good news

Guard 5 was flagged in the brief as the likely **highest-severity finding of the
pass** — if the fail-closed throw were unpinned, the invariant stopping a send
during an unreadable breaker would rest on three prose statements and zero tests.

**It is pinned three ways.** Swallowing the throw kills three live-DB tests:
- `release.integration.test.ts:1620` — *"falls back to `send_window_elapsed` when
  the breaker probe throws, and still sweeps"*
- `:2024` — *"propagates a Send breaker read failure and enqueues no
  `solicitation_send` row"*
- `:2043` — *"raises a Sentry warning for a phase-level failure and still
  propagates it"*

## The real finding inverts the shape of the lane

**The send lane's *decision logic* is well pinned.** The gate order survives two
independent swaps. The governor order is caught by a four-round differential. The
breaker's fail-closed throw is caught three ways. The outbox status contract is
caught by a CI audit with a precise message.

**What is NOT pinned is the lane's *concurrency and integrity spine*** — both
send-path CAS predicates and the A4 bytes-identity check. **All three are exactly
the guards whose failure mode is silent:** a double send, a value-ledger row with
no join key behind it, or moderating one artifact and sending another.

Three of them were upgraded from "not caught by the suites I ran" to **"named by
no test anywhere"** — a whole-repo grep of `src` + `worker` for the outcome
discriminants `cas_lost`, `in_flight_elsewhere` and `bytes_changed_under_gate`
returns **zero test-file references**.

**Severity order: 6 (bytes identity) > 2b (terminal CAS) > 2a (queued CAS) > 3b >
4 > 7a/7b.**

## What the missing tests would assert

**6 — `evaluatedBytesDigest` (`dispatch.ts:1520-1529`). The highest-value missing
test on the list.** A live-DB test that lets the slow gate compute its verdict,
then `UPDATE solicitation_outreach SET rendered_body = …` before the locked
re-read, and asserts the dispatch returns `{ kind: 'bytes_changed_under_gate' }`,
sends nothing to the adapter, leaves `delivery_status = 'queued'`, and completes
only the outbox attempt (**a defer, not a withhold**). `bytes_changed_under_gate`
appears at `dispatch.ts:1413`, `:1528`, `:1819` and **in zero test files**, and it
is **the sole mechanical check that the bytes moderated are the bytes sent** —
ADR 0020's immutability is enforced in a domain module, not in the schema.

**2b — terminal CAS (`dispatch.ts:1125`).** Terminalize the row (to `failed`, e.g.
via the D12d sweep) between tx1 and `commitSendTerminal`, then assert the send's
own terminal write finds zero rows: `delivery_status` still `failed`,
`provider_message_id` still `NULL`, **no `solicitation_sent` value-ledger row**,
and no `completed` child step. **The docstring at `:1131-1139` states exactly these
four consequences and none of them is asserted anywhere.**

**2a — `queued → sending` CAS (`dispatch.ts:1723`).** Open a dispatch transaction
against a row already in `sending` (or `sent`) and assert `dispatchOutreach`
returns `{ kind: 'in_flight_elsewhere', detector: 'cas_lost' }` — no provider
send, no `sending_at`, no `updated_at` re-stamp. `'cas_lost'` appears **only** at
`dispatch.ts:1407` and `:1731` and **in no test file**.

**3b — `flag_off` before `breaker_open` (`release.ts:1332`).** A test with
`SOLICITATION_SEND_ENABLED=false` **and** a tripped breaker asserting
`report.releasePhaseStoppedBy === 'flag_off'` **and** that `readSendBreaker` was
never called (`toHaveBeenCalledTimes(0)`). The existing four-round differential
seeds the flag ON in every round, **so the flag's position is unconstrained** —
the same "silent wrong reason" class (#910 B3.2) that round covers for the other
three governors.

**4 — `per_tick_budget <= 0` (`release.ts:1362`). No test is needed; delete the
branch.** Reachability disproved structurally: `runReleaseCycle` resolves
`perTickBudget = options?.perTickBudget ?? RELEASE_PER_TICK_BUDGET` (`:353`),
`RELEASE_PER_TICK_BUDGET = 2` (`:213`), and **the sole production caller
`SolicitationReleasePoller.ts:57` calls `runReleaseCycle(exec)` with no options
object.** If kept as defence-in-depth, the test passes `{ perTickBudget: 0 }` and
asserts `withheldByReason.per_tick_budget === 1` with
`releasePhaseStoppedBy === null`.

**7a/7b — `platform_halt` copy.** `tsc` guarantees a key exists; **nothing
guarantees it says anything.** Extend `approval-panel.test.tsx:555-559` from five
cases to six and fix the header at `:551` — it still reads *"One latch, five
reasons"* against a six-member union. Same for `SolicitationBatchPanel.test.tsx`.
**A stronger variant: drive the case list from the `HaltReason` union so a seventh
reason fails the test at add-time** — which converts a Class-A enumeration into a
Class-B one, per X10.

## Confidence and gaps

- **Every mutation in the table was executed and its suite actually run.**
- **Blast radius is targeted, not repo-wide.** 46–52 files / 713–812 tests
  depending on the guard, versus the 2026-08-18 census's full 974-file suite. **A
  GREEN verdict here means "no test in the lane or its consumers", not "no test in
  the repo"** — except for 2a, 2b and 6, where whole-repo greps of the outcome
  discriminants upgrade the claim.
- **`e2e/` Playwright specs were not run.** Guards 7a/7b are UI-reachable in
  principle.
- **Guard 1's verdict covers `applyDispatchGate`'s pure order only** — not whether
  the evidence gathering that feeds it preserves the same order.
- **Concurrency claims are single-writer mutations, not races.** The CAS
  predicates are proved untested; no two-transaction harness was built to
  demonstrate the production damage.
- **`pnpm typecheck` was run only under 7a/7b.** Deleting a SQL predicate is not a
  type change, so this is very unlikely to matter.

## Restoration proof

The working tree was **already dirty before this axis began** — a concurrent
session held ~21 modified marketing files (see the caveat header on
`01-flowcharts/F6-section-pages.md`). Restoration is therefore proved by
byte-comparison against `HEAD`, independently of `git status`:

```
IDENTICAL  src/lib/solicitation/dispatch.ts
IDENTICAL  src/lib/solicitation/release.ts
IDENTICAL  src/lib/shared/job-outbox-helpers.ts
IDENTICAL  src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx
IDENTICAL  src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx
```

Final clean-tree re-run: **52 files / 812 tests passing**, `ci:outbox-status:
passed`. Nothing committed, nothing pushed, **no test file was edited**.
