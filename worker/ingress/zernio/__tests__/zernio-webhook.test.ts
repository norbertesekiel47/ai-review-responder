import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mockClaimInboundEvent } = await vi.hoisted(
  async () => {
    const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
    return {
      ...createMockSql(),
      mockClaimInboundEvent: vi.fn(),
    };
  },
);

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../shared', () => ({
  claimInboundEvent: mockClaimInboundEvent,
}));

import { handleZernioWebhook } from '../zernio';
import { SKIP_REASON_ARCHIVED_LOCATION } from '../../../../src/lib/shared/worker-types';

const SECRET = 'test-zernio-webhook-secret';
const origZernioPublishingEnabled = process.env.ZERNIO_PUBLISHING_ENABLED;
const origZernioWebhookSecret = process.env.ZERNIO_WEBHOOK_SECRET;

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function mkRequest(body: Record<string, unknown>, eventId = 'evt_zernio_1'): any {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    headers: {
      'x-zernio-signature': sign(rawBody),
      'x-zernio-event-id': eventId,
    },
  };
}

function mkReply() {
  const status = vi.fn().mockReturnThis();
  const send = vi.fn().mockReturnThis();
  return { status, send };
}

beforeEach(() => {
  resetMockSql();
  vi.clearAllMocks();
  mockClaimInboundEvent.mockResolvedValue('claimed');
  process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  if (origZernioPublishingEnabled === undefined) delete process.env.ZERNIO_PUBLISHING_ENABLED;
  else process.env.ZERNIO_PUBLISHING_ENABLED = origZernioPublishingEnabled;

  if (origZernioWebhookSecret === undefined) delete process.env.ZERNIO_WEBHOOK_SECRET;
  else process.env.ZERNIO_WEBHOOK_SECRET = origZernioWebhookSecret;
});

describe('Zernio account.disconnected webhook', () => {
  it('stamps active teardown offboarding zernio accounts step without connection-lost notification', async () => {
    const teardownUpdate: any = [];
    teardownUpdate.count = 1;
    sqlReturnQueue.push(teardownUpdate);
    sqlReturnQueue.push([]); // inbound_events processed

    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest({
        event: 'account.disconnected',
        id: 'evt_zernio_teardown_disconnect',
        account: { id: 'zernio-account-1' },
      }),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);

    const offboardingUpdate = sqlCalls.find((call) =>
      call.text.includes('UPDATE account_offboardings') &&
      call.text.includes("zernio_accounts_step = 'success'"),
    );
    expect(offboardingUpdate).toBeDefined();
    expect(offboardingUpdate!.text).toContain("status = 'tearing_down'");
    expect(offboardingUpdate!.text).toContain('teardown_started_at IS NOT NULL');
    expect(offboardingUpdate!.text).toContain('teardown_completed_at IS NULL');
    expect(offboardingUpdate!.text).toContain('terminal_at IS NULL');
    expect(offboardingUpdate!.text).toContain('zernio_accounts_step <>');
    expect(offboardingUpdate!.text).toContain('cardinality(zernio_account_ids) = 1');
    expect(offboardingUpdate!.text).toContain('zernio_account_ids');
    expect(offboardingUpdate!.values).toContain('zernio-account-1');

    expect(
      sqlCalls.some((call) => call.text.includes('notify_owner_connection_lost')),
    ).toBe(false);
  });

  it('preserves connection-lost notification behavior outside active teardown', async () => {
    const noTeardownMatch: any = [];
    noTeardownMatch.count = 0;
    sqlReturnQueue.push(noTeardownMatch);
    sqlReturnQueue.push([]); // active teardown membership check
    sqlReturnQueue.push([]); // existing connection-lost transaction
    sqlReturnQueue.push([]); // inbound_events processed

    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest(
        {
          event: 'account.disconnected',
          id: 'evt_zernio_normal_disconnect',
          reason: 'revoked',
          account: { id: 'zernio-account-2' },
        },
        'evt_zernio_normal_disconnect',
      ),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);
    expect(
      sqlCalls.some((call) => call.text.includes('notify_owner_connection_lost')),
    ).toBe(true);
    expect(
      sqlCalls.some((call) => call.text.includes('UPDATE zernio_connections') && call.text.includes("status = 'disconnected'")),
    ).toBe(true);
  });

  it('does not mark a multi-account teardown snapshot success from one account.disconnected webhook', async () => {
    const multiAccountTeardownNotSatisfied: any = [];
    multiAccountTeardownNotSatisfied.count = 0;
    sqlReturnQueue.push(multiAccountTeardownNotSatisfied);
    sqlReturnQueue.push([{ id: 'offboarding-multi-account' }]); // active teardown membership check
    sqlReturnQueue.push([]); // inbound_events processed

    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest(
        {
          event: 'account.disconnected',
          id: 'evt_zernio_multi_teardown_disconnect',
          account: { id: 'zernio-account-3' },
        },
        'evt_zernio_multi_teardown_disconnect',
      ),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);

    const offboardingUpdate = sqlCalls.find((call) =>
      call.text.includes('UPDATE account_offboardings') &&
      call.text.includes("zernio_accounts_step = 'success'"),
    );
    expect(offboardingUpdate).toBeDefined();
    expect(offboardingUpdate!.text).toContain('cardinality(zernio_account_ids) = 1');
    expect(
      sqlCalls.some((call) => call.text.includes('notify_owner_connection_lost')),
    ).toBe(false);
    expect(
      sqlCalls.some((call) => call.text.includes('UPDATE zernio_connections') && call.text.includes("status = 'disconnected'")),
    ).toBe(false);
  });
});

