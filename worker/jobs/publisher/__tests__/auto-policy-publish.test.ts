import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioReplyAlreadyExistsError,
  ZernioTransientError,
} from '../../../../src/lib/zernio/errors';

const mocks = vi.hoisted(() => ({
  runtimeEnabled: vi.fn(() => true),
  checkSubscription: vi.fn(() => ({ allowed: true })),
  markOwned: vi.fn(async () => true),
  veto: vi.fn(async () => 'proceed'),
  held: vi.fn(async () => false),
  judge: vi.fn(async () => 'post'),
  downgrade: vi.fn(async () => 'downgraded'),
  resolveTarget: vi.fn(),
  publishReply: vi.fn(),
  verifyReply: vi.fn(),
  verify409: vi.fn(),
  markPosted: vi.fn(),
  recoverTruth: vi.fn(),
  parkReconnect: vi.fn(),
  openReviewNotFound: vi.fn(),
  authTerminal: vi.fn(),
  permanentTerminal: vi.fn(),
  activation: vi.fn(),
  revokeOpenLinks: vi.fn(),
}));

vi.mock('../../../../src/lib/auto-approval/flags', () => ({
  autoApprovalRuntimeEnabled: mocks.runtimeEnabled,
}));
vi.mock('../../../../src/lib/shared/subscription-guard', () => ({
  checkSubscription: mocks.checkSubscription,
}));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompletedIfOwned: mocks.markOwned,
}));
vi.mock('../../../../src/lib/approval/locks', () => ({
  revokeOpenLinksForResponse: mocks.revokeOpenLinks,
}));
vi.mock('../../../../src/lib/publishing/review-publisher', () => ({
  getTransactionalReviewPublisher: () => ({
    resolveTarget: mocks.resolveTarget,
    publishReply: mocks.publishReply,
    findReply: vi.fn(),
    deleteReply: vi.fn(),
  }),
}));
vi.mock('../veto-window-gate', () => ({
  enforceElapsedVetoWindowInTx: mocks.veto,
}));
vi.mock('../held-flag-gate', () => ({
  isHeldForModerationReviewInTx: mocks.held,
}));
vi.mock('../judge-gate', () => ({
  applyJudgeGateInTx: mocks.judge,
}));
vi.mock('../auto-policy-downgrade', () => ({
  downgradeAutoApprovedResponseForManualReviewInTx: mocks.downgrade,
}));
vi.mock('../mark-posted', () => ({
  markPostedAndMaybeEnqueueAutoPostNotice: mocks.markPosted,
  recoverAutoPolicyProviderTruth: mocks.recoverTruth,
}));
vi.mock('../no-connection', () => ({
  parkResponseForOwnerReconnectInTx: mocks.parkReconnect,
}));
vi.mock('../review-lookup', () => ({
  openReviewNotFoundExceptionInTx: mocks.openReviewNotFound,
}));
vi.mock('../publisher-error-handlers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../publisher-error-handlers')>();
  return {
    ...actual,
    handlePublisherAuthErrorTerminalInTx: mocks.authTerminal,
    handlePublisherPermanentErrorTerminalInTx: mocks.permanentTerminal,
    verify409InTx: mocks.verify409,
  };
});
vi.mock('../verify-posted', () => ({ verifyOwnReplyAttached: mocks.verifyReply }));
vi.mock('../activation', () => ({ maybeCaptureActivationCompleted: mocks.activation }));

import { publishAutoPolicyResponse } from '../auto-policy-publish';

const target = {
  ref: { responseId: 'response-1', reviewId: 'review-1', businessId: 'business-1' },
  locator: { accountId: 'provider-account', locationId: 'provider-location', providerReviewId: 'provider-review' },
};

interface HarnessState {
  markerPhase: 'none' | 'armed' | 'possible';
  markerLocator: typeof target.locator;
  attempt: number;
  armedCount: number;
  possibleCount: number;
  tier: 'copilot' | 'autopilot';
  status: string;
  archived: boolean;
  offboardingBlocked: boolean;
  responseStatus: string;
  approvalMethod: string | null;
  approvedText: string | null;
  suspended: boolean;
  onArm?: () => void;
  onPossible?: () => void;
}

