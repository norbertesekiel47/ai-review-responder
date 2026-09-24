// Playwright globalSetup — holds the live-DB LANE lease for the whole run (#958).
//
// The app under test and the seed fixtures both point at TEST_DATABASE_POOL_URL
// (playwright.config.ts `webServer.env`, e2e/seed.ts), so a sibling worktree's
// `pnpm test:db:setup` dropping schema `public` mid-run would fail specs for a
// reason that has nothing to do with them. Holding the lane key SHARED from
// here to teardown makes provisioning wait for this run, and this run wait for
// a provision already in progress — the same lease the vitest integration
// project takes (vitest.integration-lane.ts). The marker is validated first,
// so a behind-head database fails the run once, with one actionable line.
//
// Skipped (never locked) when there is no test database, and when
// TEST_DATABASE_POOL_URL is not the shared LOCAL one — the deep auth-harness
// tier points it at STAGING, which this protocol does not govern
// (e2e/harness.ts).
//
// Relative import: this file runs under Playwright's loader, not vitest's, so
// it depends on nothing but the path.
import { openLiveDbLaneLease } from '../src/lib/shared/__tests__/helpers/live-db-lane';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const decision = await openLiveDbLaneLease(process.env.TEST_DATABASE_POOL_URL);
  if (decision.kind === 'skipped') {
    console.log(`[e2e] live-DB lane lease not taken: ${decision.reason}`);
    return async () => undefined;
  }
  const { lease } = decision;
  return () => lease.release();
}
