# Deviations — #479 Stripe reconcile remainders

Small, in-scope departures from the plan, recorded per the T1 instructions.

## T1

- **`reconcile-progress.ts` created in T1 with only `nextCursor`.** The plan lists
  `reconcile-progress.ts` under "New modules" with three fns and re-lists it in
  T3's step 1 (`classifyCycle`, `evaluateTruncation`). T1 needs `nextCursor` as an
  exported fast-check surface (T1 test list), so the file is created now holding
  ONLY `nextCursor`; T3 extends it with the classification fns + the
  `{queryCompleted,total,dispatched}` progress snapshot. No progress-snapshot
  plumbing was added to the poller in T1 (not needed for the cursor persist), so
  `reconcileCycle`'s signature is unchanged (`(signal)`), leaving the `progress`
  param for T3.

- **Extra constant `CURSOR_LOAD_TIMEOUT_MS` (10_000) added to `constants.ts`.** The
  plan enumerated `POLLER_NAME` + `CURSOR_SAVE_TIMEOUT_MS` only, but plan step 3
  requires the boot load be "bounded by its own withTimeout". That bound needs a
  value; added alongside the save timeout. Its purpose is to free a parked
  connection in the ~45s window between `start()` and the first tick, where
  nothing else awaits the load.

- **Never-settling-boot-load test asserts recovery, bounded by whichever timeout
  fires first.** The plan's test wording says "bounded by the cycle deadline". In
  the implementation the boot load has BOTH its own 10s `withTimeout` AND the
  240s cycle deadline (reconcileCycle awaits `cursorLoaded` inside runOnce's
  `withTimeout`); the earlier 10s bound wins in the never-settling case. The test
  advances past every bound (240s+) and asserts the essential guarantee —
  `inProgress` is released and the next tick runs — so it is agnostic to which
  bound fires. Both bounds exist; defense-in-depth.

- **`PollerCursor` type defined locally in `cursor-store.ts`** (its `loadCursor`
  return type) rather than added to `billing-reconciliation/types.ts`, to keep the
  edit surface tight and colocate the type with its sole owner.

- **`ci:tenant-scope` did NOT trip on `poller_cursors`** (it holds no `account_id`
  and is not a tenant table), so no `scripts/ci/` allowlist entry was needed. The
  plan flagged this as conditional ("if it trips").
