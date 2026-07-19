import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  computeInjectionSchedule,
  buildDrillRow,
  buildScopedDeletePredicate,
  scopedDeleteWhereClauses,
  assertLoadTarget,
  generateDrillTag,
  buildReleaseHint,
  listRemainingDrillRows,
  DRILL_TOPIC,
  DRILL_AGGREGATE_TYPE,
  DRILL_MARKER_KEY,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_HORIZON_HOURS,
  type InjectConfig,
  type ReleaseConfig,
} from '../../burst-drill-load';

// These cover ONLY the pure helpers — not the live-DB path (batch INSERTs,
// queryBacklogDepth polling, scoped DELETE execution). The safety gate itself is
// covered by scripts/ci/__tests__/staging-guard.test.ts; here we assert the
// injector WIRES assertStagingTarget. Mirrors scripts/ci/__tests__/wedge-repro.test.ts.

const STAGING_URL = 'postgresql://postgres.kubdiqdhqbhwmqfditeg:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const STAGING_REF = 'kubdiqdhqbhwmqfditeg';
const PROD_URL = 'postgresql://postgres.udeyaqnvpojbwgoaxwdg:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('parseArgs — inject', () => {
  const base = ['node', 'burst-drill-load.ts', 'inject'];

  it('parses required flags and applies defaults (headroom arm)', () => {
    const cfg = parseArgs([...base, '--events', '1000', '--duration-min', '10', '--confirm-staging', STAGING_REF]) as InjectConfig;
    expect(cfg.command).toBe('inject');
    expect(cfg.events).toBe(1000);
    expect(cfg.durationMin).toBe(10);
    expect(cfg.confirmRef).toBe(STAGING_REF);
    expect(cfg.availableInMin).toBe(0);
    expect(cfg.batchSize).toBe(DEFAULT_BATCH_SIZE);
    expect(cfg.drillTag).toMatch(/^burst-/);
  });

  it('accepts --flag=value form and the over-threshold hold arm', () => {
    const cfg = parseArgs([
      ...base,
      '--events=1600',
      '--duration-min=10',
      `--confirm-staging=${STAGING_REF}`,
      '--available-in-min=180',
      '--batch-size=100',
      '--drill-tag=burst-fixed',
    ]) as InjectConfig;
    expect(cfg.events).toBe(1600);
    expect(cfg.availableInMin).toBe(180);
    expect(cfg.batchSize).toBe(100);
    expect(cfg.drillTag).toBe('burst-fixed');
  });

  it('requires --events', () => {
    expect(() => parseArgs([...base, '--duration-min', '10', '--confirm-staging', STAGING_REF])).toThrow(/--events is required/);
  });

  it('requires --duration-min', () => {
    expect(() => parseArgs([...base, '--events', '1000', '--confirm-staging', STAGING_REF])).toThrow(/--duration-min is required/);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects a non-positive-integer --events (%s)', (bad) => {
    expect(() => parseArgs([...base, '--events', bad, '--duration-min', '10', '--confirm-staging', STAGING_REF])).toThrow(
      /--events must be an integer/,
    );
  });

  it('allows --available-in-min of 0 but rejects negatives', () => {
    const ok = parseArgs([...base, '--events', '10', '--duration-min', '1', '--confirm-staging', STAGING_REF, '--available-in-min', '0']) as InjectConfig;
    expect(ok.availableInMin).toBe(0);
    expect(() =>
      parseArgs([...base, '--events', '10', '--duration-min', '1', '--confirm-staging', STAGING_REF, '--available-in-min', '-1']),
    ).toThrow(/--available-in-min must be an integer/);
  });

  it('clamps an oversized --batch-size down to MAX_BATCH_SIZE', () => {
    const cfg = parseArgs([...base, '--events', '10', '--duration-min', '1', '--confirm-staging', STAGING_REF, '--batch-size', '999999']) as InjectConfig;
    expect(cfg.batchSize).toBe(MAX_BATCH_SIZE);
  });
});

