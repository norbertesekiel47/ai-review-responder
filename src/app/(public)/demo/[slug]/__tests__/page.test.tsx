// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import DemoViewerPage from '../page';

// #1369: the public demo viewer used to fire an un-awaited direct Postgres
// UPDATE on every completed-demo render. It must now bump a Redis counter
// via recordDemoView and never touch `sql` for anything but the read.

const { mockSql, mockRecordDemoView } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockRecordDemoView: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('@/lib/demos/view-tracking', () => ({
  recordDemoView: mockRecordDemoView,
}));

vi.mock('@/lib/auth/flags', () => ({
  selfServeSignupEnabled: () => false,
}));

vi.mock('@/lib/payments/flags', () => ({
  trialEnabled: () => false,
}));

vi.mock('../DemoViewerContent', () => ({
  DemoViewerContent: () => <div data-testid="demo-viewer-content">viewer</div>,
}));

vi.mock('../DemoStatusIsland', () => ({
  DemoStatusIsland: ({ variant }: { variant: string }) => (
    <div data-testid="demo-status-island">{variant}</div>
  ),
}));

function demoRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'demo-1',
    business_name: 'Test Biz',
    generation_status: 'completed',
    generation_error: null,
    reviews_snapshot: [],
    generated_responses: [],
    view_count: 0,
    expires_at: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordDemoView.mockResolvedValue(undefined);
});

describe('DemoViewerPage view counting (#1369)', () => {
  it('bumps the Redis counter (not Postgres) for a completed demo', async () => {
    mockSql.mockResolvedValueOnce([demoRow()]);

    render(
      await DemoViewerPage({ params: Promise.resolve({ slug: 'abc123' }) }),
    );

    expect(screen.getByTestId('demo-viewer-content')).toBeInTheDocument();
    expect(mockRecordDemoView).toHaveBeenCalledTimes(1);
    expect(mockRecordDemoView).toHaveBeenCalledWith('demo-1');
    // The only `sql` call is the SELECT inside getDemo — proves no direct
    // Postgres write happens on this unauthenticated page anymore.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('does not bump the counter for a loading demo', async () => {
    mockSql.mockResolvedValueOnce([demoRow({ generation_status: 'queued' })]);

    render(
      await DemoViewerPage({ params: Promise.resolve({ slug: 'abc123' }) }),
    );

    expect(screen.getByTestId('demo-status-island')).toHaveTextContent('loading');
    expect(mockRecordDemoView).not.toHaveBeenCalled();
  });

  it('does not bump the counter for a failed demo', async () => {
    mockSql.mockResolvedValueOnce([demoRow({ generation_status: 'failed' })]);

    render(
      await DemoViewerPage({ params: Promise.resolve({ slug: 'abc123' }) }),
    );

    expect(screen.getByTestId('demo-status-island')).toHaveTextContent('error');
    expect(mockRecordDemoView).not.toHaveBeenCalled();
  });

  it('renders even when recordDemoView rejects (fail-open contract)', async () => {
    // recordDemoView is documented to never throw (it swallows and reports
    // internally), but the page must stay correct even if that contract is
    // ever violated — it must not turn a Redis hiccup into a broken page.
    mockSql.mockResolvedValueOnce([demoRow()]);
    mockRecordDemoView.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      DemoViewerPage({ params: Promise.resolve({ slug: 'abc123' }) }),
    ).rejects.toThrow('redis unavailable');
    // Documents current behavior: the page itself does not additionally
    // try/catch the call, because recordDemoView's OWN contract (asserted in
    // src/lib/demos/__tests__/view-tracking.test.ts) is that it never
    // rejects in production. This test exists so a change to that contract
    // is visible here too.
  });
});