function createHarness(overrides: Partial<HarnessState> = {}) {
  const state: HarnessState = {
    markerPhase: 'none',
    markerLocator: target.locator,
    attempt: 2,
    armedCount: 0,
    possibleCount: 0,
    tier: 'autopilot',
    status: 'active',
    archived: false,
    offboardingBlocked: false,
    responseStatus: 'approved',
    approvalMethod: 'auto_policy',
    approvedText: 'Approved reply',
    suspended: false,
    ...overrides,
  };
  const calls: string[] = [];
  const sql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.from(strings).join('?').replace(/\s+/g, ' ').trim();
    calls.push(text);
    if (/FROM reviews/.test(text)) return Promise.resolve([{ id: 'review-1' }]);
    if (/FROM account_offboardings/.test(text)) {
      if (!state.offboardingBlocked) return Promise.resolve([]);
      return Promise.resolve([{
        id: 'offboarding-1',
        account_id: 'account-1',
        mode: 'delete_data',
        status: 'tearing_down',
        failed_step: null,
        terminal_at: null,
        access_ends_at: null,
        teardown_started_at: new Date('2026-07-15T00:00:00Z'),
        purge_after: null,
        purge_started_at: null,
        purge_cancelled_at: null,
      }]);
    }
    if (/FROM businesses/.test(text)) {
      return Promise.resolve([{
        id: 'business-1',
        account_id: 'account-1',
        archived_at: state.archived ? new Date('2026-07-15T00:00:00Z') : null,
      }]);
    }
    if (/FROM responses/.test(text)) {
      return Promise.resolve([{
        id: 'response-1',
        status: state.responseStatus,
        approval_method: state.approvalMethod,
        approved_text: state.approvedText,
      }]);
    }
    if (/pg_advisory_xact_lock/.test(text)) return Promise.resolve([]);
    if (/FROM accounts/.test(text)) {
      return Promise.resolve([{
        subscription_status: state.status,
        subscription_tier: state.tier,
        past_due_at: null,
        flags: {},
        autonomy_suspended: state.suspended,
      }]);
    }
    if (/FROM job_outbox/.test(text) && /FOR UPDATE/.test(text)) {
      const requestedAttempt = values.at(-1);
      if (typeof requestedAttempt === 'number' && requestedAttempt !== state.attempt) {
        return Promise.resolve([]);
      }
      return Promise.resolve([{
        phase: state.markerPhase === 'none' ? null : state.markerPhase,
        provider_account_id: state.markerPhase === 'possible'
          ? state.markerLocator.accountId
          : null,
        provider_location_id: state.markerPhase === 'possible'
          ? state.markerLocator.locationId
          : null,
        provider_review_id: state.markerPhase === 'possible'
          ? state.markerLocator.providerReviewId
          : null,
      }]);
    }
    if (/UPDATE job_outbox/.test(text) && /SET payload/.test(text)) {
      const payload = values.find(
        (value) => value && typeof value === 'object' && PROVIDER_MARKER in value,
      ) as Record<string, { phase: 'armed' | 'possible' }> | undefined;
      const phase = payload?.[PROVIDER_MARKER]?.phase;
      if (phase === 'possible') {
        if (state.markerPhase !== 'armed') {
          return Promise.resolve(Object.assign([], { count: 0 }));
        }
        state.markerPhase = 'possible';
        state.possibleCount += 1;
        state.onPossible?.();
      } else {
        state.markerPhase = 'armed';
        state.armedCount += 1;
        state.onArm?.();
      }
      return Promise.resolve(Object.assign([], { count: 1 }));
    }
    if (/FROM approval_audit_log/.test(text)) {
      return Promise.resolve([{
        response_text_at_approval: 'Approved reply',
        approved_at: new Date('2026-07-15T00:00:00Z'),
      }]);
    }
    if (/UPDATE responses/.test(text) && /superseded/.test(text)) {
      return Promise.resolve(Object.assign([], { count: 1 }));
    }
    throw new Error(`Unexpected SQL in auto-policy harness: ${text}`);
  });
  sql.begin = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    // Emulate the one durable payload field this harness mutates. A callback
    // throw rolls marker writes back in real Postgres; without this restoration
    // a broken "reset possible -> armed, then throw inside tx" implementation
    // would look committed and make the resolver-error regression vacuous.
    const markerBefore = state.markerPhase;
    const locatorBefore = { ...state.markerLocator };
    try {
      return await callback(sql);
    } catch (error) {
      state.markerPhase = markerBefore;
      state.markerLocator = locatorBefore;
      throw error;
    }
  });
  sql.json = vi.fn((value: unknown) => value);
  return { sql: sql as Sql, state, calls };
}

const PROVIDER_MARKER = '_auto_policy_provider_attempt';

function input(overrides: Record<string, unknown> = {}) {
  return {
    responseId: 'response-1',
    reviewId: 'review-1',
    businessId: 'business-1',
    accountId: 'account-1',
    approvedText: 'Approved reply',
    outboxId: 'outbox-1',
    outboxAttempt: 2,
    correlationId: 'corr-1',
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTarget.mockReset();
  mocks.publishReply.mockReset();
  mocks.verifyReply.mockReset();
  mocks.verify409.mockReset();
  mocks.markOwned.mockReset();
  mocks.markPosted.mockReset();
  mocks.recoverTruth.mockReset();
  mocks.runtimeEnabled.mockReturnValue(true);
  mocks.checkSubscription.mockReturnValue({ allowed: true });
  mocks.markOwned.mockResolvedValue(true);
  mocks.veto.mockResolvedValue('proceed');
  mocks.held.mockResolvedValue(false);
  mocks.judge.mockResolvedValue('post');
  mocks.resolveTarget.mockResolvedValue({ kind: 'resolved', target });
  mocks.publishReply.mockResolvedValue(undefined);
  mocks.verifyReply.mockResolvedValue(undefined);
  mocks.verify409.mockResolvedValue({ disposition: 'matches_our_text', verifierText: 'Approved reply' });
  mocks.markPosted.mockResolvedValue({ transitioned: true, fyiEnqueued: true });
  mocks.recoverTruth.mockResolvedValue({ transitioned: true, fyiEnqueued: true });
});

