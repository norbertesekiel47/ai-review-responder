import { describe, expect, it } from 'vitest';
import {
  checkFailedOutboxByTopic,
  checkOldestPendingOutbox,
  checkStaleDispatching,
  checkOpenFlaggedResponses,
  checkZeroDeliveryNotifications,
  type HealthAlertConfig,
  checkBacklogDepth,
} from '../health-alert/checks';
import { REAPABLE_MARKER } from '../pool-wedge-reaper/reaper-query';

const CFG: HealthAlertConfig = {
  pendingAgeThresholdS: 900,
  failedWindowS: 3600,
  failedThreshold: 0,
  staleDispatchingThresholdS: 600,
  flaggedOpenThreshold: 5,
  zeroDeliveryWindowS: 3600,
  backlogDepthThreshold: 1500,
};

// A tagged-template `sql` stand-in that captures the FIRST template chunk
// (`strings[0]`) each check issues. postgres.js seeds the query text it sends to
// the server with `strings[0]` verbatim (types.stringify, no trimming — verified
// against postgres@3.4.9), so `strings[0]` is the literal prefix pg_stat_activity
// exposes. Asserting it begins with the marker is therefore equivalent to
// asserting the reaper's anchored match `query LIKE '/* rw-reapable */%'` fires.
function capturingSql() {
  const firstChunks: string[] = [];
  const capture = ((strings: TemplateStringsArray) => {
    firstChunks.push(strings[0] ?? '');
    return Promise.resolve([]);
  }) as unknown as import('postgres').Sql;
  // checkBacklogDepth wraps its count in sql.begin + a SET LOCAL via tx.unsafe;
  // neither is a marker-bearing statement, so begin hands back the same capture
  // and unsafe is a no-op — only tagged-template statements are asserted.
  // Loose casts: postgres.js's own unsafe/begin signatures are far richer than
  // this capture needs.
  (capture as { unsafe: unknown }).unsafe = () => Promise.resolve([]);
  (capture as { begin: unknown }).begin = (fn: (tx: unknown) => Promise<unknown>) => fn(capture);
  return { sql: capture, firstChunks };
}

describe('health-alert checks — /* rw-reapable */ marker (reaper backstop identity)', () => {
  const checks: [string, (sql: import('postgres').Sql, cfg: HealthAlertConfig) => Promise<unknown>][] = [
    ['checkFailedOutboxByTopic', checkFailedOutboxByTopic],
    ['checkOldestPendingOutbox', checkOldestPendingOutbox],
    ['checkStaleDispatching', checkStaleDispatching],
    ['checkOpenFlaggedResponses', checkOpenFlaggedResponses],
    ['checkZeroDeliveryNotifications', checkZeroDeliveryNotifications],
    ['checkBacklogDepth', checkBacklogDepth],
  ];

  it.each(checks)('%s emits a query that BEGINS WITH the marker (no leading whitespace)', async (_name, check) => {
    const { sql, firstChunks } = capturingSql();
    await check(sql, CFG);
    expect(firstChunks).toHaveLength(1);
    // Anchored prefix: index 0, so the reaper's LIKE '/* rw-reapable */%' matches.
    expect((firstChunks[0] ?? '').startsWith(REAPABLE_MARKER)).toBe(true);
  });

  it('marks all six checks (the full opt-in set the reaper backstops)', () => {
    expect(checks).toHaveLength(6);
  });
});
