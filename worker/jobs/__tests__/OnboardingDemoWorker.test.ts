import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import type { OnboardingDemoJobPayload } from '../OnboardingDemoWorker';

const {
  sqlReturnQueue,
  mockSql,
  mockClaimDemo,
  mockCompleteDemo,
  mockLogger,
  mockMarkOutboxCompleted,
  mockFinalizeCost,
  mockCheckCostThreshold,
  mockIsMockMode,
  mockBuildOnboardingDemoSource,
  mockResolveOnboardingDemoPlaceId,
  mockReleaseOnboardingDemoReservation,
  mockFailOnboardingDemoTerminal,
  mockExtractOutboxHandle,
  mockCaptureMessage,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql = vi.fn(() => Promise.resolve(sqlReturnQueue.shift() ?? []));

  return {
    sqlReturnQueue,
    mockSql,
    mockClaimDemo: vi.fn(),
    mockCompleteDemo: vi.fn(),
    mockLogger: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    mockMarkOutboxCompleted: vi.fn(),
    mockFinalizeCost: vi.fn(),
    mockCheckCostThreshold: vi.fn(),
    mockIsMockMode: vi.fn(),
    mockBuildOnboardingDemoSource: vi.fn(),
    mockResolveOnboardingDemoPlaceId: vi.fn(),
    mockReleaseOnboardingDemoReservation: vi.fn(),
    mockFailOnboardingDemoTerminal: vi.fn(),
    // Both of these were previously inline literals inside their vi.mock
    // factories, which made them unreachable from a test. They are now
    // addressable so a test can vary the outbox handle (#616 F3) and make a
    // Sentry capture throw (#616 F2). Their DEFAULT behavior is unchanged —
    // armed in beforeEach.
    mockExtractOutboxHandle: vi.fn(),
    mockCaptureMessage: vi.fn(),
  };
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../src/lib/demos/lifecycle', () => ({
  claimDemo: mockClaimDemo,
  completeDemo: mockCompleteDemo,
}));
vi.mock('../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));
vi.mock('../../../src/lib/shared/outbox', () => ({
  extractOutboxHandle: mockExtractOutboxHandle,
  markOutboxCompleted: mockMarkOutboxCompleted,
}));
vi.mock('../../../src/lib/costs/onboarding-demo-cost-guard', () => ({
  finalizeOnboardingDemoCost: mockFinalizeCost,
  checkCostThreshold: mockCheckCostThreshold,
}));
vi.mock('../../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));
vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
}));
vi.mock('../onboarding-demo/demo-source', () => ({
  buildOnboardingDemoSource: mockBuildOnboardingDemoSource,
}));
vi.mock('../onboarding-demo/place-resolution', () => ({
  resolveOnboardingDemoPlaceId: mockResolveOnboardingDemoPlaceId,
}));
vi.mock('../onboarding-demo/reservation', () => ({
  releaseOnboardingDemoReservation: mockReleaseOnboardingDemoReservation,
}));
vi.mock('../onboarding-demo/terminal', () => ({
  failOnboardingDemoTerminal: mockFailOnboardingDemoTerminal,
}));

/**
 * @types/node declares NODE_ENV as a required, read-only property, so a literal
 * `delete process.env.NODE_ENV` is a type error. A dynamic key routes through
 * ProcessEnv's index signature — same runtime effect.
 */
function unsetEnvVar(name: string): void {
  delete process.env[name];
}

function makeJob(): Job<OnboardingDemoJobPayload> {
  return {
    id: 'outbox-demo-1',
    data: {
      demoId: 'demo_123',
      googlePlaceId: 'place_123',
      businessName: 'RepWorth Cafe',
      cost_reservation_date: '2026-05-20',
    },
  } as Job<OnboardingDemoJobPayload>;
}

async function importWorker() {
  vi.resetModules();
  return await import('../OnboardingDemoWorker');
}

/**
 * The default behavior of the two mocks that used to be inline literals in
 * their vi.mock factories. `extractOutboxHandle` returning `attempt: undefined`
 * is byte-identical to what this file did before #616, so every pre-existing
 * test keeps its exact behavior; a test that needs a real dispatch attempt
 * overrides it with mockReturnValueOnce.
 */
