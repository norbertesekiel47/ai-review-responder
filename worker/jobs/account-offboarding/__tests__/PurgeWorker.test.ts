import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { AccountOffboardingPurgePayload } from '../../../../src/lib/shared/worker-types';

interface QueryCall {
  text: string;
  values: unknown[];
  scope: 'sql' | 'tx';
}

interface MockOffboardingRow {
  id: string;
  account_id: string;
  mode: 'delete_data';
  status: 'purge_scheduled' | 'purged' | 'failed';
  terminal_at: Date | null;
  teardown_completed_at: Date | null;
  purge_started_at: Date | null;
  purge_cancelled_at: Date | null;
  auth_user_id: string | null;
  recipient_email: string | null;
  provider_dispositions: unknown[];
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
  location_ids: string[] | null;
  stripe_step: string | null;
  zernio_accounts_step: string | null;
  zernio_profiles_step: string | null;
  location_archival_step: string | null;
}

const ACCOUNT_ID = '00000000-0000-7000-8000-000000000001';
const OFFBOARDING_ID = '00000000-0000-7000-8000-000000000002';
const OUTBOX_ID = '00000000-0000-7000-8000-000000000003';
const AUTH_USER_ID = 'auth-user-1';
// One location under the account, so runContentPurgeStage's per-business
// advisory-lock loop actually executes. Referenced from inside vi.hoisted's
// execute(), which is only CALLED after module init — same pattern as
// OFFBOARDING_ID above.
const BUSINESS_ID = '00000000-0000-7000-8000-000000000005';

const {
  calls,
  mockState,
  mockSql,
  mockSupabaseServer,
  mockDeleteUser,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockVerifyAccountOffboardingPurge,
  mockCaptureMessage,
  mockEnqueueOffboardingPurged,
  mockSendInternalEmail,
  stageOrder,
  mockRedactionStage,
} = vi.hoisted(() => {
  const calls: QueryCall[] = [];
  const mockState = {
    offboarding: null as MockOffboardingRow | null,
    authRevalidationPasses: true,
    authAlreadyDetached: false,
    /** Rows the #643 retained-count query finds (spec §6.3, G5). */
    retainedGlobalSuppressions: 0,
  };

  const execute = async (
    scope: QueryCall['scope'],
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join('?');
    calls.push({ text, values, scope });

    if (text.includes('FROM account_offboardings') && text.includes('WHERE id =')) {
      return mockState.offboarding ? [structuredClone(mockState.offboarding)] : [];
    }

    if (text.includes('FROM users u') && text.includes('u.auth_id =')) {
      return mockState.authRevalidationPasses
        ? [{ can_delete: true, already_detached: false }]
        : [{ can_delete: false, already_detached: mockState.authAlreadyDetached }];
    }

    if (text.includes('SELECT id') && text.includes('FROM job_outbox') && text.includes('offboarding_scope AS')) {
      return [{ id: '00000000-0000-7000-8000-000000000004' }];
    }

    if (text.includes('UPDATE job_outbox') && text.includes("status IN ('pending', 'dispatching', 'dispatched')")) {
      return [{ id: '00000000-0000-7000-8000-000000000004' }];
    }

    if (text.includes('UPDATE account_offboardings') && text.includes('auth_user_id = NULL')) {
      if (mockState.offboarding) mockState.offboarding.auth_user_id = null;
      return [{ id: OFFBOARDING_ID }];
    }

    if (text.includes('FROM job_outbox') && text.includes('FOR UPDATE')) {
      return [{ id: OUTBOX_ID }];
    }

    // The per-business advisory-lock loop in runContentPurgeStage. Returning a
    // row is what makes the loop EXECUTE, which is what lets the lock-order
    // assertion below see the pg_advisory_xact_lock calls at all. Matched on
    // ORDER BY id so the many `... IN (SELECT id FROM businesses ...)`
    // subqueries elsewhere in the purge keep returning [].
    if (
      text.includes('SELECT id FROM businesses WHERE account_id =')
      && text.includes('ORDER BY id')
    ) {
      return [{ id: BUSINESS_ID }];
    }

    if (text.includes('AS retained_count') && text.includes('FROM solicitation_suppressions')) {
      return [{ retained_count: mockState.retainedGlobalSuppressions }];
    }

    if (text.includes('UPDATE job_outbox') && text.includes("status = 'completed'")) {
      return [{ id: OUTBOX_ID }];
    }

    if (text.includes("SET status = 'purged'")) {
      if (mockState.offboarding) {
        mockState.offboarding.status = 'purged';
        mockState.offboarding.terminal_at = new Date('2026-06-07T12:00:00.000Z');
      }
      return [{ id: OFFBOARDING_ID }];
    }

    if (text.includes("SET status = 'failed'") && text.includes("failed_step = 'purge'")) {
      if (mockState.offboarding) mockState.offboarding.status = 'failed';
      return [{ id: OFFBOARDING_ID }];
    }

    return [];
  };

  // A single-string call is Postgres.js identifier interpolation (sql('table')); model it
  // as an opaque fragment rather than a tagged-template query so dynamic-table SQL works.
  const identifierFragment = (strings: unknown) =>
    !Array.isArray(strings) ? { __id: String(strings) } : null;
  const mockSql: any = vi.fn((strings: any, ...values: unknown[]) =>
    identifierFragment(strings) ?? execute('sql', strings, ...values)
  );
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
    const tx: any = vi.fn((strings: any, ...values: unknown[]) =>
      identifierFragment(strings) ?? execute('tx', strings, ...values)
    );
    tx.json = mockSql.json;
    return cb(tx);
  });
  mockSql.json = vi.fn((value: unknown) => value);

  const mockDeleteUser = vi.fn(async () => ({ data: {}, error: null }));
  const mockSupabaseServer: any = {
    auth: {
      admin: {
        deleteUser: mockDeleteUser,
      },
    },
  };

  return {
    calls,
    mockState,
    mockSql,
    mockSupabaseServer,
    mockDeleteUser,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockVerifyAccountOffboardingPurge: vi.fn(async () => ({ ok: true, issues: [] })),
    mockCaptureMessage: vi.fn(),
    mockEnqueueOffboardingPurged: vi.fn(),
    /** Stage call order, recorded by the delegating spies below. */
    stageOrder: [] as string[],
    mockRedactionStage: vi.fn(),
    mockSendInternalEmail: vi.fn(),
  };
});

