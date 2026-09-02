// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectGoogleBanner } from '@/components/dashboard/account-state/ConnectGoogleBanner';

describe('ConnectGoogleBanner', () => {
  it('renders the connect CTA when writable', () => {
    render(<ConnectGoogleBanner zernio={{
      status: 'none',
      queuedReconnectCount: 0,
      hasUnresolvedIncident: false,
    }} />);

    expect(screen.getByRole('link', { name: /^connect$/i })).toHaveAttribute('href', '/dashboard/connect');
    // UX audit D34: owner copy says "reply", never "response".
    expect(screen.getByText(/approved replies/i)).toBeInTheDocument();
    expect(screen.queryByText(/responses/i)).not.toBeInTheDocument();
  });

  it('hides connect CTA in read-only mode', () => {
    render(<ConnectGoogleBanner
      readOnly
      zernio={{
        status: 'none',
        queuedReconnectCount: 0,
        hasUnresolvedIncident: false,
      }}
    />);

    expect(screen.queryByRole('link', { name: /^connect$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/update billing to connect/i)).toBeInTheDocument();
  });

  it('hides reconnect CTA in read-only mode', () => {
    render(<ConnectGoogleBanner
      readOnly
      zernio={{
        status: 'disconnected',
        queuedReconnectCount: 1,
        hasUnresolvedIncident: false,
      }}
    />);

    expect(screen.queryByRole('link', { name: /^reconnect$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/update billing to connect/i)).toBeInTheDocument();
  });

  it('shows progress for a pending flow and the manual-review notice without a CTA', () => {
    const { rerender } = render(<ConnectGoogleBanner zernio={{
      status: 'pending',
      pendingFlow: { status: 'oauth_in_progress', started_at: 1_700_000_000_000 },
      queuedReconnectCount: 0,
      hasUnresolvedIncident: false,
    }} />);
    expect(screen.getByText(/connecting your google business/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view progress/i })).toHaveAttribute('href', '/dashboard/connect');

    rerender(<ConnectGoogleBanner zernio={{
      status: 'finalize_unknown',
      queuedReconnectCount: 0,
      hasUnresolvedIncident: false,
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/manual review/i);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders nothing once connected', () => {
    const { container } = render(<ConnectGoogleBanner zernio={{
      status: 'active',
      queuedReconnectCount: 0,
      hasUnresolvedIncident: false,
    }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
