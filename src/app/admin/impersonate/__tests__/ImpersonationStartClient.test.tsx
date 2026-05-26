// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImpersonationStartClient } from '../ImpersonationStartClient';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

describe('ImpersonationStartClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts an impersonation session and navigates to the admin-owned view URL', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          sessionId: '44444444-4444-7444-8444-444444444444',
          viewUrl: '/admin/impersonate/44444444-4444-7444-8444-444444444444/view',
          expiresAt: '2026-05-26T13:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ImpersonationStartClient />);

    await user.type(
      screen.getByLabelText(/account id/i),
      '11111111-1111-4111-8111-111111111111',
    );
    await user.type(
      screen.getByLabelText(/owner user id/i),
      '33333333-3333-4333-8333-333333333333',
    );
    await user.type(screen.getByLabelText(/ticket id/i), ' SUP-123 ');
    await user.type(
      screen.getByLabelText(/reason/i),
      ' Diagnose support ticket with owner context. ',
    );
    await user.click(screen.getByRole('button', { name: /start view-as session/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/impersonation/start',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: '11111111-1111-4111-8111-111111111111',
            impersonatedUserId: '33333333-3333-4333-8333-333333333333',
            ticketId: 'SUP-123',
            reason: 'Diagnose support ticket with owner context.',
          }),
        }),
      );
    });
    expect(pushMock).toHaveBeenCalledWith(
      '/admin/impersonate/44444444-4444-7444-8444-444444444444/view',
    );
  });

  it('renders API errors without navigating', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'mfa_required' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    render(<ImpersonationStartClient />);

    await user.type(
      screen.getByLabelText(/account id/i),
      '11111111-1111-4111-8111-111111111111',
    );
    await user.type(
      screen.getByLabelText(/owner user id/i),
      '33333333-3333-4333-8333-333333333333',
    );
    await user.type(screen.getByLabelText(/ticket id/i), 'SUP-123');
    await user.type(screen.getByLabelText(/reason/i), 'Diagnose support ticket.');
    await user.click(screen.getByRole('button', { name: /start view-as session/i }));

    expect(await screen.findByText('mfa_required')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