describe('auto-policy provider lane', () => {
  it('ignores a stale Copilot hint and posts from authoritative Autopilot state in the same attempt', async () => {
    const harness = createHarness({ tier: 'autopilot' });
    await publishAutoPolicyResponse(harness.sql, input());

    expect(harness.state.armedCount).toBe(1);
    expect(mocks.resolveTarget).toHaveBeenCalledTimes(2);
    expect(mocks.publishReply).toHaveBeenCalledWith(target.locator, 'Approved reply');
    expect(mocks.markPosted).toHaveBeenCalledTimes(1);
    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
    expect(mocks.downgrade).not.toHaveBeenCalled();
    expectFullThreePhaseTrace(harness);
    expect(mocks.markOwned.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publishReply.mock.invocationCallOrder[0]!,
    );
  });

  it('downgrades authoritative Copilot before arming or any external call', async () => {
    const harness = createHarness({ tier: 'copilot' });
    await publishAutoPolicyResponse(harness.sql, input());

    expect(harness.state.armedCount).toBe(0);
    expect(mocks.downgrade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'autopilot_entitlement_lost' }),
    );
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expectTrace(harness, PHASE_TRACE);
    expect((harness.sql as any).begin).toHaveBeenCalledTimes(1);
  });

  it('rechecks phase-two archive state and performs no provider call', async () => {
    const harness = createHarness({ onArm: () => { harness.state.archived = true; } });
    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expectTrace(harness, [...PHASE_TRACE, 'arm', ...PHASE_TRACE]);
    expect((harness.sql as any).begin).toHaveBeenCalledTimes(2);
  });

  it('CAS loss after preparation performs zero provider call and zero mutation', async () => {
    const harness = createHarness();
    mocks.markOwned.mockResolvedValue(false);
    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.resolveTarget).toHaveBeenCalledTimes(2);
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expect(mocks.parkReconnect).not.toHaveBeenCalled();
    expect(mocks.openReviewNotFound).not.toHaveBeenCalled();
    expect(mocks.markPosted).not.toHaveBeenCalled();
    expectFullThreePhaseTrace(harness);
  });

  it.each([
    ['no_connection', mocks.parkReconnect],
    ['review_not_found', mocks.openReviewNotFound],
  ] as const)('claims before the %s terminal mutation', async (kind, terminal) => {
    const harness = createHarness();
    mocks.resolveTarget.mockResolvedValue(
      kind === 'review_not_found'
        ? { kind, meta: { reason: 'missing' } }
        : { kind },
    );

    await publishAutoPolicyResponse(harness.sql, input());
    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expectTrace(harness, [...PHASE_TRACE, 'arm', ...PHASE_TRACE]);
    expect((harness.sql as any).begin).toHaveBeenCalledTimes(2);
    expect(mocks.markOwned.mock.invocationCallOrder[0]).toBeLessThan(
      terminal.mock.invocationCallOrder[0]!,
    );
  });

  it('claims before auth terminal mutation', async () => {
    const harness = createHarness();
    mocks.publishReply.mockRejectedValue(new ZernioAuthError(401, 'unauthorized'));
    await publishAutoPolicyResponse(harness.sql, input());
    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
    expect(mocks.authTerminal).toHaveBeenCalledTimes(1);
    expectFullThreePhaseTrace(harness);
    expect(mocks.markOwned.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.authTerminal.mock.invocationCallOrder[0]!,
    );
  });

  it('claims before permanent terminal mutation', async () => {
    const harness = createHarness();
    mocks.publishReply.mockRejectedValue(new ZernioPermanentError('http_400', { status: 400 }));
    await publishAutoPolicyResponse(harness.sql, input());
    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
    expect(mocks.permanentTerminal).toHaveBeenCalledTimes(1);
    expectFullThreePhaseTrace(harness);
    expect(mocks.markOwned.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.permanentTerminal.mock.invocationCallOrder[0]!,
    );
  });

  it('rolls back domain disposition on transient provider failure while retaining the payload marker', async () => {
    const harness = createHarness();
    mocks.publishReply.mockRejectedValue(new ZernioTransientError('http_503', { status: 503 }));
    await expect(publishAutoPolicyResponse(harness.sql, input())).rejects.toMatchObject({
      name: 'PublisherTransientWithContext',
    });
    expect(harness.state.markerPhase).toBe('possible');
    expect(mocks.authTerminal).not.toHaveBeenCalled();
    expect(mocks.permanentTerminal).not.toHaveBeenCalled();
    expect(mocks.markPosted).not.toHaveBeenCalled();
    expectFullThreePhaseTrace(harness);
  });

  it('crash after armed commit leaves no possible marker and retry safely resumes posting', async () => {
    const harness = createHarness();
    const begin = (harness.sql as any).begin;
    begin
      .mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => callback(harness.sql))
      .mockRejectedValueOnce(new Error('process crashed after arm commit'));

    await expect(publishAutoPolicyResponse(harness.sql, input())).rejects.toThrow(
      'process crashed after arm commit',
    );
    expect(harness.state.markerPhase).toBe('armed');
    expect(harness.state.possibleCount).toBe(0);
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();

    harness.calls.length = 0;
    await publishAutoPolicyResponse(harness.sql, input());

    expect(harness.state.markerPhase).toBe('possible');
    expect(mocks.resolveTarget).toHaveBeenCalledTimes(2);
    expect(mocks.publishReply).toHaveBeenCalledTimes(1);
    expectTrace(harness, [
      ...PHASE_TRACE,
      ...PHASE_TRACE,
      'possible',
      ...FINAL_PHASE_TRACE,
    ]);
  });

  it('target-resolution transient leaves armed and retry can cleanly downgrade', async () => {
    const harness = createHarness();
    mocks.resolveTarget.mockResolvedValueOnce({
      kind: 'transient',
      accountId: 'provider-account',
      locationId: 'provider-location',
      error: new ZernioTransientError('http_503', { status: 503 }),
    });

    await expect(publishAutoPolicyResponse(harness.sql, input())).rejects.toMatchObject({
      name: 'PublisherTransientWithContext',
    });
    expect(harness.state.markerPhase).toBe('armed');
    expect(harness.state.possibleCount).toBe(0);
    expect(mocks.publishReply).not.toHaveBeenCalled();

    harness.state.tier = 'copilot';
    await publishAutoPolicyResponse(harness.sql, input());
    expect(mocks.downgrade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'autopilot_entitlement_lost' }),
    );
    expect(mocks.publishReply).not.toHaveBeenCalled();
  });

  it('armed retry honors current blocking offboarding before target resolution', async () => {
    const harness = createHarness({
      markerPhase: 'armed',
      offboardingBlocked: true,
    });

    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expectTrace(harness, PHASE_TRACE);
    expect((harness.sql as any).begin).toHaveBeenCalledTimes(1);
  });

  it('rechecks offboarding after final target resolution and makes zero provider calls', async () => {
    const harness = createHarness();
    mocks.resolveTarget
      .mockResolvedValueOnce({ kind: 'resolved', target })
      .mockImplementationOnce(async () => {
        harness.state.offboardingBlocked = true;
        return { kind: 'resolved', target };
      });

    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.resolveTarget).toHaveBeenCalledTimes(2);
    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expect(mocks.markPosted).not.toHaveBeenCalled();
  });

  it('final-phase disconnect performs zero stale-target provider calls', async () => {
    const harness = createHarness();
    mocks.resolveTarget
      .mockResolvedValueOnce({ kind: 'resolved', target })
      .mockResolvedValueOnce({ kind: 'no_connection' });

    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.resolveTarget).toHaveBeenCalledTimes(2);
    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
    expect(mocks.parkReconnect).toHaveBeenCalledTimes(1);
    expect(mocks.publishReply).not.toHaveBeenCalled();
  });

  it('final-phase locator change resets to armed and retries without posting stale target', async () => {
    const harness = createHarness();
    const changedTarget = {
      ...target,
      locator: {
        accountId: 'provider-account-2',
        locationId: 'provider-location-2',
        providerReviewId: 'provider-review-2',
      },
    };
    mocks.resolveTarget
      .mockResolvedValueOnce({ kind: 'resolved', target })
      .mockResolvedValueOnce({ kind: 'resolved', target: changedTarget });

    await expect(publishAutoPolicyResponse(harness.sql, input())).rejects.toMatchObject({
      name: 'PublisherTransientWithContext',
    });

    expect(harness.state.markerPhase).toBe('armed');
    expect(mocks.resolveTarget).toHaveBeenCalledTimes(2);
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expect(mocks.markPosted).not.toHaveBeenCalled();
    expect(mocks.markOwned).not.toHaveBeenCalled();
  });

  it('same-attempt observer of another invocation possible marker reconciles instead of fresh-posting', async () => {
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness({
      onArm: () => {
        // Deterministic stalled-overlap: invocation A won armed -> possible
        // after this invocation's initial phase but before its preparation
        // phase. The old locator may already have received A's provider call.
        harness.state.markerPhase = 'possible';
        harness.state.markerLocator = target.locator;
      },
    });
    mocks.verify409.mockResolvedValue({
      disposition: 'matches_our_text',
      verifierText: 'Approved reply',
    });

    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.verify409).toHaveBeenCalledTimes(1);
    expect(mocks.recoverTruth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
  });

  it.each([
    new ZernioAuthError(401, 'resolver unauthorized'),
    new ZernioPermanentError('resolver_bad_request', { status: 400 }),
    new Error('resolver unknown failure'),
  ])('final resolver throw resets possible to armed before propagating %s', async (error) => {
    const harness = createHarness();
    mocks.resolveTarget
      .mockResolvedValueOnce({ kind: 'resolved', target })
      .mockRejectedValueOnce(error);

    await expect(publishAutoPolicyResponse(harness.sql, input())).rejects.toBe(error);

    expect(harness.state.markerPhase).toBe('armed');
    expect(mocks.resolveTarget).toHaveBeenCalledTimes(2);
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expect(mocks.markPosted).not.toHaveBeenCalled();
    expect(mocks.markOwned).not.toHaveBeenCalled();
  });

  it('reconciles a possible 2xx success before a later tier loss and marks the matching reply posted', async () => {
    const harness = createHarness();
    mocks.verifyReply.mockRejectedValueOnce(new ZernioTransientError('verify_failed', {}));
    await expect(publishAutoPolicyResponse(harness.sql, input())).rejects.toBeInstanceOf(Error);
    expect(harness.state.markerPhase).toBe('possible');

    harness.state.tier = 'copilot';
    harness.state.attempt = 3;
    mocks.publishReply.mockClear();
    mocks.markOwned.mockClear();
    await publishAutoPolicyResponse(harness.sql, input({ outboxAttempt: 3 }));

    expect(mocks.verify409).toHaveBeenCalledTimes(1);
    expect(mocks.recoverTruth).toHaveBeenCalledTimes(1);
    expect(mocks.downgrade).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expectTrace(
      { ...harness, calls: harness.calls.slice(-RECOVERY_TRACE.length) },
      RECOVERY_TRACE,
    );
  });

  it('matching provider truth repairs an intervening owner veto from durable approval audit text', async () => {
    const harness = createHarness();
    mocks.verifyReply.mockRejectedValueOnce(new ZernioTransientError('verify_failed', {}));
    await expect(publishAutoPolicyResponse(harness.sql, input())).rejects.toBeInstanceOf(Error);

    harness.state.attempt = 3;
    harness.state.responseStatus = 'pending_approval';
    harness.state.approvalMethod = null;
    harness.state.approvedText = null;
    mocks.publishReply.mockClear();
    mocks.markOwned.mockClear();
    await publishAutoPolicyResponse(harness.sql, input({
      outboxAttempt: 3,
      approvedText: 'stale payload must not win',
    }));

    expect(mocks.recoverTruth).toHaveBeenCalledWith(expect.objectContaining({
      approvedText: 'Approved reply',
      approvedAt: new Date('2026-07-15T00:00:00Z'),
    }));
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expect(mocks.downgrade).not.toHaveBeenCalled();
  });

  it('does not downgrade an ambiguous prior attempt when provider reply truth is absent', async () => {
    const harness = createHarness({ markerPhase: 'possible', tier: 'copilot' });
    mocks.verify409.mockResolvedValue({
      disposition: 'indeterminate',
      reason: 'review_found_but_reply_null',
      meta: {},
    });
    await expect(publishAutoPolicyResponse(harness.sql, input())).rejects.toMatchObject({
      name: 'ZernioReplyVerificationIndeterminateError',
    });
    expect(mocks.downgrade).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expect(mocks.recoverTruth).not.toHaveBeenCalled();
    expectTrace(harness, RECOVERY_TRACE);
  });

  it('provider-truth mismatch after an owner veto supersedes and clears every actionable seam', async () => {
    const harness = createHarness({
      markerPhase: 'possible',
      responseStatus: 'pending_approval',
      approvalMethod: null,
      approvedText: null,
    });
    mocks.verify409.mockResolvedValue({ disposition: 'mismatch', verifierText: 'External reply' });

    await publishAutoPolicyResponse(harness.sql, input());

    const supersede = harness.calls.find((text) => /UPDATE responses/.test(text));
    expect(supersede).toContain("status = 'superseded'");
    expect(supersede).toContain('approval_method = NULL');
    expect(supersede).toContain('approved_text = NULL');
    expect(supersede).toContain('approved_at = NULL');
    expect(supersede).toContain('auto_post_scheduled_at = NULL');
    expect(mocks.revokeOpenLinks).toHaveBeenCalledWith(expect.anything(), 'response-1');
    expect(mocks.recoverTruth).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expectTrace(harness, [...RECOVERY_TRACE, 'supersede']);
  });

  it('stores ambiguity in JSONB payload so last_error overwrite and redispatch cannot erase it', async () => {
    const harness = createHarness();
    mocks.publishReply.mockRejectedValue(new ZernioTransientError('http_503', {}));
    await expect(publishAutoPolicyResponse(harness.sql, input())).rejects.toBeInstanceOf(Error);

    const armSql = harness.calls.find((text) => /UPDATE job_outbox/.test(text));
    expect(armSql).toMatch(/SET payload/);
    expect(armSql).not.toMatch(/last_error/);
    expect(harness.state.markerPhase).toBe('possible');

    mocks.publishReply.mockReset();
    mocks.verify409.mockResolvedValue({ disposition: 'matches_our_text', verifierText: 'Approved reply' });
    harness.state.attempt = 3;
    await publishAutoPolicyResponse(harness.sql, input({ outboxAttempt: 3 }));
    expect(harness.state.armedCount).toBe(1);
    expect(mocks.verify409).toHaveBeenCalledTimes(1);
    expectTrace(
      { ...harness, calls: harness.calls.slice(-RECOVERY_TRACE.length) },
      RECOVERY_TRACE,
    );
  });

  it.each([
    ['matches_our_text', 'posted'],
    ['mismatch', 'superseded'],
    ['auth', 'auth'],
    ['permanent', 'permanent'],
  ] as const)('fresh 409 %s is CAS-owned before its terminal disposition', async (disposition, outcome) => {
    const harness = createHarness();
    mocks.publishReply.mockRejectedValue(
      new ZernioReplyAlreadyExistsError({ message: 'already exists' }),
    );
    if (disposition === 'matches_our_text' || disposition === 'mismatch') {
      mocks.verify409.mockResolvedValue({ disposition, verifierText: disposition === 'mismatch' ? 'Other' : 'Approved reply' });
    } else if (disposition === 'auth') {
      mocks.verify409.mockResolvedValue({
        disposition,
        lookupErr: new ZernioAuthError(401, 'unauthorized'),
      });
    } else {
      mocks.verify409.mockResolvedValue({
        disposition,
        lookupErr: new ZernioPermanentError('http_400', { status: 400 }),
      });
    }

    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
    expect(mocks.markOwned.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.verify409.mock.invocationCallOrder[0]!,
    );
    if (outcome === 'posted') expect(mocks.markPosted).toHaveBeenCalledTimes(1);
    if (outcome === 'superseded') {
      expect(mocks.revokeOpenLinks).toHaveBeenCalledWith(
        expect.anything(),
        'response-1',
      );
      const supersede = harness.calls.find((text) => /UPDATE responses/.test(text));
      expect(supersede).toContain('approval_method = NULL');
      expect(supersede).toContain('approved_text = NULL');
      expect(supersede).toContain('approved_at = NULL');
      expect(supersede).toContain('auto_post_scheduled_at = NULL');
    }
    if (outcome === 'auth') expect(mocks.authTerminal).toHaveBeenCalledTimes(1);
    if (outcome === 'permanent') expect(mocks.permanentTerminal).toHaveBeenCalledTimes(1);
    expectTrace(
      harness,
      outcome === 'superseded' ? [...FULL_TRACE, 'supersede'] : FULL_TRACE,
    );
  });

  it('takes the binding review-business-response-entitlement order in all phases', async () => {
    const harness = createHarness();
    await publishAutoPolicyResponse(harness.sql, input());
    const anchors = harness.calls.filter((text) =>
      /FROM reviews|FROM businesses|FROM responses|pg_advisory_xact_lock/.test(text),
    );
    expect(anchors).toHaveLength(12);
    expect(anchors.slice(0, 4).map(classifyAnchor)).toEqual([
      'review', 'business', 'response', 'entitlement',
    ]);
    expect(anchors.slice(4, 8).map(classifyAnchor)).toEqual([
      'review', 'business', 'response', 'entitlement',
    ]);
    expect(anchors.slice(8, 12).map(classifyAnchor)).toEqual([
      'review', 'business', 'response', 'entitlement',
    ]);
    expectFullThreePhaseTrace(harness);
  });
});

