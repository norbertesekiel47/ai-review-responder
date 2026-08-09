# feat-729 — Extract the Generate transaction into a named domain module

Ticket: #729 (wayfinder map #710, item 3). Intake:
`docs/superpowers/plans/feat-729-generate-domain-module-intake.json`.
RISK = normal · SURFACE = mixed · behaviour-preserving refactor.

## Design (codebase-design vocabulary)

We are **deepening the review domain**, not adding a hypothetical seam. The
Generate transaction today lives inline in an HTTP entry point, so its only
interface is "the whole route" — untestable except through HTTP mocks, and it
forces 3 tenant-root-lookup allowlist entries because the audit sees unscoped
sibling reads in a route file.

- **Module**: `src/lib/reviews/on-demand-generate.ts` — one exported function
  `onDemandGenerateTx(tx, { reviewId, businessId })` returning a discriminated
  union. Small interface, deep implementation: lock ordering, the TOCTOU
  writable re-check, three sibling exclusions, orphan semantics, version
  allocation (D-B), and the atomic outbox enqueue all hide behind one call.
- **Seam**: the review domain (`src/lib/reviews/`), alongside its live-ingest
  cousin `process-review.ts` and the enqueue-owning `import-consent.ts`. The
  ticket rules out `src/lib/responses/**` framing — this is a review door, not
  an LLM module.
- **Adapter/caller**: the route stays the composition root (invariant #15) —
  auth, rate limits, ownership proof, `sql.begin`, result→HTTP mapping.
- **Justification for a new file** (anti-slop rule): the seam is demanded by
  invariants #12 and #15; `process-review.ts` was considered and rejected —
  different door, different trigger (webhook vs owner click), and it would
  couple the two lanes' failure vocabularies.
- **The interface is the test surface**: the module's focused tests exercise
  the union through `onDemandGenerateTx` with a captured-template tx mock —
  no HTTP, no NextResponse.

## Module interface (locked)

```ts
// src/lib/reviews/on-demand-generate.ts
import type { TransactionSql } from 'postgres';

export type OnDemandGenerateResult =
  | { ok: true; outboxId: string; version: number }
  | { ok: false; reason: 'review_not_found' }
  | { ok: false; reason: 'not_writable'; status: 402 | 403; error: string }
  | { ok: false; reason: 'already_answered' }
  | { ok: false; reason: 'draft_already_exists'; existing: { response_id: string; status: string } }
  | { ok: false; reason: 'orphan_recovery_pending' }
  | { ok: false; reason: 'regenerate_in_progress' };

export async function onDemandGenerateTx(
  tx: TransactionSql,
  args: { reviewId: string; businessId: string },
): Promise<OnDemandGenerateResult>
```

Implementation notes (all behaviour-preserving):

- Query text moves verbatim EXCEPT: the posted-sibling read, the non-terminal
  read, and the `MAX(version)` read each gain
  `AND business_id = ${businessId}::uuid` (zero cost — businessId is already
  resolved and locked; same move the orphan read already made). This is what
  lets the 3 allowlist entries come out (Task 3).
- The `job_outbox` in-flight read keeps the literal
  `('pending', 'dispatching', 'dispatched')` — byte-for-byte contract,
  `ci:outbox-status` checks members AND order. `job_outbox` is not a tenant
  table; no scoping change there.
- `statusArraySql(tx, NON_TERMINAL_STATUSES)` — pass tx, never the singleton
  (the route today passes `sql` inside the tx query; tx is the correct
  instance and is assignable).
- `uuidv7`, `enqueueGenerateResponse`, `QUEUE_NAMES`,
  `NON_TERMINAL_STATUSES`, `statusArraySql`, `POST_AFTER_DELETE_FAILED_PREFIX`,
  `GENERATE_RESPONSE_ORIGIN_LANE`, `assertWritableSubscriptionForBusiness`
  imports move to the module. The invariant #3 / #2 header comment block
  (origin-lane exclusion, suppressNotification belt-and-braces, ticket #678
  do-not-delete note) moves to the module header — the constraint lives with
  the code that owns it.
- The module never imports `@/lib/db/server` (`ci:db-imports` enforces).

## Route mapping table (locked — preserves today's bytes, including the
NO_STORE_HEADERS asymmetry; do NOT normalize headers in this ticket)

| Result | HTTP |
|---|---|
| `ok: true` | 200 `{ outbox_id, version }`, no NO_STORE |
| `review_not_found` (in-tx) | 404 `{ error: 'review_not_found' }`, no NO_STORE (pre-tx ownership 404 keeps NO_STORE, unchanged) |
| `not_writable` | `status` from result, `{ error }`, WITH NO_STORE |
| `already_answered` | 409, no NO_STORE |
| `draft_already_exists` | 409 `{ error, existing: { response_id, status } }`, no NO_STORE |
| `orphan_recovery_pending` | 409, no NO_STORE |
| `regenerate_in_progress` | 409 `{ error: 'regenerate_in_progress' }`, no NO_STORE |

The `on_demand_generate_enqueued` log line moves to the route, emitted after
`sql.begin` resolves on `ok: true` — same logger prefix and fields; now fires
post-commit instead of pre-commit (deliberate delta, recorded in the intake's
observability field). `catch` → `reportCaughtError('reviews/generate', …)` +
500 mapping unchanged.

## Tasks (tracer bullets, serial — shared files)

### T1 — EVAL: module-focused failing suite (commit first)

`src/lib/reviews/__tests__/on-demand-generate.test.ts` with the intake's 9
`tests_to_add` titles VERBATIM. RED until T2 (dynamic-import the module per
the house pattern so each title fails individually). Mock shape: the
captured-template tx mock from
`src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts`
(named precedent) — but capture SQL text on the tx calls too (title 9 asserts
`business_id` appears in every sibling read). Mock
`@/lib/shared/writable-subscription` by module path. `tx.json` pass-through so
the enqueue payload lands in captured params.

### T2 — module + route rewire (turns T1 green; blocking edge: T1)

Create the module per the locked interface; slim the route to composition
root per the mapping table. HARD CONSTRAINT: the two existing suites
(`route.test.ts`, `generate-version.integration.test.ts`) are the
characterization eval and must pass UNCHANGED — any edit to them is a
deviations entry with justification, not a silent fix.

### T3 — allowlist cleanup (blocking edge: T2)

Delete the 3 `generate/route.ts` tenant-root-lookup entries from
`scripts/ci/tenant-scope-allowlist.ts` (~lines 1300–1324) and move
`ALLOWLIST_BASELINE` 412 → 409 in the same edit. `pnpm ci:tenant-scope` green
proves both the removal and that the natively-scoped queries need no new
entries.

## Gate

Standard set + `pnpm vitest run generate-version.integration` (intake
verification_commands — the live-DB characterization suite runs even though
its file is untouched; local test DB is provisioned at head per 2026-08-08).

## Property-test note (stated exception)

The workflow requires fast-check property tests when touching auto-approval
logic. This ticket relocates code without changing any policy: the
auto-approval predicate itself lives in `worker/jobs/response-generation/`
and is untouched. The invariant "the enqueue always pins
`ON_DEMAND_GENERATE` + `suppressNotification: true`" has no input space to
property-test over (both are constants at the single call site); the example
test (title 8) plus `ci:outbox-seam` pin it. Recorded here so the exception
is a decision, not an omission.

## Review plan (step 7)

Two axes (normal lane): spec-vs-intake agent + standards agent. Blast-radius
input matters here: `route.ts` has zero importers (Next.js route), but the
moved constants' importers and the two audit scripts see the file move.
