// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImpersonationBanner } from '../ImpersonationBanner';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('ImpersonationBanner', () => {
  it('names the session, the account, the UTC end time, and offers End (X25)', () => {
    render(
      <ImpersonationBanner
        adminAppUrl="https://admin.example.com"
        impersonation={{
          sessionId: 'sess-1',
          expiresAt: '2026-09-02T12:45:00.000Z',
          accountLabel: 'Bella Italia',
        }}
      />,
    );

    const banner = screen.getByRole('status', { name: 'View-as session active' });
    expect(banner).toHaveTextContent('View-as session active');
    expect(banner).toHaveTextContent('Bella Italia');
    expect(screen.getByText('12:45:00 UTC')).toHaveAttribute('dateTime', '2026-09-02T12:45:00.000Z');
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
    // Sticky + filled red: the one alarm surface in the shell, and it must not scroll away.
    expect(banner.className).toContain('sticky');
    expect(banner.className).toContain('bg-red-700');
  });
});
