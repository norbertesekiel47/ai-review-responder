// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ApprovalPage from '../page';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('@/components/approval/approval-client', () => ({
  default: ({ token }: { token: string }) => (
    <div data-testid="approval-client">approval client {token}</div>
  ),
}));

describe('ApprovalPage', () => {
  it('renders a real h1 heading for the approval page shell', async () => {
    mockSql.mockResolvedValueOnce([
      {
        response_id: 'resp-1',
        business_id: 'biz-1',
        expires_at: new Date(Date.now() + 3_600_000),
        consumed_at: null,
        revoked_at: null,
      },
    ]);

    render(await ApprovalPage({ params: { token: 'raw-token' } }));

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Review a draft response',
      }),
    ).toBeDefined();
  });
});