// Transitive-import shield: the SUT (PurgeWorker + purge-stages) no longer
// imports the db/server singletons — they are injected below via mockSql +
// mockSupabaseServer. This mock only stops any transitive importer from
// constructing a real Postgres/Supabase client at module load.
vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
  supabaseServer: mockSupabaseServer,
  supabaseServerBounded: mockSupabaseServer,
}));

vi.mock('../../../../src/lib/shared/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/shared/outbox')>();
  return {
    ...actual,
    markOutboxCompleted: mockMarkOutboxCompleted,
    markOutboxFailed: mockMarkOutboxFailed,
    extractOutboxHandle: (data: { outbox_id?: string; outbox_attempt?: number }, fallback: string) => ({
      outboxId: data.outbox_id ?? fallback,
      attempt: data.outbox_attempt,
    }),
  };
});

vi.mock('../../../../src/lib/account-offboarding/purge-verification', () => ({
  verifyAccountOffboardingPurge: mockVerifyAccountOffboardingPurge,
}));

vi.mock('../../../../src/lib/account-offboarding/analytics', () => ({
  enqueueOffboardingPurged: mockEnqueueOffboardingPurged,
}));

vi.mock('../../../../src/lib/notifications/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/notifications/email')>();
  return {
    ...actual,
    sendInternalEmail: mockSendInternalEmail,
  };
});

vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
}));

vi.mock('../../../../src/lib/payments/stripe-client', () => ({
  getStripe: () => ({ customers: { retrieve: vi.fn(), update: vi.fn(), del: vi.fn() } }),
}));

// Partial mock: every stage keeps its REAL body (so the rest of this suite
// still drives real SQL against the mock client) and only records its name.
// A pure spy would turn every other test in this file into a no-op.
vi.mock('../purge-stages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../purge-stages')>();
  const trace = <A extends unknown[], R>(
    name: string,
    fn: (...args: A) => Promise<R>,
  ) => async (...args: A): Promise<R> => {
    stageOrder.push(name);
    return fn(...args);
  };
  return {
    ...actual,
    runAuditAndCostPayloadPurgeStage: trace(
      'audit',
      actual.runAuditAndCostPayloadPurgeStage,
    ),
    runStripeCustomerRedactionPurgeStage: mockRedactionStage,
    runParentTombstonePurgeStage: trace(
      'tombstone',
      actual.runParentTombstonePurgeStage,
    ),
  };
});

vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  handleAccountOffboardingPurge,
  PURGE_RETRY_FINGERPRINT,
  PURGE_TERMINAL_FINGERPRINT_PREFIX,
} from '../PurgeWorker';

/** The runbook that owns the Sentry rule routing this worker's terminal alert. */
const ALERTING_RUNBOOK = 'docs/runbooks/beta-launch-alerting.md';

/** The alert rule's name, and the first cell of the table row that configures it. */
const RULE_16_ROW_NAME = 'account-offboarding-purge-terminal → discord';

/**
 * Rule 16's own block: from its `**Rule 16` header to the next `**Rule ` header
 * or `## ` section heading.
 *
 * Slicing is the whole point. A file-wide `toContain` let the red team corrupt
 * this rule's row to `terminal equals false` at `warning` grouping on the RETRY
 * fingerprint and keep the test green, because §1's checklist bullet carries
 * the same strings (red-team RT-A6). The operator configures Sentry from the
 * ROW, so the row is what has to be pinned.
 */
function rule16Block(runbook: string): string {
  const start = runbook.indexOf('**Rule 16');
  expect(start, 'the runbook has no **Rule 16 block').toBeGreaterThan(-1);
  const rest = runbook.slice(start + '**Rule 16'.length);
  const ends = [rest.indexOf('\n**Rule '), rest.indexOf('\n## ')].filter((index) => index >= 0);
  return ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest;
}

/** The one table row inside rule 16's block that names the alert rule. */
function rule16TableRow(block: string): string {
  const row = block
    .split('\n')
    .find((line) => line.startsWith('|') && line.includes(RULE_16_ROW_NAME));
  expect(row, `rule 16 has no table row for ${RULE_16_ROW_NAME}`).toBeDefined();
  return row!;
}