function armSharedMockDefaults(): void {
  mockExtractOutboxHandle.mockImplementation((_data: unknown, fallback: string) => ({
    outboxId: fallback,
    attempt: undefined,
  }));
  mockCaptureMessage.mockImplementation(() => undefined);
}

/** The happy-path arrangement every success-path test starts from. */
function arrangeClaimedDemo(
  overrides: { totalCostUsd?: number; source?: string } = {},
): { reviews: unknown[]; responses: unknown[] } {
  const reviews = [{ id: 'r1' }, { id: 'r2' }];
  const responses = [{ responseText: 'thanks' }, null];
  sqlReturnQueue.push([{ subscription_status: SubscriptionStatus.PENDING_PAYMENT }]);
  mockClaimDemo.mockResolvedValue('claimed');
  mockResolveOnboardingDemoPlaceId.mockResolvedValue('place_resolved');
  mockBuildOnboardingDemoSource.mockResolvedValue({
    result: {
      reviews,
      responses,
      metadata: { totalCostUsd: overrides.totalCostUsd ?? 0.0342 },
    },
    source: overrides.source ?? 'serpapi',
  });
  return { reviews, responses };
}

describe('OnboardingDemoWorker', () => {
  // The mock-leak guard reads the deployment lane; snapshot the whole env so
  // NODE_ENV / RAILWAY_ENVIRONMENT_NAME edits cannot leak between tests or in
  // from the ambient shell.
  const originalEnv = process.env;

  beforeEach(() => {
    sqlReturnQueue.length = 0;
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MOCK_EXTERNAL_APIS = 'true';
    mockIsMockMode.mockReturnValue(false);
    mockReleaseOnboardingDemoReservation.mockResolvedValue(undefined);
    mockFinalizeCost.mockResolvedValue(undefined);
    mockCheckCostThreshold.mockResolvedValue({ crossed: [] });
    armSharedMockDefaults();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('exists and can be imported', { timeout: 15_000 }, async () => {
    const { handleOnboardingDemo } = await importWorker();
    expect(handleOnboardingDemo).toBeTypeOf('function');
  });

  it('the onboarding demo mock-leak guard throws on the production Railway lane when NODE_ENV is unset', async () => {
    // Production Railway leaves NODE_ENV unset, so the old
    // `NODE_ENV === 'production'` check never fired there and a mocked provider
    // could have served a real customer's demo.
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    unsetEnvVar('NODE_ENV');
    mockIsMockMode.mockReturnValue(true);

    const { handleOnboardingDemo } = await importWorker();

    await expect(handleOnboardingDemo(makeJob())).rejects.toThrow(/MOCK_EXTERNAL_APIS/);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('releases reservation when subscription-state failure recording throws', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    mockFailOnboardingDemoTerminal.mockRejectedValue(new Error('tx failed'));

    const { handleOnboardingDemo } = await importWorker();

    await expect(handleOnboardingDemo(makeJob())).rejects.toThrow('tx failed');

    expect(mockFailOnboardingDemoTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        demoId: 'demo_123',
        outboxId: 'outbox-demo-1',
        failureKind: 'subscription_state_changed',
      }),
    );
    expect(mockReleaseOnboardingDemoReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationDate: '2026-05-20',
        finalizeCost: mockFinalizeCost,
      }),
    );
  });

  it('releases reservation when generic failure recording throws', async () => {
    sqlReturnQueue.push([{ subscription_status: 'pending_payment' }]);
    mockClaimDemo.mockResolvedValue('claimed');
    mockResolveOnboardingDemoPlaceId.mockRejectedValue(new Error('place failed'));
    mockFailOnboardingDemoTerminal.mockRejectedValue(new Error('tx failed'));

    const { handleOnboardingDemo } = await importWorker();

    await expect(handleOnboardingDemo(makeJob())).rejects.toThrow('tx failed');

    expect(mockFailOnboardingDemoTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        demoId: 'demo_123',
        outboxId: 'outbox-demo-1',
        error: expect.any(Error),
      }),
    );
    expect(mockReleaseOnboardingDemoReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationDate: '2026-05-20',
        finalizeCost: mockFinalizeCost,
      }),
    );
  });

  // ── Characterization suite (#616) ────────────────────────────────────────
  //
  // These pin root behavior no test reached before, so the decomposition into
  // onboarding-demo/ helpers cannot move it. They pass against the
  // pre-refactor root — that is what a characterization test is.

  it('completes the demo, then finalizes rounded actual cents once, reports thresholds and logs completion', async () => {
    // 0.0355 USD = 3.55 cents. Deliberately ABOVE the half-cent: at 0.0342
    // (3.42c) Math.round and Math.floor agree, so that fixture cannot tell
    // the documented rounding contract from truncation. Red-team RT-001.
    const { reviews, responses } = arrangeClaimedDemo({ totalCostUsd: 0.0355 });

    // Hold BOTH awaited boundaries, one at a time. mock.invocationCallOrder
    // would prove only that each was CALLED after the previous was CALLED —
    // it survives dropping either `await`. Holding the promise is what proves
    // the boundary.
    //
    // The second boundary is not cosmetic ordering: checkCostThreshold READS
    // `cost:onboarding-demo:<date>`, the counter finalizeOnboardingDemoCost
    // decrements by `actual - 20c`. Run before the finalize, every demo
    // measures thresholds against the un-reconciled 20c reserve — about 17c
    // per demo too high, tripping the 50/90/100 alerts early. Red-team RT-002.
    let releaseCompleteDemo!: () => void;
    mockCompleteDemo.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseCompleteDemo = () => resolve();
      }),
    );
    let releaseFinalizeCost!: () => void;
    mockFinalizeCost.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseFinalizeCost = () => resolve();
      }),
    );
    let releaseCheckThreshold!: () => void;
    mockCheckCostThreshold.mockReturnValue(
      new Promise<{ crossed: number[] }>((resolve) => {
        releaseCheckThreshold = () => resolve({ crossed: [] });
      }),
    );

    const { handleOnboardingDemo } = await importWorker();
    const running = handleOnboardingDemo(makeJob());

    try {
      // Boundary 1: nothing downstream may run until completeDemo RESOLVES.
      await vi.waitFor(() => expect(mockCompleteDemo).toHaveBeenCalled());
      expect(mockFinalizeCost).not.toHaveBeenCalled();
      expect(mockCheckCostThreshold).not.toHaveBeenCalled();
      expect(mockLogger.log).not.toHaveBeenCalled();
      releaseCompleteDemo();

      // Boundary 2: the threshold report may not run until the finalize
      // RESOLVES, or it reads a counter that has not been reconciled.
      await vi.waitFor(() => expect(mockFinalizeCost).toHaveBeenCalled());
      expect(mockCheckCostThreshold).not.toHaveBeenCalled();
      expect(mockLogger.log).not.toHaveBeenCalled();
      releaseFinalizeCost();

      // Boundary 3: the completion line may not be logged until the threshold
      // report RESOLVES. All three awaits in the success path are now pinned;
      // leaving this one out let `await` -> `void` on the threshold report
      // survive the whole suite, which would ack the job with the Sentry
      // alert still in flight.
      await vi.waitFor(() => expect(mockCheckCostThreshold).toHaveBeenCalled());
      expect(mockLogger.log).not.toHaveBeenCalled();
    } finally {
      // Settle the handler even if an assertion above threw, so a failure
      // never leaves unfinished async work behind.
      releaseCompleteDemo();
      releaseFinalizeCost();
      releaseCheckThreshold();
      await running;
    }

    expect(mockCompleteDemo).toHaveBeenCalledWith(
      mockSql,
      'onboarding_demos',
      'demo_123',
      'outbox-demo-1',
      undefined,
      { reviews, responses, source: 'serpapi' },
    );
    // 3.55 cents ROUNDS to 4 — floor and trunc would book 3. It books against
    // the RESERVATION date from the payload, never today.
    // finalizeOnboardingDemoCost applies `actual - 20c` on every call, so a
    // second call would corrupt the daily counter.
    expect(mockFinalizeCost).toHaveBeenCalledTimes(1);
    expect(mockFinalizeCost).toHaveBeenCalledWith('2026-05-20', 4);
    expect(mockCheckCostThreshold).toHaveBeenCalledTimes(1);
    expect(mockLogger.log).toHaveBeenCalledWith(
      'Onboarding demo demo_123 completed (serpapi): 1/2 responses',
    );
    expect(mockFailOnboardingDemoTerminal).not.toHaveBeenCalled();
    expect(mockReleaseOnboardingDemoReservation).not.toHaveBeenCalled();
  });

  it('completes the outbox and releases exactly once for each terminal claim outcome', async () => {
    // All three share one branch in the root. Testing only one would let the
    // other two be dropped, and a double release would satisfy a
    // toHaveBeenCalledWith assertion — hence exact counts.
    for (const outcome of ['not_found', 'already_terminal', 'race_lost'] as const) {
      vi.clearAllMocks();
      sqlReturnQueue.length = 0;
      armSharedMockDefaults();
      mockReleaseOnboardingDemoReservation.mockResolvedValue(undefined);
      // A distinct outbox id and a NONZERO numeric attempt. The shared default
      // returns `attempt: undefined`, under which markOutboxCompleted's
      // arguments are indistinguishable from a dropped attempt — and the
      // repo asserts them nowhere else. D6 closed this hole on the failDemo
      // side and left its sibling open. Red-team / spec finding.
      mockExtractOutboxHandle.mockReturnValueOnce({
        outboxId: 'outbox_from_payload',
        attempt: 7,
      });
      sqlReturnQueue.push([{ subscription_status: SubscriptionStatus.PENDING_PAYMENT }]);
      mockClaimDemo.mockResolvedValue(outcome);

      const { handleOnboardingDemo } = await importWorker();
      await expect(handleOnboardingDemo(makeJob())).resolves.toBeUndefined();

      expect(mockMarkOutboxCompleted, outcome).toHaveBeenCalledTimes(1);
      // Dropping the attempt here lets a stale worker complete the outbox row
      // of a NEWER dispatch, and the no-op warning stays silent because the
      // attempt is undefined.
      expect(mockMarkOutboxCompleted, outcome).toHaveBeenCalledWith(
        mockSql,
        'outbox_from_payload',
        7,
      );
      expect(mockReleaseOnboardingDemoReservation, outcome).toHaveBeenCalledTimes(1);
      expect(mockFailOnboardingDemoTerminal, outcome).not.toHaveBeenCalled();
    }
  });

  it('throws without releasing the reservation when the claim resets a stale running demo', async () => {
    sqlReturnQueue.push([{ subscription_status: SubscriptionStatus.PENDING_PAYMENT }]);
    mockClaimDemo.mockResolvedValue('reset_to_queued');

    const { handleOnboardingDemo } = await importWorker();

    await expect(handleOnboardingDemo(makeJob())).rejects.toThrow(/reset from stale running/);
    // The negative assertion is the load-bearing half: the demo re-runs on the
    // SAME reserve, so releasing here would double-count the budget.
    expect(mockReleaseOnboardingDemoReservation).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('propagates a pre-work rejection without a terminal write or a release', async () => {
    // The subscription SELECT, claimDemo and markOutboxCompleted all sit
    // OUTSIDE the outer try, so a rejection from any of them escapes with no
    // terminal write and no release. That is existing behavior; widening the
    // catch during the refactor would silently change budget accounting and
    // retry semantics. All three boundaries, not just one.
    const boundaries: Array<{ name: string; arrange: () => void }> = [
      {
        name: 'subscription lookup',
        arrange: () => {
          mockSql.mockRejectedValueOnce(new Error('select failed'));
        },
      },
      {
        name: 'claimDemo',
        arrange: () => {
          sqlReturnQueue.push([{ subscription_status: SubscriptionStatus.PENDING_PAYMENT }]);
          mockClaimDemo.mockRejectedValue(new Error('claim failed'));
        },
      },
      {
        name: 'markOutboxCompleted',
        arrange: () => {
          sqlReturnQueue.push([{ subscription_status: SubscriptionStatus.PENDING_PAYMENT }]);
          mockClaimDemo.mockResolvedValue('race_lost');
          mockMarkOutboxCompleted.mockRejectedValue(new Error('outbox failed'));
        },
      },
    ];

    for (const boundary of boundaries) {
      vi.clearAllMocks();
      sqlReturnQueue.length = 0;
      armSharedMockDefaults();
      mockReleaseOnboardingDemoReservation.mockResolvedValue(undefined);
      boundary.arrange();

      const { handleOnboardingDemo } = await importWorker();
      await expect(handleOnboardingDemo(makeJob()), boundary.name).rejects.toThrow(/failed/);

      expect(mockFailOnboardingDemoTerminal, boundary.name).not.toHaveBeenCalled();
      expect(mockReleaseOnboardingDemoReservation, boundary.name).not.toHaveBeenCalled();
    }
  });

  it('keeps the demo completed when Sentry capture throws, and skips the remaining captures', async () => {
    arrangeClaimedDemo();
    mockCheckCostThreshold.mockResolvedValue({ crossed: [50, 90] });
    mockCaptureMessage.mockImplementation(() => {
      throw new Error('sentry down');
    });

    const { handleOnboardingDemo } = await importWorker();
    await expect(handleOnboardingDemo(makeJob())).resolves.toBeUndefined();

    // One try wraps BOTH the threshold lookup and the whole capture loop, so
    // the first throwing capture aborts the rest. Moving the catch inside the
    // loop would emit the second alert; moving the loop outside the try would
    // propagate into the terminal path AFTER the demo was completed.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Threshold check / Sentry capture failed for demo demo_123: sentry down',
    );
    expect(mockCompleteDemo).toHaveBeenCalled();
    expect(mockFailOnboardingDemoTerminal).not.toHaveBeenCalled();
    expect(mockReleaseOnboardingDemoReservation).not.toHaveBeenCalled();
  });

  it('releases exactly once when the generic terminal write fails', async () => {
    // The pre-existing "releases reservation when generic failure recording
    // throws" asserts toHaveBeenCalledWith, which a DOUBLE release also
    // satisfies. This pins the count without touching that test.
    //
    // It also pins the outer catch's outbox handle. That was the THIRD place
    // this branch had to close the same hole: every covering test used
    // `objectContaining` without the attempt, and the shared harness default
    // returns `attempt: undefined`, so dropping `outboxAttempt` here survived
    // all 38 tests. The guard path and the claim-lost path were each closed
    // one commit apart; this is the last of the three.
    mockExtractOutboxHandle.mockReturnValueOnce({
      outboxId: 'outbox_from_payload',
      attempt: 9,
    });
    sqlReturnQueue.push([{ subscription_status: SubscriptionStatus.PENDING_PAYMENT }]);
    mockClaimDemo.mockResolvedValue('claimed');
    mockResolveOnboardingDemoPlaceId.mockRejectedValue(new Error('place failed'));
    mockFailOnboardingDemoTerminal.mockRejectedValue(new Error('tx failed'));

    const { handleOnboardingDemo } = await importWorker();

    await expect(handleOnboardingDemo(makeJob())).rejects.toThrow('tx failed');
    expect(mockReleaseOnboardingDemoReservation).toHaveBeenCalledTimes(1);
    expect(mockFailOnboardingDemoTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxId: 'outbox_from_payload',
        // Without this, failDemo drops `AND attempts = $n` and a stale worker
        // can mark a newer dispatch failed.
        outboxAttempt: 9,
      }),
    );
  });

  it('forwards the extracted outbox id and numeric attempt through the subscription guard to the terminal write', async () => {
    // This runs the REAL guard: the worker test mocks
    // ../onboarding-demo/terminal but deliberately does NOT mock
    // ../onboarding-demo/subscription-guard, so the root-to-helper hop the
    // extraction created is itself under test. The helper's own test in
    // stages.test.ts starts AFTER this boundary, on parameters already handed
    // over, so it cannot see a rewire that forgets one.
    mockExtractOutboxHandle.mockReturnValueOnce({
      outboxId: 'outbox_from_payload',
      attempt: 4,
    });
    sqlReturnQueue.push([{ subscription_status: SubscriptionStatus.ACTIVE }]);
    mockFailOnboardingDemoTerminal.mockResolvedValue(undefined);

    const { handleOnboardingDemo } = await importWorker();
    await expect(handleOnboardingDemo(makeJob())).resolves.toBeUndefined();

    expect(mockFailOnboardingDemoTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxId: 'outbox_from_payload',
        // A dropped attempt makes failDemo omit `AND attempts = $n`, which is
        // what stops a stale worker failing a newer dispatch.
        outboxAttempt: 4,
        failureKind: 'subscription_state_changed',
      }),
    );
    expect(mockReleaseOnboardingDemoReservation).toHaveBeenCalledTimes(1);
  });
});