describe('code-review regression fixes (2026-07-16)', () => {
  it('reconcile-path auth revocation lands terminally instead of retry-looping', async () => {
    const harness = createHarness({ markerPhase: 'possible' });
    mocks.verify409.mockResolvedValue({
      disposition: 'auth',
      lookupErr: new ZernioAuthError(401, 'token revoked'),
    });

    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.authTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.permanentTerminal).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expect(mocks.markOwned).toHaveBeenCalledTimes(1);
  });

  it('reconcile-path permanent 4xx lands terminally instead of retry-looping', async () => {
    const harness = createHarness({ markerPhase: 'possible' });
    mocks.verify409.mockResolvedValue({
      disposition: 'permanent',
      lookupErr: new ZernioPermanentError('verify_bad_request', { status: 400 }),
    });

    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.permanentTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.authTerminal).not.toHaveBeenCalled();
    expect(mocks.publishReply).not.toHaveBeenCalled();
  });

  it('downgrades instead of posting when account autonomy is suspended at publish time', async () => {
    const harness = createHarness({ suspended: true });

    await publishAutoPolicyResponse(harness.sql, input());

    expect(mocks.downgrade).toHaveBeenCalledTimes(1);
    expect(mocks.downgrade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'policy_suspended' }),
    );
    expect(mocks.publishReply).not.toHaveBeenCalled();
    expect(mocks.markPosted).not.toHaveBeenCalled();
  });
});

