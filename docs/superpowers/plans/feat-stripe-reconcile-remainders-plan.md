# Plan — #479 Stripe reconcile remainders (index / persisted cursor / truncation alert)

Ticket #479 · map #472 · RISK=high · backend · db-touching
Intake: `.feature/intake.json` (authoritative scope). In-memory cursor +
bounded fan-out already shipped in #487; this plan adds durability + the alert
underneath them, plus the supporting index.

> **Rev 5 (final)** — Codex adversarial rounds 1-4 folded in; user chose the
> **write-sequence CAS**. Verified against `src/lib/shared/with-timeout.ts:23-27`:
> `withTimeout` *races*, it does NOT cancel — so a timed-out `saveCursor` detaches
> and can land late. `inProgress`+`withTimeout` alone cannot serialize writes.
> A **monotonic `write_seq` stamped in the row** rejects any stale/late/reordered
> write at the DB (`WHERE EXCLUDED.write_seq > poller_cursors.write_seq`), closing
> all ordering races unconditionally — rotation-ABA, cross-save-attempt, and the
> non-cancellation window — independent of cadence.

## Design (codebase-design vocabulary)

We **deepen** the poller and add **two small deep modules** + two migrations. No
interface widens across seams. Ownership split (locality):

- **`reconcileCycle(signal, progress)`** owns per-account work + the **in-memory**
  cursor advance/reset, and updates the shared `progress` snapshot. No persistence.
- **`runOnce`** owns the lifecycle: single-flight guard, deadline, truncation
  classification + alert, and the cursor persist — all in `try/catch/finally`.

### Progress snapshot — the narrow interface between the two
`progress = { queryCompleted: false, total: 0, dispatched: 0 }`. `reconcileCycle`
sets `queryCompleted = true` + `total = accounts.length` right after the accounts
query returns; the fan-out increments `dispatched` per claim (single-threaded, no
lock). `runOnce.finally` reads it and classifies via pure `classifyCycle`:
- `!queryCompleted` → **stalled** (timed out before/at the query). Counter untouched.
- `queryCompleted && total === 0` → **drained** (empty list — resets the counter).
- `queryCompleted && dispatched < total` → **truncated**.
- `queryCompleted && dispatched === total` → **drained** (even if a `TimeoutError`
  fired on a slow tail after full dispatch).

### Cursor persistence — write-sequence CAS (provable ordering)
`reconcileCycle` mutates only the in-memory `accountCursor` (advance to last-claimed
id, or NULL at rotation end). Persistence is a **monotonic-sequence CAS**:
- `poller_cursors` carries `write_seq bigint NOT NULL DEFAULT 0`.
- The poller holds an in-memory `writeSeq`, **seeded at boot from the persisted
  `write_seq`** (so post-restart writes are never rejected as stale).
- Each `runOnce.finally` assigns a fresh seq synchronously *before* awaiting:
  `writeSeq += 1; const seq = writeSeq;` then
  `await withTimeout(saveCursor(sql, POLLER_NAME, accountCursor, seq),
    CURSOR_SAVE_TIMEOUT_MS, 'cursor save').catch(log)`, then release `inProgress`.
- `saveCursor` UPSERTs with the CAS guard:
  ```sql
  INSERT INTO poller_cursors (poller_name, cursor, write_seq, updated_at)
  VALUES ($1, $2, $3, now())
  ON CONFLICT (poller_name) DO UPDATE
    SET cursor = EXCLUDED.cursor, write_seq = EXCLUDED.write_seq, updated_at = now()
    WHERE EXCLUDED.write_seq > poller_cursors.write_seq
  ```
