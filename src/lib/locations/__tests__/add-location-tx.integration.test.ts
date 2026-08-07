// src/lib/locations/__tests__/add-location-tx.integration.test.ts
//
// T0 EVAL suite for #677 — titles 44, 46, 47, 48 and 65 of the intake's 70,
// authored VERBATIM before implementation.
//
// Import consent LINEAGE: when an archived location is re-added, the new
// `businesses` row inherits the archived sibling's consent columns verbatim, so a
// declined place cannot be re-offered (and re-imported) by archiving and
// re-adding it.
//
// WHY FIVE OF SIX LIVE (owner decision, 2026-08-07, deviations D6): the match is
// a **disjunction over non-NULL keys** with an ORDER BY tie-break and an
// account-scope predicate — pure SQL semantics. A mocked `sql` tag can prove the
// template was interpolated; it cannot prove the sibling actually selected is the
// right one. Only title 45 (no archived sibling → stays pending) is a mocked
// binding assertion, and it lives in add-location-tx.test.ts.
//
// The lineage key, corrected twice (round-1 F103, then round-2 Medium):
// revision 2 chose the key from the NEW row only — place id if present, else maps
// url — which still missed the cross-representation case. URL-mode adds
// deliberately store a `google_maps_url` with a NULL `google_place_id` until
// validate_place_id resolves it (add-location-tx.ts:263-279), so BOTH directions
// occur in practice. A sibling therefore qualifies when its `google_place_id`
// equals the new row's (both non-NULL) OR its `google_maps_url` equals the new
// row's (both non-NULL) — never NULL to NULL, in either column.
//
// Titles 47 and 65 are the two directions, and they are NOT redundant:
//   47 — new row has the place id, archived sibling's place id is NULL
//   65 — the same shape stated from the new row's side, which is the case
//        revision 3's title 66 claimed to cover but did not (it asserted equal
//        place ids with differing URLs — the ordinary branch). Round 3 retargeted
//        it; do not re-merge them.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema, and
// NEVER applies migration SQL.
//
import { describe, it } from 'vitest';

describe('add-location Import consent lineage against live Postgres', () => {
  // The D8 hole this whole task closes: declined must survive a re-add.
  it.todo("add-location inherits a declined sibling's import consent when re-adding an archived place");

  // Round-1 Medium (F104): `archived_at` alone is nondeterministic on a tie, so
  // the ordering is `archived_at DESC, created_at DESC, id DESC`. The
  // foreign-account half is invariant #8.
  it.todo('add-location inherits consent from the most recently archived sibling in the same account and ignores foreign-account siblings');

  it.todo('add-location inherits consent through google_maps_url when the archived sibling has a NULL google_place_id');

  // "Verbatim including both timestamps" is the load-bearing phrase: copying the
  // decision without `import_offer_expires_at` would hand an inherited `pending`
  // row a NULL deadline, which is the round-1 Critical (a NULL deadline was
  // answerable) reintroduced through the side door.
  it.todo('add-location copies accepted and live-pending sibling consent verbatim including both timestamps');

  it.todo('add-location inherits consent through equal google_maps_url when the new row has a place id and the archived sibling place id is NULL');
});