const LOCK_TRACE = [
  'review',
  'business',
  'response',
  'entitlement',
  'account',
  'outbox',
] as const;
const PHASE_TRACE = [...LOCK_TRACE, 'offboarding'] as const;
const FINAL_PHASE_TRACE = [...PHASE_TRACE, 'offboarding'] as const;
const FULL_TRACE = [
  ...PHASE_TRACE,
  'arm',
  ...PHASE_TRACE,
  'possible',
  ...FINAL_PHASE_TRACE,
] as const;
const RECOVERY_TRACE = [...LOCK_TRACE, 'audit'] as const;

function expectFullThreePhaseTrace(harness: ReturnType<typeof createHarness>): void {
  expectTrace(harness, FULL_TRACE);
  expect((harness.sql as any).begin).toHaveBeenCalledTimes(3);
}

function expectTrace(
  harness: Pick<ReturnType<typeof createHarness>, 'calls'>,
  expected: readonly string[],
): void {
  expect(harness.calls).toHaveLength(expected.length);
  expect(harness.calls.map(classifySql)).toEqual(expected);
}

function classifySql(text: string): string {
  if (/UPDATE job_outbox/.test(text) && /phase' = 'armed/.test(text)) return 'possible';
  if (/UPDATE job_outbox/.test(text)) return 'arm';
  if (/FROM job_outbox/.test(text)) return 'outbox';
  if (/FROM approval_audit_log/.test(text)) return 'audit';
  if (/FROM account_offboardings/.test(text)) return 'offboarding';
  if (/FROM accounts/.test(text)) return 'account';
  if (/UPDATE responses/.test(text) && /superseded/.test(text)) return 'supersede';
  return classifyAnchor(text);
}

