// src/lib/reviews/__tests__/on-demand-generate.test.ts
//
// T1 EVAL suite for #729 — the Generate transaction as a named domain module.
//
// Exercises the locked interface `onDemandGenerateTx(tx, { reviewId,
// businessId })` (plan: docs/superpowers/plans/feat-729-generate-domain-module.md,
// "Module interface (locked)") through its discriminated union directly — no
// HTTP, no NextResponse. The route-level behaviour stays characterized by the
// named precedent for this suite's mocking shape,
// src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts
// (vi.hoisted captured-template tx mock, `tx.json` pass-through so the
// enqueueGenerateResponse payload lands in captured params, module-path
// vi.mock of @/lib/shared/writable-subscription). This suite extends that tx
// mock to capture the joined SQL TEXT of every tx call as well as its values —
// titles 1 and 9 assert against the text.
//
// RED until T2 creates `../on-demand-generate.ts`: every title imports the
// module dynamically (house pattern from the precedent's header), so each one
// fails on its own rather than the file failing to collect.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { POST_AFTER_DELETE_FAILED_PREFIX } from '@/lib/publishing/orphan-markers';

// ── Hoisted shared state ─────────────────────────────────────────────────────

const { mockAssertWritableTx, txQueue, txCalls, txTag } = vi.hoisted(() => {
  const mockAssertWritableTx = vi.fn();

  const txQueue: unknown[][] = [];
  const txCalls: { text: string; values: unknown[] }[] = [];

  const txTag = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
      const text = strings.join('?');
      // statusArraySql(tx, …) composes a `${array}::text[]` FRAGMENT on the
      // same tx instance. A fragment is embedded in its parent query, never
      // executed on its own — it must not consume a rowset or count as a call.
      if (text === '?::text[]') {
        return { fragment: text, values };
      }
      txCalls.push({ text, values });
      return Promise.resolve(txQueue.shift() ?? []);
    },
    {
      // Postgres.js identity JSONB constructor — enqueueGenerateResponse binds
      // its payload through `tx.json(...)`, so mirror it as a pass-through and
      // the payload object lands in the captured template values.
      json: (v: unknown) => v,
    },
  );

  return { mockAssertWritableTx, txQueue, txCalls, txTag };
});