describe('Zernio review fan-out excludes archived locations', () => {
  // Regression pin (Task A1 / spend-leak): archived businesses keep their
  // Zernio connection active for reactivation backfill, so the fan-out MUST
  // inner-join `businesses` and filter `archived_at IS NULL` or it pays for
  // LLM drafts on archived locations. The single fan-out INSERT…SELECT (both
  // location-scoped and account-wide lanes) carries the literal
  // 'ingest_zernio_review', which is how we isolate it. The follow-up
  // archived-vs-unconnected EXISTS probe does not contain that literal.
  // ZernioRecentReviewPoller already filters this way; the webhook lane must
  // match.
  function fanoutQueries(): string[] {
    return sqlCalls
      .map((call) => call.text)
      .filter((text) => text.includes("'ingest_zernio_review'"));
  }

  // The INNER join is load-bearing: a LEFT JOIN with the same ON-clause
  // substrings would satisfy the substring pins while filtering nothing
  // (archived rows survive a LEFT JOIN). Pin both the substrings AND the
  // absence of LEFT [OUTER] JOIN (OUTER is optional SQL syntax for the
  // same join type, so the negative pin must reject it too).
  function expectFanoutExcludesArchived(query: string): void {
    expect(query).toContain('JOIN businesses b ON b.id = zc.business_id');
    expect(query).toContain('b.archived_at IS NULL');
    expect(query).not.toMatch(/LEFT(\s+OUTER)?\s+JOIN\s+businesses/i);
  }

  it('location-scoped fan-out is one query: businesses inner join + archived filter + location predicate', async () => {
    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest(
        {
          event: 'review.new',
          id: 'evt_zernio_review_located',
          account: { id: 'zernio-account-loc' },
          review: { id: 'accounts/g-acc/locations/loc-123/reviews/rev-1' },
        },
        'evt_zernio_review_located',
      ),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);

    const fanout = fanoutQueries();
    expect(fanout).toHaveLength(1);
    expectFanoutExcludesArchived(fanout[0]!);
    // Location-scoped lane: the conditional fragment narrows by the payload's
    // location id, and the bound value is the parsed location segment.
    expect(fanout[0]).toMatch(/AND\s+zc\.zernio_location_id\s*=\s*\?/);
    const fanoutCall = sqlCalls.find((call) => call.text.includes("'ingest_zernio_review'"));
    expect(fanoutCall!.values).toContain('loc-123');
  });

  it('account-wide fallback fan-out is one query without the location predicate', async () => {
    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest(
        {
          event: 'review.new',
          id: 'evt_zernio_review_accountwide',
          account: { id: 'zernio-account-wide' },
          review: { id: 'rev-bare-1' },
        },
        'evt_zernio_review_accountwide',
      ),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);

    const fanout = fanoutQueries();
    expect(fanout).toHaveLength(1);
    expectFanoutExcludesArchived(fanout[0]!);
    // Account-wide lane: no location narrowing in the WHERE clause.
    expect(fanout[0]).not.toMatch(/AND\s+zc\.zernio_location_id\s*=\s*\?/);
  });
});