function classifyAnchor(text: string): string {
  if (/FROM reviews/.test(text)) return 'review';
  if (/FROM businesses/.test(text)) return 'business';
  if (/FROM responses/.test(text)) return 'response';
  return 'entitlement';
}

// ── The gate chain: one row per gate, each denied ALONE ──────────────────
//
// Invariant #3 ("no unapproved posting") is enforced by a CHAIN, not by any
// one check, and every collaborator in this file is pinned to its ALLOW value
// in `beforeEach` above. Nothing here ever overrode one — so until this table
// existed, deleting `evaluateRuntimeGate`, `evaluateVetoGate`,
// `evaluateModerationGate`, the judge verdict, or the `approval_method`
// conjunct of `isPublishableAutoPolicy` left all 32 tests in this file green
// (Pathfinder 2026-08-15 guard-integrity census, group A).
//
// The table is deliberately ONE suite over the production array rather than
// five hand-written tests: five tests are five chances to repeat the root
// cause. `pins every LOCKED_GATE_CHECKS entry` below re-reads the array from
// source, so an eighth gate lands red until it gets a row here.
//
// Each row denies EXACTLY ONE gate against an otherwise fully-allowing lane
// and asserts the same universal property: the lane terminates inside the
// FIRST transaction, arms nothing, and makes zero provider calls.
interface GateDenialCase {
  /** Production symbol this row denies. Array members must match by name/order. */
  gate: string;
  /** `false` for the two gates that live outside LOCKED_GATE_CHECKS. */
  inArray: boolean;
  /** Flips exactly one collaborator/state field to its DENY value. */
  deny: (harness: ReturnType<typeof createHarness>) => void;
  /** SQL the locked lane is allowed to issue before it terminates. */
  trace: readonly string[];
  /** The terminal disposition this specific gate owns. */
  assert: () => void;
}