describe('parseArgs — release', () => {
  const base = ['node', 'burst-drill-load.ts', 'release'];

  it('parses the required flags and defaults the horizon', () => {
    const cfg = parseArgs([...base, '--drill-tag', 'burst-xyz', '--confirm-staging', STAGING_REF]) as ReleaseConfig;
    expect(cfg.command).toBe('release');
    expect(cfg.drillTag).toBe('burst-xyz');
    expect(cfg.confirmRef).toBe(STAGING_REF);
    expect(cfg.horizonHours).toBe(DEFAULT_HORIZON_HOURS);
  });

  it('requires --drill-tag (never auto-generated for release — you must name the run to clean it)', () => {
    expect(() => parseArgs([...base, '--confirm-staging', STAGING_REF])).toThrow(/--drill-tag is required/);
  });

  it('accepts a custom --horizon-hours but rejects a non-positive one', () => {
    const cfg = parseArgs([...base, '--drill-tag', 'burst-xyz', '--confirm-staging', STAGING_REF, '--horizon-hours', '48']) as ReleaseConfig;
    expect(cfg.horizonHours).toBe(48);
    expect(() => parseArgs([...base, '--drill-tag', 'burst-xyz', '--confirm-staging', STAGING_REF, '--horizon-hours', '0'])).toThrow(
      /--horizon-hours must be an integer/,
    );
  });
});

describe('parseArgs — command', () => {
  it('rejects an unknown/missing subcommand', () => {
    expect(() => parseArgs(['node', 'burst-drill-load.ts'])).toThrow(/inject\|release/);
    expect(() => parseArgs(['node', 'burst-drill-load.ts', 'wipe'])).toThrow(/inject\|release/);
  });
});

describe('computeInjectionSchedule', () => {
  const total = (schedule: ReturnType<typeof computeInjectionSchedule>) =>
    schedule.reduce((sum, batch) => sum + batch.batchCount, 0);

  it('spreads 1000 over 10 min at batch size 50 into 20 even batches', () => {
    const schedule = computeInjectionSchedule(1000, 10, 50);
    expect(schedule).toHaveLength(20);
    expect(schedule.every((b) => b.batchCount === 50)).toBe(true);
    expect(total(schedule)).toBe(1000);
    // inter-batch delay ≈ 10min / 20 = 30s; the last batch has no trailing wait.
    expect(schedule[0]!.delayMsAfter).toBe(30_000);
    expect(schedule.at(-1)!.delayMsAfter).toBe(0);
  });

  it('spreads 1600 over 10 min at batch size 50 into 32 even batches', () => {
    const schedule = computeInjectionSchedule(1600, 10, 50);
    expect(schedule).toHaveLength(32);
    expect(total(schedule)).toBe(1600);
    expect(schedule.every((b) => b.batchCount === 50)).toBe(true);
  });

  it('distributes a remainder across the leading batches (sum is exact)', () => {
    const schedule = computeInjectionSchedule(1030, 10, 50);
    expect(schedule).toHaveLength(21); // ceil(1030 / 50)
    expect(total(schedule)).toBe(1030);
    expect(schedule[0]!.batchCount).toBe(50); // 1 leading batch absorbs the remainder
    expect(schedule[1]!.batchCount).toBe(49);
    expect(schedule.at(-1)!.batchCount).toBe(49);
  });

  it('collapses to a single batch when N <= batch size', () => {
    const schedule = computeInjectionSchedule(10, 5, 50);
    expect(schedule).toHaveLength(1);
    expect(schedule[0]).toEqual({ batchCount: 10, delayMsAfter: 0 });
  });

  it('clamps an oversized batch size so it never exceeds MAX_BATCH_SIZE', () => {
    const schedule = computeInjectionSchedule(1000, 10, 10_000);
    expect(schedule).toHaveLength(Math.ceil(1000 / MAX_BATCH_SIZE));
    expect(schedule.every((b) => b.batchCount <= MAX_BATCH_SIZE)).toBe(true);
    expect(total(schedule)).toBe(1000);
  });

  it.each([
    [0, 10, 50],
    [1000, 0, 50],
    [1000, 10, 0],
  ])('rejects non-positive inputs (events=%s, durationMin=%s, batchSize=%s)', (events, durationMin, batchSize) => {
    expect(() => computeInjectionSchedule(events, durationMin, batchSize)).toThrow();
  });
});

