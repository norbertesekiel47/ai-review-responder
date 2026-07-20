import { describe, expect, it } from 'vitest';

import { runEmergencyCleanup } from '../../wedge-repro';

// The staging safety gate (assertStagingTarget, describeConnectionTarget, the
// prod denylist) was extracted to scripts/staging-guard.ts in task T1 — its tests
// now live in scripts/ci/__tests__/staging-guard.test.ts. This file keeps covering
// wedge-repro's own remaining logic: the SIGINT/SIGTERM emergency-cleanup ordering.

describe('runEmergencyCleanup (signal-path ordering — F3)', () => {
  it('kills worker children BEFORE terminating backends, THEN closes the observer', async () => {
    const order: string[] = [];
    await runEmergencyCleanup({
      killChildren: async () => {
        order.push('kill-children');
      },
      terminateBackends: async () => {
        order.push('terminate-backends');
      },
      closeObserver: async () => {
        order.push('close-observer');
      },
    });
    // Load-bearing: a child left alive can re-wedge backends AFTER the terminate
    // pass, so children must die first.
    expect(order).toEqual(['kill-children', 'terminate-backends', 'close-observer']);
  });

  it('still runs the later steps when an earlier step rejects', async () => {
    const order: string[] = [];
    await runEmergencyCleanup({
      killChildren: async () => {
        order.push('kill-children');
        throw new Error('child kill blew up');
      },
      terminateBackends: async () => {
        order.push('terminate-backends');
      },
      closeObserver: async () => {
        order.push('close-observer');
      },
    });
    expect(order).toEqual(['kill-children', 'terminate-backends', 'close-observer']);
  });
});