// The in-tx TOCTOU re-assert, mocked by module path so it issues no query of
// its own — the txQueue seeding stays a straight list of the module's guards.
vi.mock('@/lib/shared/writable-subscription', async () => {
  const actual = await vi.importActual<typeof import('@/lib/shared/writable-subscription')>(
    '@/lib/shared/writable-subscription',
  );
  return {
    ...actual,
    assertWritableSubscriptionForBusiness: (...args: unknown[]) => mockAssertWritableTx(...args),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
const BUSINESS_ID = '01234567-0000-7000-8000-000000000001';
const UUID_RE = /^[0-9a-f-]{36}$/;

type OnDemandGenerateFn = (
  tx: unknown,
  args: { reviewId: string; businessId: string },
) => Promise<Record<string, unknown>>;

async function runGenerate(): Promise<Record<string, unknown>> {
  // Plain-literal dynamic import, mirroring the precedent's shape ("RED until
  // Task 3 creates ../route.ts") — the module lands in the same PR (T2), so
  // typecheck goes green then; until then vitest fails each title at runtime.
  const mod = (await import('../on-demand-generate')) as unknown as {
    onDemandGenerateTx: OnDemandGenerateFn;
  };
  return mod.onDemandGenerateTx(txTag, { reviewId: REVIEW_ID, businessId: BUSINESS_ID });
}

function seedTxRows(...rowsets: unknown[][]): void {
  txQueue.push(...rowsets);
}

/**
 * lock → posted → non-terminal draft → orphan → in-flight outbox →
 * MAX(version) → enqueue INSERT. The in-tx writable/offboarding re-assert sits
 * between the lock and the posted check but is mocked, so it consumes no
 * rowset.
 */
function seedHappyPath(nextVersion = 1): void {
  seedTxRows([{ id: REVIEW_ID }], [], [], [], [], [{ next_version: nextVersion }], []);
}

function txCallTexts(): string[] {
  return txCalls.map((call) => call.text.replace(/\s+/g, ' '));
}

function outboxInsertCalls(): { text: string; values: unknown[] }[] {
  return txCalls.filter((call) => call.text.includes('INSERT INTO job_outbox'));
}

interface OutboxPayload {
  review_id: string;
  business_id: string;
  version: number;
  origin_lane: string;
  suppress_notification?: boolean;
}

function isOutboxPayload(value: unknown): value is OutboxPayload {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && 'origin_lane' in value
  );
}

function lastOutboxPayload(): OutboxPayload {
  const call = outboxInsertCalls().at(-1);
  expect(call).toBeDefined();
  const payload = call!.values.find(isOutboxPayload);
  expect(payload).toBeDefined();
  return payload!;
}

beforeEach(() => {
  vi.clearAllMocks();
  txQueue.length = 0;
  txCalls.length = 0;
  mockAssertWritableTx.mockResolvedValue({ ok: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('onDemandGenerateTx', () => {
  it('locks the review row before any sibling read and returns review_not_found when the lock finds no row', async () => {
    seedTxRows([]); // the FOR UPDATE lock finds nothing

    const result = await runGenerate();

    expect(result).toEqual({ ok: false, reason: 'review_not_found' });

    // The lock is the FIRST statement of the transaction — anything before it
    // reads state a concurrent click can still change.
    expect(txCalls).toHaveLength(1);
    const first = txCallTexts()[0]!;
    expect(first).toMatch(/SELECT id FROM reviews/i);
    expect(first).toMatch(/FOR UPDATE/);

    // No sibling read and not even the writable re-assert ran.
    expect(txCallTexts().some((text) => text.includes('FROM responses'))).toBe(false);
    expect(mockAssertWritableTx).not.toHaveBeenCalled();
  });

  it('re-asserts the business-scoped writable gate inside the locked transaction and passes its refusal through unchanged', async () => {
    seedTxRows([{ id: REVIEW_ID }]); // lock succeeds
    mockAssertWritableTx.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'account_offboarding_blocked',
    });

    const result = await runGenerate();

    // The refusal's status + error flow through UNCHANGED under the
    // `not_writable` discriminant.
    expect(result).toEqual({
      ok: false,
      reason: 'not_writable',
      status: 403,
      error: 'account_offboarding_blocked',
    });

    // Business-scoped (the locked review already resolved its location) and
    // handed the SAME tx instance the module received — inside the lock.
    expect(mockAssertWritableTx).toHaveBeenCalledTimes(1);
    expect(mockAssertWritableTx).toHaveBeenCalledWith(BUSINESS_ID, txTag);
    expect(txCallTexts()[0]).toMatch(/FOR UPDATE/);

    // The refusal short-circuits: no sibling read, no enqueue.
    expect(txCalls).toHaveLength(1);
    expect(outboxInsertCalls()).toHaveLength(0);
  });

  it('returns already_answered when a posted sibling exists', async () => {
    // lock → posted sibling found
    seedTxRows([{ id: REVIEW_ID }], [{ id: 'resp-posted' }]);

    const result = await runGenerate();

    // A posted sibling means the owner wants Regenerate (§6.4 replaces a LIVE
    // Google reply), not Generate.
    expect(result).toEqual({ ok: false, reason: 'already_answered' });
    expect(txCallTexts().some((text) => text.includes("status = 'posted'"))).toBe(true);
    expect(outboxInsertCalls()).toHaveLength(0);
  });

  it('returns draft_already_exists with the newest non-terminal sibling id and status', async () => {
    // lock → posted (none) → non-terminal draft found
    seedTxRows([{ id: REVIEW_ID }], [], [{ id: 'resp-draft', status: 'pending_approval' }]);

    const result = await runGenerate();

    expect(result).toEqual({
      ok: false,
      reason: 'draft_already_exists',
      existing: { response_id: 'resp-draft', status: 'pending_approval' },
    });
    // "Newest" is load-bearing: the read must order by version DESC so the
    // surfaced draft is the latest one, not an arbitrary sibling.
    expect(txCallTexts().some((text) => /ORDER BY version DESC/i.test(text))).toBe(true);
    expect(outboxInsertCalls()).toHaveLength(0);
  });

  it('returns orphan_recovery_pending when a failed sibling carries the post_after_delete_failed_ prefix', async () => {
    // lock → posted (none) → non-terminal (none) → orphan sibling found
    seedTxRows([{ id: REVIEW_ID }], [], [], [{ id: 'fail-orphan' }]);

    const result = await runGenerate();

    expect(result).toEqual({ ok: false, reason: 'orphan_recovery_pending' });
    expect(outboxInsertCalls()).toHaveLength(0);

    // The marker prefix comes from orphan-markers.ts, never a re-typed literal.
    const orphanCall = txCalls.find((call) => call.text.includes('posting_error LIKE'));
    expect(orphanCall).toBeDefined();
    expect(orphanCall!.values).toContain(`${POST_AFTER_DELETE_FAILED_PREFIX}%`);
  });

  it('returns regenerate_in_progress when an in-flight generate_response outbox row exists', async () => {
    // lock → posted → non-terminal → orphan (all none) → in-flight outbox found
    seedTxRows([{ id: REVIEW_ID }], [], [], [], [{ exists: 1 }]);

    const result = await runGenerate();

    expect(result).toEqual({ ok: false, reason: 'regenerate_in_progress' });
    expect(outboxInsertCalls()).toHaveLength(0);

    const inFlightCall = txCalls.find((call) => call.text.includes('FROM job_outbox'));
    expect(inFlightCall).toBeDefined();
    // Byte-for-byte in-flight contract (job-outbox-status.ts) — members AND
    // order; `ci:outbox-status` guards every re-spelling of it.
    expect(inFlightCall!.text.replace(/\s+/g, ' ')).toContain(
      "'pending', 'dispatching', 'dispatched'",
    );
    expect(inFlightCall!.values).toContain(QUEUE_NAMES.GENERATE_RESPONSE);
    expect(inFlightCall!.values).toContain(REVIEW_ID);
  });

  it('allocates version as COALESCE(MAX(version),0)+1 and never hardcodes 1', async () => {
    // D-B: hardcoding `1` would make every Generate free forever — a discarded
    // draft is RETAINED at status='superseded', so MAX(version) is preserved
    // and the per-review regen budget self-arms on the next attempt.
    seedHappyPath(42);

    const result = await runGenerate();

    expect(result.ok).toBe(true);
    expect(result.version).toBe(42);
    expect(result.version).not.toBe(1);
    expect(lastOutboxPayload().version).toBe(42);
    expect(
      txCallTexts().some((text) => text.includes('COALESCE(MAX(version), 0) + 1')),
    ).toBe(true);
  });

  it('enqueues via enqueueGenerateResponse with originLane ON_DEMAND_GENERATE and suppressNotification true in the same transaction', async () => {
    seedHappyPath(3);

    const result = await runGenerate();

    expect(result.ok).toBe(true);
    expect(result.version).toBe(3);

    // The Origin lane value must EXIST — asserting only
    // `payload.origin_lane === GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE`
    // would pass vacuously (undefined === undefined) if the constant vanished.
    expect(GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE).toBe('on_demand_generate');

    // The REAL enqueueGenerateResponse ran against this tx (the helper is
    // deliberately unmocked), so the captured INSERT carries its actual
    // payload key spelling: origin_lane + suppress_notification.
    const inserts = outboxInsertCalls();
    expect(inserts).toHaveLength(1);
    const payload = lastOutboxPayload();
    expect(payload.origin_lane).toBe(GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE);
    // Invariant #3: the lane is the PRIMARY STRUCTURAL exclusion from
    // isAutoApprovalCandidate — `live_ingest_new` is the only candidate lane.
    expect(payload.origin_lane).not.toBe(GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW);
    // Belt-and-braces on top of the lane (ticket #678 — neither is redundant).
    expect(payload.suppress_notification).toBe(true);
    expect(payload.review_id).toBe(REVIEW_ID);
    expect(payload.business_id).toBe(BUSINESS_ID);
    expect(payload.version).toBe(3);

    // Topic from QUEUE_NAMES, never a string literal; a well-formed outboxId
    // is both returned by the module AND bound into the INSERT row.
    expect(inserts[0]!.values).toContain(QUEUE_NAMES.GENERATE_RESPONSE);
    expect(typeof result.outboxId).toBe('string');
    expect(String(result.outboxId)).toMatch(UUID_RE);
    expect(inserts[0]!.values).toContain(result.outboxId);

    // Invariant #2: the enqueue INSERT went through the SAME tx instance as the
    // lock and the guards — it is the final statement of the transaction.
    expect(txCallTexts().at(-1)).toContain('INSERT INTO job_outbox');
  });

  it('every sibling read is scoped by business_id as well as review_id', async () => {
    seedHappyPath(1);

    const result = await runGenerate();
    expect(result.ok).toBe(true);

    // The four reads against `responses`: posted-sibling, non-terminal draft,
    // orphan, MAX(version). Invariant #8 — each carries its own business_id
    // scope natively (businessId is already resolved and locked), which is
    // what lets the tenant-scope allowlist entries come out in T3.
    const siblingReads = txCalls.filter((call) => call.text.includes('FROM responses'));
    expect(siblingReads).toHaveLength(4);
    for (const read of siblingReads) {
      const text = read.text.replace(/\s+/g, ' ');
      expect(text).toContain('review_id');
      expect(text).toContain('business_id');
      expect(read.values).toContain(REVIEW_ID);
      expect(read.values).toContain(BUSINESS_ID);
    }
  });
});
