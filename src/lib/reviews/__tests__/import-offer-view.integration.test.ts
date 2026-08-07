// src/lib/reviews/__tests__/import-offer-view.integration.test.ts
//
// T0 EVAL suite for #677 — titles 40–43 and 66–67 of the intake's 69, authored
// VERBATIM before implementation.
//
// readImportOfferView is a three-table join (businesses × zernio_backfill_runs ×
// job_outbox) with row-selection precedence and an outbox-status → banner-state
// mapping. Live, not mocked (plan §2, round-1 F108): every title below is a
// property of the JOIN, and a mocked `sql` tag can only prove which template was
// interpolated.
//
// The three precedence rules under test are each a round-1 finding, not a
// preference:
//
//  - `completed_at` decides done, NEVER `imported_count`. The count DEFAULTs to 0
//    (100_….sql:65-67) and is written incrementally
//    (ZernioBackfillWorker.ts:379), so a mid-run read with a positive partial
//    count is still `importing`, and `empty` requires
//    `completed_at IS NOT NULL AND imported_count = 0`.
//  - Outbox status maps per the draft-status precedent (:95-143): the in-flight
//    set → `importing`; every terminal non-`completed` status → `failed`. Import
//    the set, never re-spell it (invariant #2).
//  - Row selection is explicit: run and outbox rows scoped to THIS business_id
//    and account, newest first. A stale or foreign row must never win the join
//    (invariant #8).
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema, and
// NEVER applies migration SQL.
//
import { describe, it } from 'vitest';

describe('readImportOfferView against live Postgres', () => {
  // The partial-count trap. This is the title that fails if the view reads
  // `imported_count > 0` as "done" — the most natural wrong implementation.
  it.todo('readImportOfferView reports importing for an incomplete run even when imported_count is already positive');

  it.todo('readImportOfferView returns empty only when the run completed with imported_count zero');

  it.todo('readImportOfferView reports failed for a terminal non-completed outbox row');

  it.todo('readImportOfferView ignores stale and foreign-account runs and outbox rows');

  // Titles 66–67 (round-2): revision 2's view suite asserted only the negative
  // and mid-run cases, so the two states the owner actually SEES on a happy path
  // had no live coverage at all.
  it.todo('readImportOfferView reports the imported count for a completed run against live Postgres');

  it.todo('readImportOfferView returns the offer state for a live pending offer against live Postgres');
});
