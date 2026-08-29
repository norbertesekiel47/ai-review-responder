// The Refusal Log eval — live-DB read half (T0, red-first).
//
// Titles are VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches them as fixed strings.
//
// WHY THIS FILE IS NAMED `*.integration.test.ts`. That glob is what puts a
// suite in vitest's serialized `integration` project (vitest.config.ts). Every
// case below reaches the shared local Postgres once T2–T4 land, and a live-DB
// suite that misses the suffix runs in the fully parallel project alongside
// every other live-DB writer — the #573 deadlock. The name is load-bearing and
// must not change when the bodies are filled in.
//
// Run it, once there is something to run:
//   TEST_DATABASE_POOL_URL=postgres://…localhost… \
//     pnpm vitest run src/lib/refusals/__tests__/read.integration.test.ts
//
// TWO CONVENTIONS THE BODIES MUST KEEP (`.claude/CLAUDE.md`, enforced by
// `pnpm ci:live-db-suites`):
//   1. No run-time DDL. The schema is provisioned once by `pnpm test:db:setup`;
//      assert it with `assertSchemaReady`, never apply migrations here.
//   2. Enrol in the cross-process lock (`acquireLiveDbLock`) before seeding —
//      these fixtures write `solicitation_*`, `flagged_responses`,
//      `approval_audit_log` and `account_audit_log`, all of which sibling
//      suites truncate.
// Precedent to copy for the tenant fixtures, the lock and the local-host
// refusal guard: `src/lib/solicitation/__tests__/batch-view.integration.test.ts`.
//
// `src/lib/refusals/read.ts` does not exist at this commit, so every case is
// `it.todo` — a static import of a missing module fails the whole FILE at
// collection and would run none of these. No database is opened yet.
//
// PER-ARM PROOF (plan §6 T4, intake invariant 1). The read is ONE `UNION ALL`,
// so a structural assertion over the combined SQL cannot prove any single arm is
// scoped. Every arm therefore carries its own behavioural foreign-account or
// foreign-location negative-row case below; do not collapse them.

import { describe, it } from 'vitest';

describe('getRefusalLog tenant isolation', () => {
  it.todo('getRefusalLog never returns a held-draft row from another account');

  it.todo('getRefusalLog never returns a held-draft row from another location');

  it.todo('getRefusalLog never returns a downgrade row from another account');

  it.todo('getRefusalLog never returns a withheld ask from another location');

  it.todo('getRefusalLog never returns a withheld outreach from another location');

  it.todo('getRefusalLog never returns a halted batch from another location');

  // Both tables carry independent FKs (flagged_responses at 051:15), not
  // tenant-composite keys, so a scoped ROOT row can still reach a foreign
  // review/response through an unscoped JOIN. The predicate is repeated on the
  // join, not only on the root.
  it.todo('getRefusalLog does not expose a foreign review through a cross-tenant flagged-response join');

  it.todo('getRefusalLog does not expose a foreign response through a cross-tenant approval-audit join');
});

describe('getRefusalLog account-wide sources', () => {
  // S4 is `account_audit_log`, which has no location key: a suspension applies
  // to every location, so it appears in every location scope. Join nothing to
  // `businesses` here — an account-wide arm joined through locations multiplies
  // one audit row by the location count.
  it.todo('getRefusalLog includes an account-wide autonomy suspension in location scope');

  it.todo("getRefusalLog excludes another account's autonomy suspension in location scope");

  it.todo('getRefusalLog counts one autonomy suspension exactly once in aggregate scope');

  it.todo('getRefusalLog counts one autonomy suspension exactly once in location scope');
});

describe('getRefusalLog source presence', () => {
  it.todo('getRefusalLog includes a held draft as unsafe_content');

  it.todo('getRefusalLog includes an auto-policy downgrade with its mapped category');

  it.todo('getRefusalLog includes an autonomy suspension as autonomy_paused');

  it.todo('getRefusalLog includes a withheld ask with its mapped category');

  it.todo('getRefusalLog includes a withheld outreach with its mapped category');

  it.todo('getRefusalLog includes an admin_halt batch as autonomy_paused');

  it.todo('getRefusalLog includes a platform_halt batch as autonomy_paused');

  it.todo('getRefusalLog returns two entries when one response is downgraded twice');

  // `unsuspendAccountAutonomy` clears both policy columns (suspension.ts:352-354),
  // so the durable trace is the audit row and a lifted suspension still appears.
  it.todo('getRefusalLog includes a suspension after the policy is later unsuspended');

  it.todo('getRefusalLog drops a flagged response whose review row is gone');

  it.todo('getRefusalLog returns an empty result for an account with no refusals');
});

describe('getRefusalLog S6 timestamp anchor', () => {
  // `commitWithhold` (dispatch.ts:1371-1379) sets `agent_run_id` in the same
  // statement, and `agent_runs.started_at` (071:25) is DEFAULT NOW() with no
  // updater — so the lazy child run start IS the refusal time, durably.
  // `rendered_at` predates the refusal; `updated_at` is a general mutation
  // timestamp a later write can move, hence fallback only.
  it.todo('getRefusalLog anchors a dispatch-time outreach refusal on its lazy child run start');

  it.todo('getRefusalLog falls back to updated_at for a withheld outreach with no agent run');

  it.todo('getRefusalLog does not move a withheld outreach entry when the row is mutated later');
});

describe('getRefusalLog window boundaries', () => {
  it.todo('getRefusalLog includes an entry timestamped exactly at the window start');

  it.todo('getRefusalLog excludes an entry before the window start');

  it.todo('getRefusalLog excludes an entry after the window end');
});

describe('getRefusalLog exclusions', () => {
  // S6 reads the WITHHELD arm only. The cancelled arm is out of scope entirely,
  // including its admin_halt/platform_halt copies — S7 already counts that halt
  // once at the batch.
  it.todo('getRefusalLog excludes the cancelled arm of solicitation_outreach entirely');

  it.todo('getRefusalLog excludes owner_veto, owner_halt, owner_excluded and owner_withdrawn');

  it.todo('getRefusalLog excludes send_failed, send_exhausted, batch_expired and send_window_elapsed');

  it.todo('getRefusalLog excludes superseded and send_indeterminate outreach outcomes');

  // BatchReport.tsx:27 already rules this volume shaping, not a refusal.
  it.todo('getRefusalLog excludes velocity_banked');
});