describe('buildDrillRow (row-shape builder — non-prod-safe values)', () => {
  it('builds a mirror-sync-topic row tagged for scoped cleanup', () => {
    const row = buildDrillRow('burst-abc');
    expect(DRILL_TOPIC).toBe('stripe_subscription_mirror_sync');
    expect(DRILL_AGGREGATE_TYPE).toBe('account');
    expect(row.payload[DRILL_MARKER_KEY]).toBe('burst-abc');
    // account_id === aggregate_id: a fresh RANDOM uuid that maps to no real account,
    // so the handler self-completes with no LLM/external spend.
    expect(row.payload.account_id).toBe(row.aggregateId);
    expect(row.id).toMatch(UUID_RE);
    expect(row.aggregateId).toMatch(UUID_RE);
  });

  it('mints fresh ids on every call (no collisions across a bulk inject)', () => {
    const a = buildDrillRow('burst-abc');
    const b = buildDrillRow('burst-abc');
    expect(a.id).not.toBe(b.id);
    expect(a.aggregateId).not.toBe(b.aggregateId);
  });

  it('refuses to build an untagged row', () => {
    expect(() => buildDrillRow('   ')).toThrow();
  });
});

describe('buildScopedDeletePredicate (SAFETY-CRITICAL scoped-delete builder)', () => {
  it('always carries all four clauses (topic + drill tag + status=pending + horizon)', () => {
    const predicate = buildScopedDeletePredicate({ drillTag: 'burst-abc' });
    expect(predicate.topic).toBe(DRILL_TOPIC);
    expect(predicate.drillTag).toBe('burst-abc');
    expect(predicate.status).toBe('pending');
    expect(predicate.horizonHours).toBe(DEFAULT_HORIZON_HOURS);

    const clauses = scopedDeleteWhereClauses(predicate);
    expect(clauses).toHaveLength(4);
    expect(clauses.some((c) => /topic\s*=/.test(c))).toBe(true);
    expect(clauses.some((c) => c.includes(DRILL_MARKER_KEY))).toBe(true);
    expect(clauses.some((c) => /status\s*=\s*'pending'/.test(c))).toBe(true);
    expect(clauses.some((c) => /created_at\s*>=/.test(c))).toBe(true);
  });

  it('is IMPOSSIBLE to build a tag-less predicate (no unscoped DELETE)', () => {
    expect(() => buildScopedDeletePredicate({ drillTag: '' })).toThrow(/drill tag/i);
    expect(() => buildScopedDeletePredicate({ drillTag: '   ' })).toThrow(/drill tag/i);
  });

  it('is structurally IMPOSSIBLE to omit the status clause (status is a fixed constant, never an input)', () => {
    // status is not a builder input — it is pinned to 'pending' and surfaced in the
    // clause list unconditionally, so no caller can produce a status-less DELETE.
    const predicate = buildScopedDeletePredicate({ drillTag: 'burst-abc', horizonHours: 12 });
    expect(predicate.status).toBe('pending');
    expect(scopedDeleteWhereClauses(predicate).some((c) => c.includes("status = 'pending'"))).toBe(true);
  });

  it('rejects a non-positive horizon (defense-in-depth against tag reuse)', () => {
    expect(() => buildScopedDeletePredicate({ drillTag: 'burst-abc', horizonHours: 0 })).toThrow(/horizon/i);
    expect(() => buildScopedDeletePredicate({ drillTag: 'burst-abc', horizonHours: -5 })).toThrow(/horizon/i);
    expect(() => buildScopedDeletePredicate({ drillTag: 'burst-abc', horizonHours: 1.5 })).toThrow(/horizon/i);
  });
});

describe('assertLoadTarget (wires assertStagingTarget)', () => {
  it('accepts the staging pooler URL confirmed with the staging ref', () => {
    expect(() => assertLoadTarget(STAGING_URL, STAGING_REF)).not.toThrow();
  });

  it('rejects a missing --confirm-staging', () => {
    expect(() => assertLoadTarget(STAGING_URL, '')).toThrow(/REFUSING TO RUN/);
  });

  it('rejects a wrong --confirm-staging that does not match the target', () => {
    expect(() => assertLoadTarget(STAGING_URL, 'someotherref00001')).toThrow(/REFUSING TO RUN/);
  });

  it('rejects a production target via the denylist (denylist beats the flag)', () => {
    expect(() => assertLoadTarget(PROD_URL, 'udeyaqnvpojbwgoaxwdg')).toThrow(/PRODUCTION project ref/);
  });
});

