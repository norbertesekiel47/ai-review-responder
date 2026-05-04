import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// ── Hoisted mocks ──────────────────────────────────────────────────────
const {
  mockClaimDemo,
  mockCompleteDemo,
  mockFailDemo,
  mockGenerateDemo,
  mockMarkOutboxCompleted,
  mockResolvePlaceId,
  mockIsPlaceId,
  mockCreateWorkerLogger,
  loggerError,
  loggerLog,
  loggerWarn,
} = vi.hoisted(() => {
  const loggerError = vi.fn();
  const loggerLog = vi.fn();
  const loggerWarn = vi.fn();
  return {
    mockClaimDemo: vi.fn(),
    mockCompleteDemo: vi.fn(),
    mockFailDemo: vi.fn(),
    mockGenerateDemo: vi.fn(),
    mockMarkOutboxCompleted: vi.fn(),
    mockResolvePlaceId: vi.fn(),
    mockIsPlaceId: vi.fn(),
    mockCreateWorkerLogger: vi.fn(() => ({
      log: loggerLog,
      warn: loggerWarn,
      error: loggerError,
    })),
    loggerError,
    loggerLog,
    loggerWarn,
  };
});

vi.mock('../../src/lib/demos/lifecycle', () => ({
  claimDemo: mockClaimDemo,
  completeDemo: mockCompleteDemo,
  failDemo: mockFailDemo,
}));

vi.mock('../../src/lib/demos/generator', () => ({
  generateDemo: mockGenerateDemo,
}));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId:
      d && typeof d.outbox_id === 'string' ? d.outbox_id : fallback,
    attempt:
      d && typeof d.outbox_attempt === 'number'
        ? d.outbox_attempt
        : undefined,
  }),
}));

vi.mock('../../src/lib/shared/logger', () => ({
  createWorkerLogger: mockCreateWorkerLogger,
}));

vi.mock('../../src/lib/reviews/place-id-resolver', () => ({
  resolvePlaceId: mockResolvePlaceId,
}));

vi.mock('../../src/lib/reviews/url-parser', () => ({
  isPlaceId: mockIsPlaceId,
  parseGoogleMapsUrl: () => ({}),
}));

// Import the worker AFTER mocks are wired.
import { handleDemoGeneration } from '../jobs/DemoGenerationWorker';

function makeJob(): Job<{
  demoId: string;
  businessName: string;
  category: string;
  googlePlaceId: string;
  googleMapsUrl?: string;
  correlation_id: string;
}> {
  return {
    id: 'job-1',
    data: {
      demoId: 'demo-1',
      businessName: 'Test Cafe',
      category: 'cafe',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      correlation_id: 'corr-1',
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('handleDemoGeneration — diagnostic log path (L6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlaceId.mockReturnValue(true);
  });

  it('logs distinguishing message and re-throws when failDemo itself throws', async () => {
    // Setup: claim succeeds, generation fails, failDemo's tx fails.
    mockClaimDemo.mockResolvedValueOnce('claimed');
    const generationError = new Error('SerpAPI returned 500');
    mockGenerateDemo.mockRejectedValueOnce(generationError);
    const txError = new Error('PgBouncer disconnect');
    mockFailDemo.mockRejectedValueOnce(txError);

    await expect(handleDemoGeneration(makeJob())).rejects.toThrow(
      'PgBouncer disconnect',
    );

    // First error log: the original generation failure
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Demo demo-1 failed: SerpAPI returned 500'),
    );
    // Second error log: the failDemo tx failure with its OWN message —
    // the diagnostic that distinguishes "LLM failed" from "we couldn't
    // record that the LLM failed". This is the d678b55 fix.
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to record failure for demo demo-1: PgBouncer disconnect',
      ),
    );

    // failDemo was attempted exactly once (not retried inline)
    expect(mockFailDemo).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the diagnostic log on healthy failure paths', async () => {
    // Setup: claim succeeds, generation fails, failDemo's tx SUCCEEDS.
    mockClaimDemo.mockResolvedValueOnce('claimed');
    mockGenerateDemo.mockRejectedValueOnce(new Error('LLM timeout'));
    mockFailDemo.mockResolvedValueOnce(undefined);

    // Worker swallows the original error (does not re-throw to BullMQ — failure
    // is fully recorded in Postgres). No throw expected.
    await handleDemoGeneration(makeJob());

    // Original failure was logged
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Demo demo-1 failed: LLM timeout'),
    );
    // BUT the diagnostic 'Failed to record failure' log MUST NOT fire
    // when failDemo succeeds — that would be a noisy false positive.
    expect(loggerError).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to record failure for demo'),
    );
  });
});
