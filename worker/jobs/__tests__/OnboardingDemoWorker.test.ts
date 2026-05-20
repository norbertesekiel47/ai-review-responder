import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
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
  extractOutboxHandle: (_data: unknown, fallback: string) => ({
    outboxId: fallback,
    attempt: undefined,
  }),
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
  captureMessage: vi.fn(),
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

describe('OnboardingDemoWorker', () => {
  beforeEach(() => {
    sqlReturnQueue.length = 0;
    vi.clearAllMocks();
    process.env.MOCK_EXTERNAL_APIS = 'true';
    mockIsMockMode.mockReturnValue(false);
    mockReleaseOnboardingDemoReservation.mockResolvedValue(undefined);
    mockFinalizeCost.mockResolvedValue(undefined);
    mockCheckCostThreshold.mockResolvedValue({ crossed: [] });
  });

  it('exists and can be imported', { timeout: 15_000 }, async () => {
    const { handleOnboardingDemo } = await importWorker();
    expect(handleOnboardingDemo).toBeTypeOf('function');
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
});
