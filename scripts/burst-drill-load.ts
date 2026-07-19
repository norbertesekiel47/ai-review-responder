// Capacity-burst drill synthetic-load injector (ticket #505, task T3) — the
// checked-in tool that drives #480's outbox DISPATCH-drain drill against SHARED
// staging. It proves outbox dispatch-drain of a burst of pending job_outbox rows
// + backlog_depth observability — NOT full ingest->draft->notification pipeline
// throughput (deliberately: cheap drainable rows, no LLM/external spend).
//
// Two subcommands:
//
//   inject  — pace N synthetic pending rows across M minutes:
//     pnpm tsx scripts/burst-drill-load.ts inject \
//       --events N --duration-min M --confirm-staging <staging-ref> \
//       [--available-in-min K] [--batch-size B] [--drill-tag TAG]
//
//     --available-in-min 0 (default, HEADROOM arm): immediately-claimable rows —
//       drain (~600/min) outpaces the inject, backlog stays low, no alert.
//     --available-in-min K>0 (OVER-THRESHOLD arm): FUTURE-DATED rows that count as
//       pending (backlog_depth has no available_at<=NOW() filter) but the poller
//       never claims, so backlog HOLDS >1500 across a HealthAlertPoller tick and
//       `backlog_depth:job_outbox` fires. `release` then clears it.
//
//   release — DELETE this run's drill rows and hard-fail on any residual:
//     pnpm tsx scripts/burst-drill-load.ts release \
//       --drill-tag TAG --confirm-staging <staging-ref> [--horizon-hours H]
//
// Every injected row is topic `stripe_subscription_mirror_sync`, aggregate_type
// 'account', a fresh uuidv7() id, and a RANDOM non-existent account_id — the
// mirror-sync handler self-completes (no real account) with no spend and never
// `failed`, so the drill trips none of the failed/stale health checks (D1). Each
// row carries a per-run `__drill:<tag>` marker in its payload, which is the ONLY
// thing `release` deletes on. Insert precedent: enqueueStripeSubscriptionMirrorSync
// at src/lib/shared/job-outbox-helpers.ts:558-571 (uuidv7 id, tx.json payload).
import { randomUUID } from 'node:crypto';

import { v7 as uuidv7 } from 'uuid';

import { createDedicatedPostgresClient } from '../src/lib/db/server';
import { QUEUE_NAMES } from '../src/lib/shared/queue-names';
import { queryBacklogDepth } from '../src/lib/shared/backlog-depth';
import { runDirectCli } from './run-direct-cli';
import { assertStagingTarget, describeConnectionTarget, extractProjectRefForLog } from './staging-guard';

type Sql = ReturnType<typeof createDedicatedPostgresClient>;

// ── constants (single owner within this script) ───────────────────────────────

/** Drill rows all use the mirror-sync topic — a DB-only handler that self-completes
 * for a missing account with no LLM/external spend and never `failed` (D1). */
export const DRILL_TOPIC = QUEUE_NAMES.STRIPE_SUBSCRIPTION_MIRROR_SYNC;
export const DRILL_AGGREGATE_TYPE = 'account';
/** The payload key that scopes every cleanup. The SQL predicates reference the
 * literal `__drill`, so this constant and those literals MUST stay in lockstep. */
export const DRILL_MARKER_KEY = '__drill';
/** job_outbox status literal (not exported from job-outbox-helpers) — one owner here. */
const OUTBOX_STATUS_PENDING = 'pending' as const;

export const DEFAULT_BATCH_SIZE = 50; // mirrors OUTBOX_BATCH_SIZE — a sane default burst granularity
export const MAX_BATCH_SIZE = 500; // clamp so one round-trip never inserts an unbounded batch
export const DEFAULT_HORIZON_HOURS = 24; // release only deletes rows created within this window (defense-in-depth vs tag reuse)

// ── CLI args ──────────────────────────────────────────────────────────────────

export interface InjectConfig {
  command: 'inject';
  events: number;
  durationMin: number;
  confirmRef: string;
  /** 0 = headroom arm (immediately claimable); K>0 = over-threshold hold arm. */
  availableInMin: number;
  batchSize: number;
  drillTag: string;
}