const GATE_DENIALS: readonly GateDenialCase[] = [
  {
    // Outside the array: the publishable-state predicate that guards it.
    // The only pre-existing tests touching non-publishable state mutate
    // `responseStatus` AND `approvalMethod` together, so the status half
    // masked the method half. Here the status stays publishable.
    gate: 'isPublishableAutoPolicy.approval_method',
    inArray: false,
    deny: (harness) => { harness.state.approvalMethod = 'owner'; },
    trace: LOCK_TRACE,
    assert: () => {
      expect(mocks.markOwned).toHaveBeenCalledTimes(1);
      expect(mocks.downgrade).not.toHaveBeenCalled();
      // Not one gate may be consulted for a row that is not auto-policy.
      expect(mocks.veto).not.toHaveBeenCalled();
      expect(mocks.held).not.toHaveBeenCalled();
      expect(mocks.judge).not.toHaveBeenCalled();
    },
  },
  {
    gate: 'evaluateOffboardingGate',
    inArray: true,
    deny: (harness) => { harness.state.offboardingBlocked = true; },
    trace: PHASE_TRACE,
    assert: () => {
      expect(mocks.markOwned).toHaveBeenCalledTimes(1);
      expect(mocks.downgrade).not.toHaveBeenCalled();
    },
  },
  {
    gate: 'evaluateRuntimeGate',
    inArray: true,
    deny: () => { mocks.runtimeEnabled.mockReturnValue(false); },
    trace: PHASE_TRACE,
    assert: () => expectDowngrade('auto_approval_disabled'),
  },
  {
    gate: 'evaluateVetoGate',
    inArray: true,
    deny: () => { mocks.veto.mockResolvedValue('downgrade'); },
    trace: PHASE_TRACE,
    assert: () => expectDowngrade('notice_undelivered'),
  },
  {
    gate: 'evaluateArchivedGate',
    inArray: true,
    deny: (harness) => { harness.state.archived = true; },
    trace: PHASE_TRACE,
    assert: () => {
      expect(mocks.markOwned).toHaveBeenCalledTimes(1);
      expect(mocks.downgrade).not.toHaveBeenCalled();
    },
  },
  {
    // The tier conjunct has its own test above ('downgrades authoritative
    // Copilot…'); this row denies the SUBSCRIPTION conjunct of the same gate.
    gate: 'evaluateEntitlementGate',
    inArray: true,
    deny: () => { mocks.checkSubscription.mockReturnValue({ allowed: false }); },
    trace: PHASE_TRACE,
    assert: () => expectDowngrade('autopilot_entitlement_lost'),
  },
  {
    gate: 'evaluatePolicySuspensionGate',
    inArray: true,
    deny: (harness) => { harness.state.suspended = true; },
    trace: PHASE_TRACE,
    assert: () => expectDowngrade('policy_suspended'),
  },
  {
    // Invariant #4 on the publish path: moderation is an absolute veto.
    gate: 'evaluateModerationGate',
    inArray: true,
    deny: () => { mocks.held.mockResolvedValue(true); },
    trace: PHASE_TRACE,
    assert: () => {
      expect(mocks.markOwned).toHaveBeenCalledTimes(1);
      expect(mocks.downgrade).not.toHaveBeenCalled();
    },
  },
  {
    // Outside the array, and the sharpest of the five: CLAUDE.md invariant #3
    // makes judge availability a POSTING PRECONDITION. The real gate owns its
    // own downgrade + outbox completion, so neither is expected here.
    gate: 'applyJudgeGateInTx',
    inArray: false,
    deny: () => { mocks.judge.mockResolvedValue('downgraded'); },
    trace: PHASE_TRACE,
    assert: () => {
      expect(mocks.judge).toHaveBeenCalledTimes(1);
      expect(mocks.downgrade).not.toHaveBeenCalled();
      expect(mocks.markOwned).not.toHaveBeenCalled();
    },
  },
];

