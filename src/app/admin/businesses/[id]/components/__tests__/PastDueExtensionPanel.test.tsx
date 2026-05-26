// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PastDueExtensionPanel } from '../PastDueExtensionPanel';

describe('PastDueExtensionPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render for non-past-due accounts', () => {
    render(
      <PastDueExtensionPanel
        accountId="acct-1"
        subscriptionStatus="active"
        onGranted={() => {}}
      />,
    );

    expect(screen.queryByText('Grant past-due extension')).toBeNull();
  });

  it('submits a capped support extension for past-due accounts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        extension: { days: 3, expires_at: '2026-05-29T12:00:00.000Z' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const onGranted = vi.fn();

    render(
      <PastDueExtensionPanel
        accountId="11111111-1111-4111-8111-111111111111"
        subscriptionStatus="past_due"
        onGranted={onGranted}
      />,
    );

    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Ticket ID'), { target: { value: 'SUP-123' } });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Owner needs time to update card.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Grant extension' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/billing/grant-extension', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: '11111111-1111-4111-8111-111111111111',
        days: 3,
        ticketId: 'SUP-123',
        reason: 'Owner needs time to update card.',
      }),
    });
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Extension granted until May 29, 2026.')).toBeInTheDocument();
  });
});
