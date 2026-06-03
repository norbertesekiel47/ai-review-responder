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
});
