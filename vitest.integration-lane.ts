// globalSetup of the vitest `integration` project — the LANE lease (#958).
//
// vitest runs this once, in the main process, before the first file of the
// project starts, and runs the returned teardown after the last file's
// afterAll has finished. Holding the shared lane key for exactly that span is
// what closes the gap a per-suite lease left open: the project serializes its
// FILES, so a lease released between files let a sibling worktree's
// `pnpm test:db:setup` drop schema `public` under the next one.
//
// The protocol, both keys, and why a lane never takes its own key exclusive:
// src/lib/shared/__tests__/helpers/live-db-lane.ts (header).
//
// A crash or SIGKILL of this process ends the lease session, which releases the
// lock — there is no path that leaves it held after the lane is gone.

import type { TestProject } from 'vitest/node';
import { openLiveDbLaneLease } from './src/lib/shared/__tests__/helpers/live-db-lane';
import { resolveTestDatabaseUrl } from './src/lib/shared/__tests__/helpers/live-db-lock';

export interface LiveDbLaneContext {
  applicationName: string;
  lockKey: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** The lane lease this run holds, or null when the lane runs without a database. */
    liveDbLane: LiveDbLaneContext | null;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // The same resolution the lane's suites use (env first, then .env.local, and
  // REPWORTH_DISABLE_LIVE_DB_SUITES=1 → none), so the lease covers every suite
  // that can wake — no wider, no narrower.
  const decision = await openLiveDbLaneLease(resolveTestDatabaseUrl());
  if (decision.kind === 'skipped') {
    project.provide('liveDbLane', null);
    return async () => undefined;
  }
  const { lease } = decision;
  project.provide('liveDbLane', {
    applicationName: lease.applicationName,
    lockKey: lease.lockKey,
  });
  return () => lease.release();
}
