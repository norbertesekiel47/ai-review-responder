// src/components/dashboard/__tests__/DashboardContent.importOffer.test.tsx
//
// T0 EVAL suite for #677 — titles 55 and 56 of the intake's 70, authored VERBATIM
// before implementation.
//
// These two are MOUNT and SCOPE, and they are the reason the feature cannot ship
// green-but-invisible:
//
//  - Title 55 is the eval's bar item 5, "a feature that is never mounted". Every
//    other banner title in ImportOfferBanner.test.tsx renders the component
//    directly, so all seven would pass on a component that no page ever mounts.
//    This asserts DashboardOperationalContent actually renders it
//    (DashboardContent.tsx:125, beside the Connect banner slot at :310-320).
//
//  - Title 56 is round-1 High (F110): the react-query key must include the scoped
//    location id. A key that omits it serves location A's offer on location B —
//    which for THIS feature means one location's consent decision silently
//    answering for another's, the exact D8/D9 failure the ticket exists to
//    prevent.
//
// The banner sources its state from GET /api/dashboard/import-offer and NOT from
// DashboardDataActive, deliberately: getActiveDashboardData is Redis-cached
// (src/lib/dashboard/service.ts:118), so a declined offer would keep re-rendering
// for the whole TTL. src/lib/dashboard/** is absent from this feature's edit
// surface for that reason.
//
import { describe, it } from 'vitest';

describe('DashboardContent — Import offer mounting and scope', () => {
  it.todo('DashboardOperationalContent renders the Import offer banner for the location in scope');

  it.todo("switching location scope refetches the import offer and never reuses another location's state");
});