describe('generateDrillTag', () => {
  it('produces a burst-prefixed, filesystem/CLI-safe tag', () => {
    const tag = generateDrillTag();
    expect(tag).toMatch(/^burst-/);
    expect(tag).not.toMatch(/[:.]/); // colons/dots stripped so it is safe on a CLI
  });
});

describe('buildReleaseHint (release-hint gating by arm type)', () => {
  const base = { drillTag: 'burst-abc', confirmRef: 'kubdiqdhqbhwmqfditeg' };

  it('over-threshold arm (availableInMin > 0) needs a release and prints the command', () => {
    const hint = buildReleaseHint({ ...base, availableInMin: 15 });
    expect(hint.needsRelease).toBe(true);
    if (hint.needsRelease) {
      expect(hint.command).toContain('release --drill-tag burst-abc');
      expect(hint.command).toContain('--confirm-staging kubdiqdhqbhwmqfditeg');
    }
  });

  it('headroom arm (availableInMin === 0) does NOT need a release — rows self-drain', () => {
    const hint = buildReleaseHint({ ...base, availableInMin: 0 });
    expect(hint.needsRelease).toBe(false);
    expect(hint.message).toMatch(/self-drain/);
    expect(hint).not.toHaveProperty('command');
  });
});

describe('listRemainingDrillRows (post-run inventory scoped to pending)', () => {
  // Fakes the postgres.js tagged-template Sql call — no live DB. Filters an
  // in-memory fixture table the same way the real SQL WHERE clause does, so this
  // proves the query is scoped to status='pending' (a completed row from the
  // headroom arm's expected happy path must not be counted, per Fix 2).
  interface FixtureRow {
    id: string;
    status: string;
    created_at: string;
    topic: string;
    drillTag: string;
  }

  function fakeSql(fixtures: FixtureRow[]): Parameters<typeof listRemainingDrillRows>[0] {
    return (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const [topic, , drillTag, status] = values as [string, string, string, string];
      return fixtures
        .filter((row) => row.topic === topic && row.drillTag === drillTag && row.status === status)
        .map(({ id, status: rowStatus, created_at }) => ({ id, status: rowStatus, created_at }));
    }) as unknown as Parameters<typeof listRemainingDrillRows>[0];
  }

  it('does not count a self-completed row as remaining (headroom arm happy path)', async () => {
    const fixtures: FixtureRow[] = [
      { id: 'row-1', status: 'completed', created_at: '2026-07-19T00:00:00Z', topic: DRILL_TOPIC, drillTag: 'burst-abc' },
    ];
    const remaining = await listRemainingDrillRows(fakeSql(fixtures), 'burst-abc');
    expect(remaining).toHaveLength(0);
  });

  it('still counts a genuinely-stuck pending row as remaining (real HARD-FAIL)', async () => {
    const fixtures: FixtureRow[] = [
      { id: 'row-2', status: 'pending', created_at: '2026-07-19T00:00:00Z', topic: DRILL_TOPIC, drillTag: 'burst-abc' },
    ];
    const remaining = await listRemainingDrillRows(fakeSql(fixtures), 'burst-abc');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.status).toBe('pending');
  });

  it('does not cross-contaminate across tags or topics', async () => {
    const fixtures: FixtureRow[] = [
      { id: 'row-3', status: 'pending', created_at: '2026-07-19T00:00:00Z', topic: DRILL_TOPIC, drillTag: 'burst-other' },
      { id: 'row-4', status: 'pending', created_at: '2026-07-19T00:00:00Z', topic: 'some_other_topic', drillTag: 'burst-abc' },
    ];
    const remaining = await listRemainingDrillRows(fakeSql(fixtures), 'burst-abc');
    expect(remaining).toHaveLength(0);
  });
});