export interface ReleaseConfig {
  command: 'release';
  confirmRef: string;
  drillTag: string;
  horizonHours: number;
}

export type BurstDrillConfig = InjectConfig | ReleaseConfig;

const USAGE =
  'usage: burst-drill-load.ts <inject|release> --confirm-staging <ref>\n' +
  '  inject  --events N --duration-min M [--available-in-min K] [--batch-size B] [--drill-tag TAG]\n' +
  '  release --drill-tag TAG [--horizon-hours H]';

function collectFlags(argv: string[], start: number): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = start; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
    } else {
      flags.set(token.slice(2), argv[++i] ?? '');
    }
  }
  return flags;
}

/** Parse an integer flag with an optional default and a minimum bound. A missing
 * flag with no default is a hard error (required); a fractional / below-min /
 * non-numeric value is rejected so a typo can never silently shrink the burst. */
function intFlag(flags: Map<string, string>, key: string, opts: { default?: number; min?: number }): number {
  const min = opts.min ?? 1;
  const raw = flags.get(key);
  if (raw === undefined || raw.trim() === '') {
    if (opts.default !== undefined) return opts.default;
    throw new Error(`--${key} is required`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    throw new Error(`--${key} must be an integer >= ${min}`);
  }
  return parsed;
}

/** A unique-per-run cleanup tag. Colons/dots are stripped so the tag is safe as a
 * CLI token and as a JSON string value. The Date use is fine here (this is a tsx
 * script, not a Workflow script). */
export function generateDrillTag(): string {
  return `burst-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

// One branch per flag / subcommand — inherently branchy CLI parsing.
// fallow-ignore-next-line complexity
export function parseArgs(argv: string[]): BurstDrillConfig {
  const command = argv[2];
  if (command !== 'inject' && command !== 'release') {
    throw new Error(USAGE);
  }
  const flags = collectFlags(argv, 3);
  const confirmRef = (flags.get('confirm-staging') ?? '').trim();

  if (command === 'inject') {
    const drillTag = (flags.get('drill-tag') ?? '').trim() || generateDrillTag();
    return {
      command,
      events: intFlag(flags, 'events', { min: 1 }),
      durationMin: intFlag(flags, 'duration-min', { min: 1 }),
      confirmRef,
      availableInMin: intFlag(flags, 'available-in-min', { default: 0, min: 0 }),
      batchSize: Math.min(intFlag(flags, 'batch-size', { default: DEFAULT_BATCH_SIZE, min: 1 }), MAX_BATCH_SIZE),
      drillTag,
    };
  }

  const drillTag = (flags.get('drill-tag') ?? '').trim();
  if (!drillTag) {
    throw new Error('--drill-tag is required for release (name the run you injected so cleanup is scoped)');
  }
  return {
    command,
    confirmRef,
    drillTag,
    horizonHours: intFlag(flags, 'horizon-hours', { default: DEFAULT_HORIZON_HOURS, min: 1 }),
  };
}

// ── safety gate wiring ────────────────────────────────────────────────────────

/** Wires the shared positive-allowlist staging gate onto the inject/release
 * connection target. Equality mode (D2#7): this runs on SHARED staging, so the
 * confirmed ref must EQUAL the known staging ref. Called BEFORE any write. */
export function assertLoadTarget(poolUrl: string, confirmRef: string): void {
  assertStagingTarget(describeConnectionTarget(poolUrl), confirmRef);
}

// ── injection schedule (pure) ─────────────────────────────────────────────────

export interface InjectionBatch {
  batchCount: number;
  /** How long to wait AFTER this batch before the next (0 on the final batch). */
  delayMsAfter: number;
}

/**
 * Spread `events` rows across `durationMin` minutes as evenly-sized batches of at
 * most `batchSize` (clamped to MAX_BATCH_SIZE). The remainder is absorbed by the
 * leading batches so the counts sum EXACTLY to `events`. Inter-batch delay is the
 * duration split evenly across the batches; the final batch has no trailing wait.
 * Sub-minute precision is intentionally not the point.
 */
export function computeInjectionSchedule(events: number, durationMin: number, batchSize: number): InjectionBatch[] {
  if (!Number.isInteger(events) || events <= 0) throw new Error('events must be a positive integer');
  if (!Number.isFinite(durationMin) || durationMin <= 0) throw new Error('durationMin must be positive');
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('batchSize must be a positive integer');

  const effectiveBatch = Math.min(batchSize, MAX_BATCH_SIZE);
  const numBatches = Math.ceil(events / effectiveBatch);
  const base = Math.floor(events / numBatches);
  const remainder = events % numBatches;
  const interDelayMs = Math.floor((durationMin * 60_000) / numBatches);

  const schedule: InjectionBatch[] = [];
  for (let i = 0; i < numBatches; i++) {
    const isLast = i === numBatches - 1;
    schedule.push({
      batchCount: base + (i < remainder ? 1 : 0),
      delayMsAfter: isLast ? 0 : interDelayMs,
    });
  }
  return schedule;
}

// ── row-shape builder (pure) ──────────────────────────────────────────────────

export interface DrillPayload {
  account_id: string;
  __drill: string;
}

export interface DrillRow {
  id: string;
  /** A RANDOM, non-existent account uuid — equals payload.account_id. */
  aggregateId: string;
  payload: DrillPayload;
}

/** Build one synthetic drill row. `aggregate_id` and `payload.account_id` are the
 * SAME random uuid that maps to no real account, so the mirror-sync handler
 * self-completes with no spend. `__drill:<tag>` is the cleanup scope. */
export function buildDrillRow(drillTag: string): DrillRow {
  const tag = drillTag.trim();
  if (!tag) throw new Error('buildDrillRow requires a non-empty drill tag');
  const aggregateId = randomUUID();
  return {
    id: uuidv7(),
    aggregateId,
    payload: { account_id: aggregateId, [DRILL_MARKER_KEY]: tag },
  };
}

// ── scoped-delete predicate (SAFETY-CRITICAL) ─────────────────────────────────

/**
 * The ONLY shape a release DELETE can be built from. All four scoping clauses are
 * REQUIRED, readonly, non-optional fields: `topic` and `status` are pinned
 * constants (never caller inputs), and `drillTag` / `horizonHours` are validated
 * by the sole constructor. This makes it structurally impossible to reach the
 * DELETE with a missing clause.
 */
export interface ScopedDeletePredicate {
  readonly topic: string;
  readonly drillTag: string;
  readonly status: typeof OUTBOX_STATUS_PENDING;
  readonly horizonHours: number;
}

/** The single constructor for a release predicate. Rejects an empty tag (would
 * broaden the DELETE) and a non-positive horizon. */
export function buildScopedDeletePredicate(input: { drillTag: string; horizonHours?: number }): ScopedDeletePredicate {
  const drillTag = input.drillTag.trim();
  if (!drillTag) {
    throw new Error('scoped delete requires a non-empty drill tag — refusing to build an unscoped DELETE');
  }
  const horizonHours = input.horizonHours ?? DEFAULT_HORIZON_HOURS;
  if (!Number.isInteger(horizonHours) || horizonHours < 1) {
    throw new Error('scoped delete requires a positive-integer horizonHours');
  }
  return Object.freeze({
    topic: DRILL_TOPIC,
    drillTag,
    status: OUTBOX_STATUS_PENDING,
    horizonHours,
  });
}

/** Human-readable rendering of the four scoping clauses — used for the release log
 * line AND asserted by the tests. The live DELETE (deleteScopedDrillRows) is
 * parameterized from the SAME four predicate fields; keep them in lockstep. */
export function scopedDeleteWhereClauses(predicate: ScopedDeletePredicate): readonly string[] {
  return [
    `topic = '${predicate.topic}'`,
    `payload->>'${DRILL_MARKER_KEY}' = '${predicate.drillTag}'`,
    `status = '${predicate.status}'`,
    `created_at >= NOW() - make_interval(hours => ${predicate.horizonHours})`,
  ];
}

// ── live DB helpers (not unit-tested — driven by T5 on staging) ───────────────

async function insertDrillBatch(sql: Sql, drillTag: string, availableInMin: number, batchCount: number): Promise<void> {
  await sql.begin(async (tx) => {
    for (let i = 0; i < batchCount; i++) {
      const row = buildDrillRow(drillTag);
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, available_at)
        VALUES (
          ${row.id},
          ${DRILL_TOPIC},
          ${DRILL_AGGREGATE_TYPE},
          ${row.aggregateId}::uuid,
          ${tx.json(row.payload as never)},
          ${OUTBOX_STATUS_PENDING},
          NOW() + make_interval(mins => ${availableInMin}::int)
        )
      `;
    }
  });
}

