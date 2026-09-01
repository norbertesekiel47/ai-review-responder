// The Refusal ledger's READ path — pure-helper eval (#1014 T1, RED).
//
// This file holds NO promised title. All 22 read titles need a live database
// and live in `read.integration.test.ts`; the intake's `tests_to_add` places
// them there and the `promised-tests` gate row matches them there.
//
// What lands here instead are the two helpers Task 4 extracts from
// `getRefusalLog` so they can be proven without a database: the archived-period
// pairing (an `archived` audit row matched to its `reactivated` row, or to
// `null` when the location is still archived at the end of the window) and the
// window-intersection predicate that decides which of those periods the tab
// shows. Both are total functions over dates. A live-DB round trip would add
// nothing but serialization.
//
// They are `it.todo` because `src/lib/refusals/read.ts` does not exist yet and
// a named import of an absent module fails the whole file at collection.

import { describe, it } from 'vitest';

describe('archived-period helpers', () => {
  it.todo('pairs each archived audit row with the reactivation that follows it');
  it.todo('leaves reactivatedAt null for a location still archived at the end of the window');
  it.todo('treats a period as intersecting when it starts before the window ends and ends after the window starts');
});
