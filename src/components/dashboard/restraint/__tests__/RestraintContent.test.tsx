// @vitest-environment jsdom
//
// `RestraintContent` — orchestrator eval (#1014 T1, RED).
//
// Titles 32-36 and 48, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// All `it.todo` at T1: `RestraintContent.tsx` does not exist yet, and a named
// import of an absent module fails the whole file at collection. Task 7 adds
// the component, the import and these bodies.
//
// TWO CARRY-FORWARD FINDINGS SHAPE THIS FILE. ST-1 is that the parked branch
// hand-rolled its own fetch, so the first title pins `useQuery` and forbids
// hand-rolled keying, staleness and abort. ST-2 is that the Analytics tab bar
// vanished during load and error on one route and persisted on the other, so
// two titles pin the bar through BOTH branches — the fix lands in the shared
// state panel (Task 6), not here, and these tests are what stop it being
// re-implemented locally.
//
// The error-card title came from plan round 1 and is not padding: the shared
// panel gates `showError` on `hasData`, so a FIRST-load failure renders a
// skeleton that never resolves. This test fails against the panel as it stands
// today, which is the point.

import { describe, it } from 'vitest';

describe('RestraintContent', () => {
  it.todo('RestraintContent fetches through useQuery and hand-rolls no keying, staleness or abort');
  it.todo('RestraintContent renders the shared dashboard state panel while loading');
  it.todo('RestraintContent renders the shared dashboard state panel on error');
  it.todo('RestraintContent keeps the Analytics tab bar visible while loading');
  it.todo('RestraintContent keeps the Analytics tab bar visible on error');
  it.todo('RestraintContent renders the restraint error card when the initial query fails without cached data');
});
