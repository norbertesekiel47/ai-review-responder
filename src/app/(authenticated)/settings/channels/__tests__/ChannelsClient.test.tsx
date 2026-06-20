// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChannelsClient, type InitialEnrollment } from '../ChannelsClient';

// The owner Telegram/WhatsApp widgets fetch status on mount. Stub them so we
// can freely flip telegram/whatsapp availability without network activity.
vi.mock('@/components/dashboard/channels/OwnerTelegramWidget', () => ({
  OwnerTelegramWidget: () => <div data-testid="telegram-widget" />,
}));
vi.mock('@/components/dashboard/channels/OwnerWhatsAppWidget', () => ({
  OwnerWhatsAppWidget: () => <div data-testid="whatsapp-widget" />,
}));

function emailEnrollment(): InitialEnrollment {
  return {
    channel: 'email',
    handle: 'owner@example.com',
    status: 'active',
    verified_at: null,
    disabled_at: null,
    unsubscribed_at: null,
    unsubscribed_reason: null,
    expires_at: null,
  };
}

const baseProps = {
  initialEnrollments: [emailEnrollment()],
  ownerEmailFallback: 'owner@example.com',
};

// Find a channel row by its visible name. Throws a clear error (rather than a
// confusing null-deref later) if the `.channel-row` ancestor structure changes.
function channelRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest('.channel-row');
  if (!row) throw new Error(`channel row for "${name}" not found (.channel-row ancestor missing)`);
  return row as HTMLElement;
}

describe('ChannelsClient', () => {
  it('does not render an SMS row (channel removed)', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: false, whatsapp: false }} />);
    expect(screen.queryByText('SMS')).toBeNull();
    expect(screen.queryByText('SMS notifications are coming soon')).toBeNull();
  });

  it('does not render an SMS row when other channels become available', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: true, whatsapp: true }} />);
    expect(screen.getByTestId('telegram-widget')).toBeInTheDocument();
    expect(screen.getByTestId('whatsapp-widget')).toBeInTheDocument();
    expect(screen.queryByText('SMS')).toBeNull();
  });

  it('shows the email row as Always on', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: false, whatsapp: false }} />);

    const email = channelRow('Email');
    expect(within(email).getByText('Always on')).toBeInTheDocument();
  });
});