function expectDowngrade(reason: string): void {
  expect(mocks.downgrade).toHaveBeenCalledTimes(1);
  expect(mocks.downgrade).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ reason }),
  );
  // The downgrade helper owns outbox completion in the same tx.
  expect(mocks.markOwned).not.toHaveBeenCalled();
}

describe('auto-policy gate chain — each gate denies the lane on its own', () => {
  it.each(GATE_DENIALS.map((gateCase) => [gateCase.gate, gateCase] as const))(
    '%s alone terminates the lane with zero provider work',
    async (_name, gateCase) => {
      const harness = createHarness();
      gateCase.deny(harness);

      await publishAutoPolicyResponse(harness.sql, input());

      // Universal property — this is what invariant #3 actually claims.
      expect(mocks.resolveTarget).not.toHaveBeenCalled();
      expect(mocks.publishReply).not.toHaveBeenCalled();
      expect(mocks.verify409).not.toHaveBeenCalled();
      expect(mocks.markPosted).not.toHaveBeenCalled();
      expect(mocks.recoverTruth).not.toHaveBeenCalled();
      // Nothing was armed, so no retry can resume into a provider call either.
      expect(harness.state.armedCount).toBe(0);
      expect(harness.state.possibleCount).toBe(0);
      expect(harness.state.markerPhase).toBe('none');
      // Terminated inside the FIRST transaction — no preparation, no publish.
      expectTrace(harness, gateCase.trace);
      expect((harness.sql as unknown as { begin: ReturnType<typeof vi.fn> }).begin)
        .toHaveBeenCalledTimes(1);

      gateCase.assert();
    },
  );

  it('pins every LOCKED_GATE_CHECKS entry, in order', () => {
    // Read the production array rather than importing it: `auto-policy-publish.ts`
    // exports only its entry points, and a new gate must not be able to ship
    // without a denial row above.
    const source = readFileSync(
      fileURLToPath(new URL('../auto-policy-publish.ts', import.meta.url)),
      'utf8',
    );
    const arrayBody = /const LOCKED_GATE_CHECKS:[^=]*=\s*\[([\s\S]*?)\];/.exec(source)?.[1];
    expect(arrayBody, 'LOCKED_GATE_CHECKS array literal not found').toBeDefined();

    const declared = arrayBody!
      .split(',')
      .map((entry) => entry.replace(/\/\/.*$/gm, '').trim())
      .filter((entry) => entry.length > 0);

    expect(declared).toEqual(
      GATE_DENIALS.filter((gateCase) => gateCase.inArray).map((gateCase) => gateCase.gate),
    );
  });
});
