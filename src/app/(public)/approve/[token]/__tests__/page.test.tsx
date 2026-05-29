// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ApprovalPage, { metadata } from '../page';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

// Keep the unit test focused on page branching — render PageShell as a passthrough.
vi.mock('@/components/ui/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-shell">{children}</div>
  ),
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

    render(await ApprovalPage({ params: Promise.resolve({ token: 'raw-token' }) }));

    expect(
      screen.getByRole('heading', { level: 1, name: 'Review a draft response' }),
    ).toBeDefined();
    expect(screen.getByTestId('approval-client')).toBeInTheDocument();
  });

  it('is marked noindex (sensitive token-keyed data)', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it.each([
    ['missing link', [], /invalid or has expired/i],
    [
      'consumed link',
      [{ response_id: 'r', business_id: 'b', expires_at: new Date(Date.now() + 3_600_000), consumed_at: new Date(), revoked_at: null }],
      /already been approved/i,
    ],
    [
      'revoked link',
      [{ response_id: 'r', business_id: 'b', expires_at: new Date(Date.now() + 3_600_000), consumed_at: null, revoked_at: new Date() }],
      /has been revoked/i,
    ],
    [
      'expired link',
      [{ response_id: 'r', business_id: 'b', expires_at: new Date(Date.now() - 1_000), consumed_at: null, revoked_at: null }],
      /has expired/i,
    ],
  ])('renders a recovery path for a %s', async (_label, rows, messageRe) => {
    mockSql.mockResolvedValueOnce(rows);

    render(await ApprovalPage({ params: Promise.resolve({ token: 'raw-token' }) }));

    expect(screen.getByText(messageRe)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /dashboard/i }),
    ).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByTestId('approval-client')).not.toBeInTheDocument();
  });
});