/** Execute the scoped release DELETE — parameterized from all four predicate
 * fields. Returns the number of rows deleted. Idempotent (re-running matches
 * nothing new). */
async function deleteScopedDrillRows(sql: Sql, predicate: ScopedDeletePredicate): Promise<number> {
  const deleted = await sql`
    DELETE FROM job_outbox
    WHERE topic = ${predicate.topic}
      AND payload->>${DRILL_MARKER_KEY} = ${predicate.drillTag}
      AND status = ${predicate.status}
      AND created_at >= NOW() - make_interval(hours => ${predicate.horizonHours}::int)
    RETURNING id
  `;
  return deleted.count;
}

export interface RemainingRow {
  id: string;
  status: string;
  created_at: string;
}

/** Post-run inventory: PENDING rows still carrying this tag — the same status the
 * scoped-delete predicate targets. A non-zero count is a HARD-FAIL — the release
 * did not fully clean up. Rows that self-completed (the headroom arm's expected
 * happy outcome) are NOT counted here: they self-purge via ArchivalPoller and
 * must never trip a false HARD-FAIL. */
export async function listRemainingDrillRows(sql: Sql, drillTag: string): Promise<RemainingRow[]> {
  const rows = await sql<RemainingRow[]>`
    SELECT id, status, created_at
    FROM job_outbox
    WHERE topic = ${DRILL_TOPIC}
      AND payload->>${DRILL_MARKER_KEY} = ${drillTag}
      AND status = ${OUTBOX_STATUS_PENDING}
    ORDER BY created_at
    LIMIT 100
  `;
  return [...rows];
}

