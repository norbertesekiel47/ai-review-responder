// #891 — `batchDidClose` is a POSITIVE enumeration, and this suite is its
// exhaustiveness pin: `VERDICT_BY_STATUS` is `satisfies Record<status, boolean>`,
// so adding a sixth arm to `CloseBatchIfSettledResult` fails this file's
// compile until someone decides the new arm's verdict — the fail-closed
// property the negation proxy (`!== 'not_settled'`) never had.

import { describe, expect, it } from 'vitest';
import { batchDidClose, type CloseBatchIfSettledResult } from '../outreach';

const COUNTS = {
  sent: 0,
  withheld: 2,
  cancelled: 0,
  failed: 0,
  unknown: 0,
  withheldByReason: { suppressed: 2 },
};

const RESULT_BY_STATUS: {
  [S in CloseBatchIfSettledResult['status']]: Extract<CloseBatchIfSettledResult, { status: S }>;
} = {
  no_send_parent: { status: 'no_send_parent' },
  closed_without_parent: {
    status: 'closed_without_parent',
    disposition: 'generation_failed',
    counts: COUNTS,
  },
  not_settled: { status: 'not_settled', liveCount: 3 },
  already_closed: { status: 'already_closed' },
  closed: {
    status: 'closed',
    parentRunId: '9f8e7d6c-0000-7000-8000-00000000000a',
    disposition: 'exhausted',
    parentStatus: 'completed',
    counts: COUNTS,
  },
};

const VERDICT_BY_STATUS = {
  closed: true,
  closed_without_parent: true,
  already_closed: true,
  not_settled: false,
  // The #891 defect arm: `no_send_parent` means NOTHING was written — an
  // all-withheld built batch is haltable, settles nothing, and must never
  // report `closed: true`.
  no_send_parent: false,
} as const satisfies Record<CloseBatchIfSettledResult['status'], boolean>;

describe('batchDidClose', () => {
  it.each(Object.keys(VERDICT_BY_STATUS) as (keyof typeof VERDICT_BY_STATUS)[])(
    'answers %s with its enumerated verdict',
    (status) => {
      expect(batchDidClose(RESULT_BY_STATUS[status])).toBe(VERDICT_BY_STATUS[status]);
    },
  );
});
