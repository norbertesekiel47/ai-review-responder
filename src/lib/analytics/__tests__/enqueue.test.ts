import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => ({ __jsonb: value }),
}));

vi.mock('uuid', () => ({
  v7: () => '018f0000-0000-7000-8000-000000000001',
}));

import { enqueueAnalyticsEvent } from '../enqueue';

describe('enqueueAnalyticsEvent', () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it('inserts analytics_events with sanitized properties and deterministic key', async () => {
    const tx = vi.fn(async () => undefined);

    await enqueueAnalyticsEvent(
      {
        eventName: 'first_response_drafted',
        eventKey: 'first_response_drafted:acct-1',
        distinctId: 'acct-1',
        accountId: 'acct-1',
        properties: { account_id: 'acct-1', response_text: 'drop me' },
      },
      tx as Parameters<typeof enqueueAnalyticsEvent>[1],
    );

    expect(mockSql).not.toHaveBeenCalled();
    expect(tx).toHaveBeenCalledTimes(1);

    const text = tx.mock.calls[0]![0].join(' ');
    expect(text).toContain('INSERT INTO analytics_events');
    expect(text).toContain('ON CONFLICT (event_key) DO NOTHING');
    expect(tx.mock.calls[0]).toContain('018f0000-0000-7000-8000-000000000001');
    expect(JSON.stringify(tx.mock.calls[0])).not.toContain('drop me');
  });
});