/** `[a, b, …]` as the runbook spells a fingerprint, from the constants themselves. */
function fingerprintPattern(members: readonly string[]): RegExp {
  return new RegExp(`\\[\\s*${members.join(',\\s*')}\\s*\\]`);
}

describe('AccountOffboarding PurgeWorker', () => {
  beforeEach(() => {
    calls.length = 0;
    mockSql.mockClear();
    mockSql.begin.mockClear();
    mockDeleteUser.mockClear();
    mockMarkOutboxCompleted.mockClear();
    mockMarkOutboxFailed.mockClear();
    mockVerifyAccountOffboardingPurge.mockClear();
    mockVerifyAccountOffboardingPurge.mockResolvedValue({ ok: true, issues: [] });
    mockCaptureMessage.mockClear();
    mockEnqueueOffboardingPurged.mockClear();
    mockEnqueueOffboardingPurged.mockResolvedValue(undefined);
    stageOrder.length = 0;
    mockRedactionStage.mockReset();
    mockRedactionStage.mockImplementation(async () => {
      stageOrder.push('redaction');
    });
    mockSendInternalEmail.mockClear();
    mockSendInternalEmail.mockResolvedValue({ messageId: 'email-purge-receipt-1' });
    mockState.authRevalidationPasses = true;
    mockState.authAlreadyDetached = false;
    mockState.retainedGlobalSuppressions = 0;
    mockState.offboarding = {
      id: OFFBOARDING_ID,
      account_id: ACCOUNT_ID,
      mode: 'delete_data',
      status: 'purge_scheduled',
      terminal_at: null,
      teardown_completed_at: new Date('2026-06-07T11:00:00.000Z'),
      purge_started_at: new Date('2026-06-07T11:30:00.000Z'),
      purge_cancelled_at: null,
      auth_user_id: AUTH_USER_ID,
      recipient_email: 'owner@example.com',
      provider_dispositions: [],
      stripe_customer_id: 'cus_123',
      stripe_subscription_id: 'sub_123',
      zernio_account_ids: ['zernio-account-1'],
      zernio_profile_ids: ['zernio-profile-1'],
      location_ids: ['00000000-0000-7000-8000-0000000000a1'],
      stripe_step: 'success',
      zernio_accounts_step: 'success',
      zernio_profiles_step: 'success',
      location_archival_step: 'success',
    };
  });

  it('revalidates the captured auth binding, deletes the auth user outside a transaction, then terminalizes after verification', async () => {
    await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob());

    const revalidateIdx = calls.findIndex((call) =>
      call.text.includes('FROM users u') && call.text.includes('u.auth_id =')
    );
    expect(revalidateIdx).toBeGreaterThanOrEqual(0);
    expect(calls[revalidateIdx]!.scope).toBe('tx');
    expect(calls[revalidateIdx]!.text).toContain('u.account_id =');
    expect(calls[revalidateIdx]!.text).toContain('future_binding.account_id <>');

    const deleteOrder = mockDeleteUser.mock.invocationCallOrder[0]!;
    const firstTxOrder = mockSql.begin.mock.invocationCallOrder[0]!;
    const secondTxOrder = mockSql.begin.mock.invocationCallOrder[1]!;
    expect(firstTxOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(secondTxOrder);
    expect(mockDeleteUser).toHaveBeenCalledWith(AUTH_USER_ID);

    expect(mockVerifyAccountOffboardingPurge).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      offboardingId: OFFBOARDING_ID,
      currentOutboxId: OUTBOX_ID,
      authUserId: AUTH_USER_ID,
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      zernioAccountIds: ['zernio-account-1'],
      zernioProfileIds: ['zernio-profile-1'],
    }, expect.any(Function));
    const terminalIdx = calls.findIndex((call) => call.text.includes("SET status = 'purged'"));
    expect(terminalIdx).toBeGreaterThanOrEqual(0);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingPurged).toHaveBeenCalledWith(expect.any(Function), {
      offboardingId: OFFBOARDING_ID,
    });
    expect(mockVerifyAccountOffboardingPurge.mock.invocationCallOrder[0]!).toBeLessThan(
      mockEnqueueOffboardingPurged.mock.invocationCallOrder[0]!,
    );
    // M2: the purge receipt is enqueued durably inside the finalize tx (carrying
    // the recipient in the payload because the row is scrubbed), not sent
    // best-effort post-commit.
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    const receiptEnqueue = calls.find(
      (call) => call.text.includes('INSERT INTO job_outbox')
        && call.values.includes('account_offboarding_email'),
    );
    expect(receiptEnqueue).toBeDefined();
    expect(receiptEnqueue!.scope).toBe('tx');
    const receiptPayload = receiptEnqueue!.values.find(
      (value) => value !== null && typeof value === 'object'
        && (value as { email_type?: string }).email_type === 'purge_receipt',
    ) as { email_type: string; recipient_email?: string } | undefined;
    expect(receiptPayload?.recipient_email).toBe('owner@example.com');
    const sqlText = calls.map((call) => call.text).join('\n');
    expect(sqlText).toContain('job_outbox.id <>');
    expect(sqlText).toContain('onboarding_demo_scope AS');
    expect(sqlText).toContain('length(btrim(s.identifier)) > 0');
    expect(sqlText).toContain("SET status = 'completed'");
    expect(sqlText).toContain('AND attempts = ?');
    expect(sqlText).toContain("status IN ('pending', 'dispatching', 'dispatched')");
    expect(sqlText).toContain('WHERE id = ?::uuid');
    expect(sqlText).toContain('payload = ?');
    // D3 regression: scrub the REAL approval_audit_log PII columns; never the
    // phantom columns approval_link_id / user_agent (which don't exist in the
    // schema and made every purge throw). Scoped to the approval_audit_log
    // statement so a real user_agent column on another table can't mask this.
    const approvalScrub = calls.find((call) => call.text.includes('UPDATE approval_audit_log'));
    expect(approvalScrub?.text).toContain('response_text_at_approval = NULL');
    expect(approvalScrub?.text).toContain('token_hash = NULL');
    expect(approvalScrub?.text).not.toContain('approval_link_id');
    expect(approvalScrub?.text).not.toContain('user_agent');
    expect(sqlText).toContain('provider_dispositions = provider_dispositions ||');
    const notificationDelete = calls.find((call) => call.text.includes('DELETE FROM notification_deliveries'));
    expect(notificationDelete?.text).toContain('nd.account_id =');
    expect(notificationDelete?.text).toContain('nd.business_id IN');
    expect(notificationDelete?.text).toContain('SELECT id FROM businesses WHERE account_id =');
    // channel_enrollments is hard_delete/must_be_absent — the purge fails its own
    // verification gate if no stage deletes these rows (DELETE moved here from the
    // removed SMS opt-out stage in migration-061 cleanup).
    const enrollmentDelete = calls.find((call) => call.text.includes('DELETE FROM channel_enrollments'));
    expect(enrollmentDelete?.text).toContain('account_id =');
    expect(enrollmentDelete?.scope).toBe('tx');
    // Contacts CSV ingestion (migration 086, #541): contact_csv_uploads is
    // hard_delete/must_be_absent and businesses/accounts are never DELETEd
    // (retain_deidentified), so the account-scoped upload delete is the only
    // thing that sweeps these rows — solicitation_contacts/solicitation_visits
    // are NOT deleted explicitly here; they cascade via FK (asserted below).
    const contactCsvUploadsDelete = calls.find((call) => call.text.includes('DELETE FROM contact_csv_uploads'));
    expect(contactCsvUploadsDelete?.text).toContain('account_id =');
    expect(contactCsvUploadsDelete?.scope).toBe('tx');
    expect(sqlText).not.toContain('DELETE FROM solicitation_contacts');
    expect(sqlText).not.toContain('DELETE FROM solicitation_visits');
    expect(sqlText).not.toContain('DELETE FROM solicitation_batches');
    expect(sqlText).not.toContain('DELETE FROM solicitation_asks');
    // Consent ledger (migration 093, #625): businesses rows are TOMBSTONED,
    // never deleted, so 093's business_id ON DELETE CASCADE never fires on
    // this path; source_upload_id is ON DELETE SET NULL and consent has no FK
    // to contacts, so the upload delete above sweeps nothing here either. The
    // explicit deleteByBusiness call is the ONLY deleter at purge (spec §7.2's
    // cascade assumption was wrong; consent fails closed — DR1). The table
    // name arrives as an identifier fragment (see identifierFragment above).
    const isConsentByBusinessDelete = (call: QueryCall) =>
      call.text.includes('DELETE FROM ?')
      && call.values.some((value) => (value as { __id?: string } | null)?.__id === 'solicitation_consent');
    const consentDeleteIndex = calls.findIndex(isConsentByBusinessDelete);
    expect(consentDeleteIndex).toBeGreaterThan(-1);
    expect(calls[consentDeleteIndex]?.text).toContain(
      'SELECT id FROM businesses WHERE account_id =',
    );
    expect(calls[consentDeleteIndex]?.scope).toBe('tx');
    // Agent run spine tables are hard_delete/must_be_absent (accounts rows are
    // retained de-identified, so their ON DELETE CASCADE never fires) — the
    // purge must delete outcomes and runs explicitly; agent_run_steps cascades
    // via its agent_runs FK, so no explicit steps DELETE may appear.
    const agentOutcomesDelete = calls.find((call) => call.text.includes('DELETE FROM agent_outcomes'));
    expect(agentOutcomesDelete?.text).toContain('account_id =');
    expect(agentOutcomesDelete?.scope).toBe('tx');
    const agentRunsDelete = calls.find((call) => call.text.includes('DELETE FROM agent_runs'));
    expect(agentRunsDelete?.text).toContain('account_id =');
    expect(agentRunsDelete?.scope).toBe('tx');
    expect(sqlText).not.toContain('DELETE FROM agent_run_steps');

    // #892 / lab-notes/history/2026-05.md "An exact count written into a comment is a maintenance
    // trap". docs/directory/lib-account-offboarding.md states 29 writer assignments against the
    // verifier's 28 predicates — the whole point of #892 being that the old
    // number (27) had rotted unpinned. Pin the writer half here; the verifier
    // half is pinned in purge-verification.test.ts.
    const businessTombstone = calls.find(
      (call) => call.text.includes('UPDATE businesses') && call.text.includes('SET name ='),
    );
    expect(businessTombstone, 'no businesses tombstone UPDATE emitted').toBeDefined();
    const setClause = businessTombstone!.text
      .replace(/--[^\n]*/g, '')
      .split('SET ')[1]!
      .split('WHERE ')[0]!;
    const assignments = (setClause.match(/^\s*[a-z_]+ =/gm) ?? []).length;
    // 28 tombstone-state columns + updated_at. The verifier deliberately does
    // NOT check updated_at, which is why the two numbers differ by one.
    expect(assignments).toBe(29);
    expect(setClause).toContain('updated_at = NOW()');

    // The order that IS load-bearing, and it is a LOCK order, not an FK one.
    // agent_runs row locks must be taken after the per-business advisory locks,
    // because approval.ts/outreach.ts/batch-builder.ts all take
    // batch-lock -> solicitation_batches row -> agent_runs. Hoisting this
    // DELETE above the lock loop is an ABBA deadlock against the solicitation
    // lane.
    const advisoryLockIndexes = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.text.includes('pg_advisory_xact_lock'))
      .map(({ index }) => index);
    expect(advisoryLockIndexes.length).toBeGreaterThanOrEqual(2);
    const agentRunsDeleteIndex = calls.findIndex((call) => call.text.includes('DELETE FROM agent_runs'));
    expect(agentRunsDeleteIndex).toBeGreaterThan(Math.max(...advisoryLockIndexes));

    // Deliberately NOT asserted: outcomes-before-runs. That order is not
    // load-bearing — the outcomes DELETE is scoped by account_id, not
    // agent_run_id, so deleting runs first would merely NULL the FK
    // (071:71, ON DELETE SET NULL) and this statement would still remove every
    // row. A test that pins it claims a constraint the code does not have.

    // Guardian escalations (migration 073) are hard_delete/must_be_absent and
    // review_id has NO cascade — the escalations DELETE must run before the
    // reviews DELETE or the purge dies on an FK violation. The reviews delete
    // goes through deleteByBusiness, so its table name arrives as an identifier
    // fragment value (see identifierFragment above), not in the query text.
    const escalationsDelete = calls.find((call) => call.text.includes('DELETE FROM review_escalations'));
    expect(escalationsDelete?.text).toContain('account_id =');
    expect(escalationsDelete?.scope).toBe('tx');
    const isReviewsByBusinessDelete = (call: QueryCall) =>
      call.text.includes('DELETE FROM ?')
      && call.values.some((value) => (value as { __id?: string } | null)?.__id === 'reviews');
    expect(calls.findIndex(isReviewsByBusinessDelete)).toBeGreaterThan(-1);
    expect(calls.findIndex((call) => call.text.includes('DELETE FROM review_escalations')))
      .toBeLessThan(calls.findIndex(isReviewsByBusinessDelete));
    expect(sqlText).toContain('recipient_email = NULL');
    expect(sqlText).toContain('stripe_customer_id = NULL');
    expect(sqlText).toContain('stripe_subscription_id = NULL');
    expect(sqlText).toContain('zernio_account_ids = NULL');
    expect(sqlText).toContain('zernio_profile_ids = NULL');
    expect(sqlText).toContain('auth_user_id = NULL');
    expect(sqlText).toContain('last_error = NULL');
    // One scrub over a single account-scope predicate (write-side twin of the purge
    // verification): FK by account/business/user OR a raw account id left in distinct_id.
    const analyticsUpdates = calls.filter((call) => call.text.includes('UPDATE analytics_events'));
    expect(analyticsUpdates).toHaveLength(1);
    const analyticsUpdate = analyticsUpdates[0]!;
    expect(analyticsUpdate.text).toContain("event_key = 'scrubbed:' ||");
    expect(analyticsUpdate.text).toContain("distinct_id = 'scrubbed:' ||");
    expect(analyticsUpdate.text).toContain('anonymous_id = NULL');
    expect(analyticsUpdate.text).toContain('account_id = NULL');
    expect(analyticsUpdate.text).toContain('user_id = NULL');
    expect(analyticsUpdate.text).toContain('business_id = NULL');
    expect(analyticsUpdate.text).toContain("properties = '{}'::jsonb");
    expect(analyticsUpdate.text).toContain('last_error = NULL');
    expect(analyticsUpdate.text).toContain('WHERE account_id =');
    expect(analyticsUpdate.text).toContain('business_id IN (SELECT id FROM businesses');
    expect(analyticsUpdate.text).toContain('user_id IN (SELECT id FROM users');
    // M1: FK-independent branch catches a raw account identifier left in distinct_id.
    expect(analyticsUpdate.text).toContain('distinct_id IN');
    expect(sqlText).not.toContain('account_offboarding_purge_receipt');
    expect(sqlText).not.toContain('INSERT INTO notification_deliveries');
    expect(sqlText).not.toContain('owner@example.com');
    expect(sqlText).not.toContain('email-purge-receipt-1');
    expect(calls.some((call) =>
      call.values.some((value) =>
        Array.isArray(value) &&
        value.some((entry) =>
          entry &&
          typeof entry === 'object' &&
          'job_outbox_id' in entry &&
          entry.job_outbox_id === '00000000-0000-7000-8000-000000000004'
        )
      )
    )).toBe(true);
    expect(sqlText).not.toContain("status = 'purging'");
  });

  // #643 G5 / spec §6.3. The count has to be taken in the SAME transaction as the
  // state change and the receipt enqueue (invariant #2): counting outside it would
  // report a number the committed purge never agreed to.
  it('counts retained global suppression rows inside the finalize transaction and threads the count into the purge receipt', async () => {
    mockState.retainedGlobalSuppressions = 2;

    await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob());

    // Not merely "touches the table" — the content-purge stage's account-scoped
    // DELETE hits it too, and that one must not be mistaken for the count.
    const countIdx = calls.findIndex(
      (call) => call.text.includes('AS retained_count')
        && call.text.includes('FROM solicitation_suppressions'),
    );
    expect(countIdx).toBeGreaterThanOrEqual(0);
    expect(calls[countIdx]!.scope).toBe('tx');
    expect(calls[countIdx]!.text).toContain("scope = 'global'");
    expect(calls[countIdx]!.text).toContain('account_id =');
    expect(calls[countIdx]!.values).toContain(ACCOUNT_ID);
    // Unsubscribe token rows are opt-out MECHANISMS, not opt-out records, and
    // their account_id is already NULL by now — never countable, never counted.
    expect(calls[countIdx]!.text).not.toContain('solicitation_unsubscribe_tokens');

    // Same transaction as the finalize: after the outbox row is locked FOR UPDATE
    // and before the receipt is enqueued on it.
    const lockIdx = calls.findIndex(
      (call) => call.text.includes('FROM job_outbox') && call.text.includes('FOR UPDATE'),
    );
    const receiptIdx = calls.findIndex(
      (call) => call.text.includes('INSERT INTO job_outbox')
        && call.values.includes('account_offboarding_email'),
    );
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(countIdx).toBeGreaterThan(lockIdx);
    expect(receiptIdx).toBeGreaterThan(countIdx);

    const receiptPayload = calls[receiptIdx]!.values.find(
      (value) => value !== null && typeof value === 'object'
        && (value as { email_type?: string }).email_type === 'purge_receipt',
    ) as { retained_suppression_count?: number } | undefined;
    expect(receiptPayload?.retained_suppression_count).toBe(2);
  });

  it('does not call deleteUser when immediate auth revalidation fails', async () => {
    mockState.authRevalidationPasses = false;

    await expect(handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_auth_revalidation_failed',
    );

    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('treats auth not-found as success only after revalidation has already passed', async () => {
    mockDeleteUser.mockResolvedValueOnce({
      data: {},
      error: { message: 'User not found', status: 404 },
    } as never);

    await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob());

    expect(mockDeleteUser).toHaveBeenCalledWith(AUTH_USER_ID);
    expect(mockState.offboarding?.status).toBe('purged');
  });

  it('allows purge when admin provider disposition covers every applicable failed provider step', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      // The Zernio account teardown failed; the concrete Zernio disposition covers it.
      // Every other applicable provider step succeeded, so the purge is safe.
      zernio_accounts_step: 'failed',
      provider_dispositions: [{
        type: 'admin_provider_disposition',
        provider: 'zernio',
        resource_type: 'account',
        scrubbed_resource_reference: 'sha256:provider-ref',
        admin_actor_user_id: 'admin-1',
        reason: 'Provider support confirmed teardown.',
        recorded_at: '2026-06-07T12:00:00.000Z',
        ticket: 'SUP-123',
      }],
    };

    await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob());

    expect(mockVerifyAccountOffboardingPurge).toHaveBeenCalledOnce();
    expect(mockState.offboarding?.status).toBe('purged');
  });

  it('refuses to purge when a concrete disposition leaves another applicable provider step unresolved (H2 defense-in-depth)', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      // Stripe teardown failed and the Zernio account step never ran (default
      // 'not_applicable') even though a Zernio account exists. Only Zernio is
      // dispositioned, so the live Stripe subscription is still unresolved.
      stripe_step: 'failed',
      zernio_accounts_step: 'not_applicable',
      provider_dispositions: [{
        type: 'admin_provider_disposition',
        provider: 'zernio',
        resource_type: 'account',
        scrubbed_resource_reference: 'sha256:provider-ref',
        admin_actor_user_id: 'admin-1',
        reason: 'Provider support confirmed teardown.',
        recorded_at: '2026-06-07T12:00:00.000Z',
        ticket: 'SUP-123',
      }],
    };

    await expect(handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_teardown_incomplete',
    );

    expect(mockVerifyAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
  });

  it('does not treat generic provider markers as provider-disposition purge eligibility', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      provider_dispositions: [{ provider: 'zernio', disposition: 'admin_recorded' }],
    };

    await expect(handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_teardown_incomplete',
    );

    expect(mockVerifyAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('does not treat non-admin scrub-scope records as provider-disposition purge eligibility', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      provider_dispositions: [{
        type: 'job_outbox_scrub_scope',
        job_outbox_id: 'some-outbox-id',
        job_outbox_id_hash: 'some-hash',
      }],
    };

    await expect(handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_teardown_incomplete',
    );

    expect(mockVerifyAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('terminally fails and stores a scrubbed error when final verification finds remnants on the last attempt', async () => {
    mockVerifyAccountOffboardingPurge.mockResolvedValueOnce({
      ok: false,
      issues: [
        {
          table: 'responses',
          purgeVerification: 'must_be_absent',
          disposition: 'hard_delete',
          violationCount: 1,
          reason: 'content',
        },
      ],
    } as never);

    await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 2, attempts: 3 }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      OUTBOX_ID,
      'account_offboarding_purge_verification_failed:responses',
      2,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockState.offboarding?.status).toBe('failed');
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  // ── The purge-failure alert splits terminal from retry (#1016) ─────────
  //
  // One constant message with no fingerprint grouped a retry `warning` and the
  // terminal `error` into ONE Sentry issue, so a first-seen rule fired on an
  // early retry and never on the terminal event (red-team RT-08). The
  // fingerprints are spelled out here rather than imported from PurgeWorker on
  // purpose: they are an operator-facing contract with a configured Sentry
  // rule, and importing them would let a rename pass on both sides while every
  // rule stopped matching. The doc pin below reads the exported constants —
  // that comparison is between two artifacts and must not be hand-copied.
  //
  // The terminal arm carries a THIRD member, the offboarding id: Sentry's
  // action throttle is per issue, so one shared terminal issue swallowed a
  // second account's page inside the 60-minute window (Codex A1).
  describe('purge-failure alert fingerprints', () => {
    it('alerts a terminal stage failure with the terminal fingerprint at error level', async () => {
      mockRedactionStage.mockImplementation(async () => {
        throw new Error('stripe connection error');
      });

      await handleAccountOffboardingPurge(
        mockSql,
        mockSupabaseServer,
        makeJob({ attemptsMade: 2, attempts: 3 }),
      );

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'account_offboarding_purge_failed',
        expect.objectContaining({
          level: 'error',
          fingerprint: ['account_offboarding_purge_failed', 'terminal', OFFBOARDING_ID],
          tags: expect.objectContaining({ terminal: 'true' }),
        }),
      );
    });

    it('alerts a retryable stage failure with the retry fingerprint at warning level', async () => {
      mockRedactionStage.mockImplementation(async () => {
        throw new Error('stripe connection error');
      });

      await expect(
        handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 })),
      ).rejects.toThrow('stripe connection error');

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'account_offboarding_purge_failed',
        expect.objectContaining({
          level: 'warning',
          fingerprint: ['account_offboarding_purge_failed', 'retry'],
          tags: expect.objectContaining({ terminal: 'false' }),
        }),
      );
    });

    it('alerts a terminal validation failure with the terminal fingerprint', async () => {
      // The OTHER call site: validation rejects before the stage loop opens, and
      // it takes the same fingerprint a terminal stage failure does.
      mockState.offboarding = { ...mockState.offboarding!, teardown_completed_at: null };

      await handleAccountOffboardingPurge(
        mockSql,
        mockSupabaseServer,
        makeJob({ attemptsMade: 2, attempts: 3 }),
      );

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'account_offboarding_purge_failed',
        expect.objectContaining({
          level: 'error',
          fingerprint: ['account_offboarding_purge_failed', 'terminal', OFFBOARDING_ID],
        }),
      );
    });

    it('the terminal and retry purge alerts never share a fingerprint', async () => {
      mockRedactionStage.mockImplementation(async () => {
        throw new Error('stripe connection error');
      });

      await expect(
        handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 })),
      ).rejects.toThrow('stripe connection error');
      await handleAccountOffboardingPurge(
        mockSql,
        mockSupabaseServer,
        makeJob({ attemptsMade: 2, attempts: 3 }),
      );

      const fingerprints = mockCaptureMessage.mock.calls.map(
        ([, context]) => (context as { fingerprint?: string[] } | undefined)?.fingerprint,
      );
      expect(fingerprints).toHaveLength(2);
      // Two absent fingerprints compare EQUAL, which is the #1016 defect itself;
      // assert presence so the inequality below cannot pass vacuously.
      expect(fingerprints.every((fingerprint) => Array.isArray(fingerprint))).toBe(true);
      expect(fingerprints[0]).not.toEqual(fingerprints[1]);
    });

    it("two offboardings' terminal alerts never share a fingerprint", async () => {
      // Sentry's action throttle is PER ISSUE. With one shared terminal issue a
      // second account's terminal failure inside the rule's 60-minute window
      // pages nobody — an unmet deletion obligation that no one is told about
      // (Codex A1). The offboarding id in the fingerprint is what separates them.
      const OTHER_OFFBOARDING_ID = '00000000-0000-7000-8000-0000000000f1';
      mockRedactionStage.mockImplementation(async () => {
        throw new Error('stripe connection error');
      });

      await handleAccountOffboardingPurge(
        mockSql,
        mockSupabaseServer,
        makeJob({ attemptsMade: 2, attempts: 3 }),
      );
      mockState.offboarding = { ...mockState.offboarding!, status: 'purge_scheduled' };
      await handleAccountOffboardingPurge(
        mockSql,
        mockSupabaseServer,
        makeJob({
          attemptsMade: 2,
          attempts: 3,
          accountOffboardingId: OTHER_OFFBOARDING_ID,
        }),
      );

      const fingerprints = mockCaptureMessage.mock.calls.map(
        ([, context]) => (context as { fingerprint?: string[] } | undefined)?.fingerprint,
      );
      expect(fingerprints).toEqual([
        ['account_offboarding_purge_failed', 'terminal', OFFBOARDING_ID],
        ['account_offboarding_purge_failed', 'terminal', OTHER_OFFBOARDING_ID],
      ]);
    });

    it('the terminal purge path marks the outbox failed and does not throw', async () => {
      // No double report: the terminal branch returns after the two marks, so
      // `attachJobFailureSink` never fires for it and this ONE capture is the
      // whole page. A throw here would add a second Sentry event for one failure.
      mockRedactionStage.mockImplementation(async () => {
        throw new Error('stripe connection error');
      });

      await expect(
        handleAccountOffboardingPurge(
          mockSql,
          mockSupabaseServer,
          makeJob({ attemptsMade: 2, attempts: 3 }),
        ),
      ).resolves.toBeUndefined();

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockSql,
        OUTBOX_ID,
        'stripe connection error',
        2,
      );
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
      expect(mockCaptureMessage).toHaveBeenCalledOnce();
      expect(mockCaptureMessage.mock.calls[0]![1]).toMatchObject({
        fingerprint: ['account_offboarding_purge_failed', 'terminal', OFFBOARDING_ID],
      });
    });

    it('the alerting runbook routes the terminal purge fingerprint the worker sends', () => {
      // A fingerprint nobody routes is worth nothing: before #1016 the signal
      // had no rule at all (red-team RT-05). Read off the exported constants
      // rather than hand-copied, because "the runbook and the worker agree" is
      // a claim about two artifacts and a copy only ever proves the copy.
      //
      // Every assertion is scoped to rule 16's own TABLE ROW — the cells the
      // operator copies into the Sentry form. A file-wide `toContain` passed
      // with that row corrupted to `terminal equals false` at `warning` on the
      // retry fingerprint (red-team RT-A6), because §1's bullet carries the
      // same strings. Patterns, not literals: the prose around each cell is
      // free to change, the configured VALUES are not.
      const block = rule16Block(readFileSync(join(process.cwd(), ALERTING_RUNBOOK), 'utf8'));
      const row = rule16TableRow(block);

      // Filter: the four facets that decide WHICH events reach Discord.
      expect(row).toMatch(/`terminal`\s+equals\s+`true`/);
      expect(row).not.toMatch(/`terminal`\s+equals\s+`false`/);
      expect(row).toMatch(/level\s+equals\s+`error`/);
      expect(row).toMatch(/`subsystem`\s+equals\s+`account_offboarding`/);
      expect(row).toMatch(/`step`\s+equals\s+`purge`/);

      // Grouping: the terminal fingerprint's constant members, then the
      // per-offboarding member that keeps one account's issue off another's.
      expect(row).toMatch(
        fingerprintPattern([...PURGE_TERMINAL_FINGERPRINT_PREFIX, '<account_offboarding_id>']),
      );
      // The retry spelling is pinned too — renaming it silently unmatches the
      // rule's own explanation of why the two arms are separate issues.
      expect(block).toMatch(fingerprintPattern(PURGE_RETRY_FINGERPRINT));

      // Trigger: first-seen is the RT-08 defect this whole rule exists to undo.
      expect(row).toMatch(/every event/i);
      expect(row).not.toMatch(/first[\s-]seen/i);
    });
  });

  // ── D5 INVERTED: the redaction stage runs FIRST ────────────────────────
  //
  // The original D5 put redaction immediately before the tombstone, arguing
  // that by then every local destruction had committed. That rationale was
  // FALSE — the tombstone is what scrubs local PII, and it runs after — so a
  // Stripe outage left a terminal half-purge holding live names, emails and
  // addresses. Owner-approved inversion, recorded as deviation D6.
  describe('Stripe Customer redaction ordering', () => {
    it('handleAccountOffboardingPurge runs the redaction stage before any local destruction and before runParentTombstonePurgeStage', async () => {
      // Still a SUBSEQUENCE assertion, not merely "before the tombstone" — the
      // dangerous direction is now redaction drifting LATER, back behind a
      // destructive stage, which a bare before-tombstone check would allow.
      await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob());

      expect(stageOrder).toEqual(['redaction', 'audit', 'tombstone']);
      // The worker passes a FACTORY, not a client. getStripe() throws when
      // STRIPE_SECRET_KEY is unset, so resolving it eagerly made every
      // delete_data purge depend on the key — including accounts that never
      // had a Stripe Customer at all. The stage calls it after its null check.
      expect(mockRedactionStage).toHaveBeenCalledWith(
        mockSql,
        expect.any(Function),
        expect.objectContaining({ id: OFFBOARDING_ID, stripe_customer_id: 'cus_123' }),
      );
    });

    it('handleAccountOffboardingPurge does not finalize the purge when the redaction stage throws a retryable error', async () => {
      // With redaction FIRST, a Stripe failure aborts having destroyed nothing.
      // That is the reordering's whole purpose: the old ordering left auth
      // deleted and content destroyed while local PII survived, terminally.
      mockRedactionStage.mockImplementation(async () => {
        stageOrder.push('redaction');
        throw new Error('stripe connection error');
      });

      await expect(
        handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob()),
      ).rejects.toThrow();

      // 'audit' absent is the observable proof that nothing local ran.
      expect(stageOrder).toEqual(['redaction']);
      expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    });
  });
});

function makeJob(
  overrides: {
    attemptsMade?: number;
    attempts?: number;
    accountOffboardingId?: string;
  } = {},
): Job<AccountOffboardingPurgePayload> {
  return {
    id: OUTBOX_ID,
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
    data: {
      account_offboarding_id: overrides.accountOffboardingId ?? OFFBOARDING_ID,
      account_id: ACCOUNT_ID,
      correlation_id: 'correlation-1',
      outbox_id: OUTBOX_ID,
      outbox_attempt: 2,
    },
  } as Job<AccountOffboardingPurgePayload>;
}