describe('Zernio review fan-out zero-row disambiguation', () => {
  // Archived locations keep status='active' connections by design, so a
  // 0-row fan-out is ambiguous: archived location vs genuinely unconnected.
  // The handler runs a follow-up EXISTS probe and logs a calm structured
  // line for the archived case instead of the misleading unconnected warn.
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  function zeroRowFanout(): unknown[] & { count: number } {
    return Object.assign([], { count: 0 });
  }

  it('logs a structured archived_location line (no unconnected warn) when an archived connection matches', async () => {
    sqlReturnQueue.push(zeroRowFanout()); // fan-out INSERT…SELECT → 0 rows
    sqlReturnQueue.push([{ archived_match: true }]); // EXISTS probe
    sqlReturnQueue.push([]); // inbound_events processed

    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest(
        {
          event: 'review.new',
          id: 'evt_zernio_review_archived_only',
          account: { id: 'zernio-account-archived' },
          review: { id: 'accounts/g-acc/locations/loc-arch/reviews/rev-2' },
        },
        'evt_zernio_review_archived_only',
      ),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);

    const existsProbe = sqlCalls.find((call) => call.text.includes('SELECT EXISTS'));
    expect(existsProbe).toBeDefined();
    expect(existsProbe!.text).toContain('b.archived_at IS NOT NULL');
    expect(existsProbe!.values).toContain('loc-arch');

    // The log claims only what the probe proves: an archived connection is
    // PRESENT — not that the archived match is the ONLY explanation (an
    // ON CONFLICT dedup with a sibling archived connection also yields 0 rows).
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('archived connection(s) present'),
      expect.objectContaining({ reason: SKIP_REASON_ARCHIVED_LOCATION }),
    );
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('no business has connected this account/location'),
    );
  });

  it('swallows a transient probe failure: event still succeeds with 200 + processed (no 500/Zernio retry)', async () => {
    sqlReturnQueue.push(zeroRowFanout()); // fan-out INSERT…SELECT → 0 rows
    // EXISTS probe → transient DB error. Pre-handle the rejection so Node
    // doesn't flag it as unhandled before the mock thenable adopts it.
    const probeFailure = Promise.reject(new Error('transient probe blip'));
    probeFailure.catch(() => {});
    sqlReturnQueue.push(probeFailure);
    sqlReturnQueue.push([]); // inbound_events processed

    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest(
        {
          event: 'review.new',
          id: 'evt_zernio_review_probe_blip',
          account: { id: 'zernio-account-probe-blip' },
          review: { id: 'accounts/g-acc/locations/loc-blip/reviews/rev-3' },
        },
        'evt_zernio_review_probe_blip',
      ),
      { status, send } as any,
    );

    // The fan-out (primary side effect) already succeeded — the probe is
    // pure observability, so its failure is logged and swallowed.
    expect(status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith({ received: true });
    expect(sqlCalls.some((call) => call.text.includes("status = 'processed'"))).toBe(true);
    expect(sqlCalls.some((call) => call.text.includes("status = 'failed'"))).toBe(false);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('probe failed'),
    );
    // Neither disambiguation line may fire — the probe never resolved.
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: SKIP_REASON_ARCHIVED_LOCATION }),
    );
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('no business has connected this account/location'),
    );
  });

  it('keeps the unconnected warn when no archived connection matches either', async () => {
    sqlReturnQueue.push(zeroRowFanout()); // fan-out INSERT…SELECT → 0 rows
    sqlReturnQueue.push([{ archived_match: false }]); // EXISTS probe
    sqlReturnQueue.push([]); // inbound_events processed

    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest(
        {
          event: 'review.new',
          id: 'evt_zernio_review_unconnected',
          account: { id: 'zernio-account-nobody' },
          review: { id: 'rev-bare-2' },
        },
        'evt_zernio_review_unconnected',
      ),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no business has connected this account/location'),
    );
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: SKIP_REASON_ARCHIVED_LOCATION }),
    );
  });
});
