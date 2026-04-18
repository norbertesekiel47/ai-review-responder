import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverCorrelationId } from '../correlation';

type TaggedTemplate = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
  mock: { calls: unknown[][] };
};

function createMockTx(results: unknown[][]): TaggedTemplate {
  let i = 0;
  const fn = vi.fn(async () => {
    const row = results[i++] ?? [];
    return row;
  }) as unknown as TaggedTemplate;
  return fn;
}

describe('recoverCorrelationId', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the correlation_id from the most recent generate_response outbox row for the review', async () => {
    const tx = createMockTx([[{ correlation_id: 'upstream-abc' }]]);
    const result = await recoverCorrelationId(tx as any, { reviewId: 'rev-1', responseId: 'resp-1' });
    expect(result).toBe('upstream-abc');
  });

  it('falls back to responseId when no upstream outbox row exists', async () => {
    const tx = createMockTx([[]]);
    const result = await recoverCorrelationId(tx as any, { reviewId: 'rev-1', responseId: 'resp-1' });
    expect(result).toBe('resp-1');
  });

  it('falls back to responseId when the upstream row has no correlation_id (pre-20a data)', async () => {
    const tx = createMockTx([[{ correlation_id: null }]]);
    const result = await recoverCorrelationId(tx as any, { reviewId: 'rev-1', responseId: 'resp-1' });
    expect(result).toBe('resp-1');
  });
});