A detached save A (seq 5) that lands after save B (seq 6) fails `5 > 6` → no-op.
Because `writeSeq` is monotonic with *submission* order (assigned synchronously in
`finally`), the highest-seq write that lands always reflects the latest-submitted
intent — cadence-, rotation-, and cancellation-independent. The save is still
`withTimeout`-bounded so it can never wedge `inProgress` (invariant #3).

### New modules
- **`billing-reconciliation/cursor-store.ts`** —
  `loadCursor(sql, pollerName): Promise<{ cursor: string | null; writeSeq: number }>`
  / `saveCursor(sql, pollerName, cursor, writeSeq): Promise<void>` (CAS UPSERT
  above). Takes `sql` (invariant #15).
- **`billing-reconciliation/reconcile-progress.ts`** — pure fns (fast-check
  surface): `nextCursor(dispatched, accounts)`, `classifyCycle(progress)`,
  `evaluateTruncation(consecutive, cycle, threshold)` (fire-once, clamped; stalled
  untouched, drained resets, truncated increments + alerts on
  `consecutive + 1 === threshold`).
- **`billing-reconciliation/truncation-alert.ts`** — mirrors `drift-alert.ts`;
  `emitTruncationAlert({pollerName, consecutive, dispatched, total, cycleDeadlineMs})`.

## Safety invariant (corrected; cadence-independent; ADR-worthy)
The persisted cursor only ever holds an id a real cycle **claimed** — NOT
necessarily one fully reconciled: per-account reconcile is itself
`withTimeout(..., ACCOUNT_TIMEOUT_MS)` (non-cancelling), so a claimed account whose
reconcile timed out is *attempted, not guaranteed processed*. Consequences:
- **Never a permanent skip.** On restart we resume *after* the persisted id;
  accounts ≤ it were claimed this rotation. A claimed-but-timed-out account is
  simply re-checked on the **next rotation** — drift detection defers at most one
  rotation, never disappears (drift is durable + idempotent to re-check).
- **Ordering is provable** via the `write_seq` CAS — no stale/detached/reordered
  write can regress the durable cursor. This replaces the (false) "serialized by
  inProgress" reasoning that Rev 4 relied on.

## Tracer bullets (each runs end-to-end; blocking edges noted)

### T1 — Persisted cursor (migration 081 + cursor-store CAS + runOnce.finally save)
**Blocked by:** none.
1. `supabase/migrations/081_poller_cursors.sql`: `CREATE TABLE poller_cursors
   (poller_name text PRIMARY KEY, cursor uuid, write_seq bigint NOT NULL DEFAULT 0,
   updated_at timestamptz NOT NULL DEFAULT now())`. `ENABLE ROW LEVEL SECURITY`,
   **no policies** (deny-all; service role bypasses — `flagged_responses`
   precedent). Transactional, no CONCURRENTLY. Header: additive, staging-first,
   both projects in lockstep.
2. `cursor-store.ts` (CAS UPSERT; `loadCursor` returns `{cursor, writeSeq}`) +
   `POLLER_NAME = 'stripe_locations_reconcile'` + `CURSOR_SAVE_TIMEOUT_MS`
   (e.g. 10_000) in `constants.ts`.
3. Poller wiring:
   - Boot: `start()` kicks `cursorLoaded = loadCursor(...)` bounded by its own
     `withTimeout`, `.then(({cursor, writeSeq}) => { accountCursor = cursor;
     writeSeq0 = writeSeq }).catch(err => { log; accountCursor = null })`. Seed the
     in-memory `writeSeq` from the loaded value.
   - `reconcileCycle` awaits `cursorLoaded` at its top (inside the cycle deadline)
     before reading `accountCursor`; keeps only the in-memory advance/reset.
   - `runOnce.finally`: classify+alert (best-effort), then `writeSeq += 1` and the
     awaited+bounded CAS `saveCursor`, then release `inProgress` (structure above).
   - Update the lines 74-76 comment to the corrected safety invariant.
4. Tenant-scope: `pnpm ci:tenant-scope`; allowlist `poller_cursors` in `scripts/ci/`
   if it trips (no account_id — holds no tenant data).
5. Tests (`worker/background/pollers/__tests__/`):
   - PROPERTY (fast-check): `nextCursor` — last-claimed id when partial, null at
     rotation end.
   - PROPERTY (fast-check): **CAS monotonicity** — over any interleaving of saves
     with assigned seqs, the persisted value equals the highest-seq write; a
     lower-seq write arriving later is a no-op (store fake honoring the CAS).
   - UNIT: **the decisive race** — save A times out (wrapper rejects) while its
     underlying promise is pending; save B (higher seq) completes; A then resolves
     late and is rejected by the CAS (persisted stays B). Include a rotation/NULL
     boundary variant.
   - UNIT: boot seeds `writeSeq` from the persisted `write_seq`, so the first
     post-restart save (seq = loaded+1) is NOT rejected.
   - UNIT: a never-settling boot load is bounded by the cycle deadline and releases
     `inProgress`; boot load seeds `accountCursor` before the first cycle reads it.
   - UNIT: a `saveCursor` rejection/timeout in `finally` is swallowed and
     `inProgress` is still released.

### T2 — Composite index — ❌ DROPPED at the ride-time EXPLAIN gate (step 8)
**Outcome:** built as migration 082 (`idx_accounts_reconcile_status_id` on
`accounts (subscription_status, id)`), applied to staging, then **dropped with
user sign-off** after the mandatory `EXPLAIN (ANALYZE, BUFFERS)` gate — which is
exactly the "decide with evidence" branch this step required. The planner picks
`accounts_pkey` for the keyset query even with `enable_seqscan=off` (the PK already
serves `id > cursor ORDER BY id`; the low-selectivity `subscription_status` filter
doesn't earn the lead column), and both prod and staging are empty pre-launch, so
there is no evidence the index helps. It is a one-line CONCURRENTLY migration,
re-addable later if a future prod EXPLAIN shows need. Evidence + decision recorded
in the #479 deviations file. **T1 (cursor) and T3 (alert) ship; T2 does not.**

### T3 — Sustained-truncation alert (snapshot classification + emitter)
**Blocked by:** T1 (shares the poller file).
1. `truncation-alert.ts` + `reconcile-progress.ts` (`classifyCycle`,
   `evaluateTruncation`) + `TRUNCATION_ALERT_THRESHOLD = 3` in `constants.ts`.
2. Thread `progress` through `runOnce` → `reconcileCycle`; classify + alert in
   `runOnce.finally`. `resetTruncationStateForTests()` beside
   `resetAccountCursorForTests`.
3. Tests:
   - PROPERTY (fast-check): over any sequence of {truncated, drained, stalled}
     cycles, `evaluateTruncation` fires exactly on the first crossing, never
     re-fires, resets on drain, ignores stalled.
   - UNIT (via `runOnce`): (a) `TimeoutError` after full dispatch → drained, no
     alert; (b) boot stall (`queryCompleted === false`) → stalled, untouched; (c)
     successful **empty** list → drained, resets; (d) 3 consecutive truncations →
     one alert; (e) immediate re-entry after a timeout runs cleanly.
   - UNIT: `emitTruncationAlert` → Sentry warning + tag when SENTRY_DSN set, log
     fallback otherwise (mirror the drift-alert test).

## Ordering
T1 → T2 → T3 (sequential subagents; T1 and T3 both edit the poller). Each commits.

## Gate (step 5) & risks
- Standard gate; `pnpm build` N/A (backend); `ci:tenant-scope` + `ci:rls-audit`.
  Property tests required (billing/state-machine) — T1 + T3.
- `accounts` billing-critical → CONCURRENTLY avoids the ACCESS EXCLUSIVE lock; a
  failed CONCURRENTLY leaves an INVALID index (drop + retry per header).
- Persistence never holds `inProgress`/blocks a tick: boot load awaited only inside
  the cycle deadline; the `finally` CAS save is `withTimeout`-bounded + best-effort;
  ordering provable via `write_seq`, safety via the corrected never-skip invariant.