async function logBacklogProgress(sql: Sql, injected: number, total: number): Promise<void> {
  // Best-effort observability — a progress-poll failure must NEVER abort the
  // injection (production.md). Counts only, never row content.
  try {
    const depth = await queryBacklogDepth(sql);
    console.log(`[burst-drill] progress injected=${injected}/${total} backlog_depth.job_outbox(pending)=${depth.job_outbox}`);
  } catch (error) {
    console.warn(`[burst-drill] progress poll failed (continuing): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── post-inject release hint (pure) ───────────────────────────────────────────

export type ReleaseHint =
  | { needsRelease: true; message: string; command: string }
  | { needsRelease: false; message: string };

/**
 * The over-threshold arm's rows hold `pending` (future-dated, never claimed) and
 * need the scoped `release` DELETE. The headroom arm's rows self-complete as the
 * OutboxPoller claims them, so printing the release command there is misleading —
 * there is nothing pending left to release. Gated on `availableInMin` (0 = headroom).
 */
export function buildReleaseHint(config: Pick<InjectConfig, 'availableInMin' | 'drillTag' | 'confirmRef'>): ReleaseHint {
  if (config.availableInMin > 0) {
    return {
      needsRelease: true,
      message: 'CLEANUP — run this when the drill is done (never lose the tag):',
      command: `pnpm tsx scripts/burst-drill-load.ts release --drill-tag ${config.drillTag} --confirm-staging ${config.confirmRef}`,
    };
  }
  return {
    needsRelease: false,
    message:
      'headroom arm — rows self-drain to status=completed as the OutboxPoller claims them; no release needed.',
  };
}

// ── subcommand runners ────────────────────────────────────────────────────────

// Staging operational harness, live-DB CLI (like scripts/wedge-repro.ts) — 0%
// runtime coverage BY DESIGN, not risk; the pure helpers it calls (computeInjectionSchedule,
// buildReleaseHint, insertDrillBatch's row builder) ARE unit-tested.
// fallow-ignore-next-line complexity
async function runInject(config: InjectConfig, sql: Sql): Promise<number> {
  const schedule = computeInjectionSchedule(config.events, config.durationMin, config.batchSize);
  const arm = config.availableInMin > 0 ? `over-threshold(hold +${config.availableInMin}min)` : 'headroom(drain)';
  console.log(
    `[burst-drill] inject tag=${config.drillTag} events=${config.events} over ${config.durationMin}min ` +
      `batches=${schedule.length} arm=${arm}`,
  );

  let injected = 0;
  for (const batch of schedule) {
    await insertDrillBatch(sql, config.drillTag, config.availableInMin, batch.batchCount);
    injected += batch.batchCount;
    await logBacklogProgress(sql, injected, config.events);
    if (batch.delayMsAfter > 0) await sleep(batch.delayMsAfter);
  }

  console.log(`[burst-drill] injected ${injected} row(s) tagged '${config.drillTag}'.`);
  const hint = buildReleaseHint(config);
  console.log(`[burst-drill] ${hint.message}`);
  if (hint.needsRelease) console.log(`  ${hint.command}`);
  return 0;
}

async function runRelease(config: ReleaseConfig, sql: Sql): Promise<number> {
  const predicate = buildScopedDeletePredicate({ drillTag: config.drillTag, horizonHours: config.horizonHours });
  console.log(`[burst-drill] release tag=${config.drillTag} scoped DELETE WHERE ${scopedDeleteWhereClauses(predicate).join(' AND ')}`);

  const deleted = await deleteScopedDrillRows(sql, predicate);
  console.log(`[burst-drill] deleted ${deleted} pending drill row(s).`);

  // Post-run inventory — PENDING rows only (a completed row is the expected
  // happy outcome for the headroom arm, not a leak). A non-zero PENDING count
  // is a HARD-FAIL, not a warning (D3-E).
  const remaining = await listRemainingDrillRows(sql, config.drillTag);
  if (remaining.length > 0) {
    console.error(
      `[burst-drill] HARD-FAIL: ${remaining.length} PENDING row(s) tagged '${config.drillTag}' remain after release ` +
        `(likely created before the ${config.horizonHours}h horizon). Investigate before re-running:`,
    );
    for (const row of remaining) {
      console.error(`  remaining id=${row.id} status=${row.status} created_at=${row.created_at}`);
    }
    return 1;
  }

  console.log(`[burst-drill] inventory clean — 0 PENDING row(s) tagged '${config.drillTag}' remain.`);
  return 0;
}

// ── entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const config = parseArgs(process.argv);

  const poolUrl = process.env.DATABASE_POOL_URL;
  if (!poolUrl) throw new Error('DATABASE_POOL_URL is required (the staging pooler URL to inject/release against)');

  // SAFETY GUARD — must pass BEFORE any write.
  assertLoadTarget(poolUrl, config.confirmRef);

  console.log(
    `[burst-drill] target ref=${extractProjectRefForLog(poolUrl)} confirmed=${config.confirmRef} command=${config.command}`,
  );

  // createDedicatedPostgresClient defaults statement_timeout to 30_000 (PgBouncer
  // default ~8s would break the transactional batch inserts).
  const sql = createDedicatedPostgresClient(poolUrl, {});

  const onSignal = (): void => {
    console.error('\n[burst-drill] signal received — closing the client and exiting');
    void sql.end({ timeout: 5 }).finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    return config.command === 'inject' ? await runInject(config, sql) : await runRelease(config, sql);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await sql.end({ timeout: 5 });
  }
}

runDirectCli({
  importMetaUrl: import.meta.url,
  main,
  onError: (error) => {
    console.error('[burst-drill] fatal', error);
    return 1;
  },
});
