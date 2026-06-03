// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChannelsClient, type InitialEnrollment } from '../ChannelsClient';

// The owner Telegram/WhatsApp widgets fetch status on mount. Stub them so we
// can freely flip telegram/whatsapp availability and prove the SMS row never
// reacts to any flag state. (Same vi.mock-with-JSX pattern as SettingsClient.test.tsx.)
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

describe('ChannelsClient — SMS row', () => {
  it('renders SMS as an honest "coming soon" row', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: false, whatsapp: false }} />);

    const sms = channelRow('SMS');
    expect(within(sms).getByText('SMS notifications are coming soon')).toBeInTheDocument();
    expect(within(sms).getByText('Coming soon')).toBeInTheDocument();
    // Regression guard: the old flag-dependent roadmap jargon must be gone.
    expect(sms.textContent).not.toMatch(/follow-up phase|10DLC|owner widget/i);
  });

  it('keeps the SMS row identical when other channels become available', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: true, whatsapp: true }} />);

    // Other channels mount their interactive widgets…
    expect(screen.getByTestId('telegram-widget')).toBeInTheDocument();
    expect(screen.getByTestId('whatsapp-widget')).toBeInTheDocument();
    // …SMS is unchanged.
    const sms = channelRow('SMS');
    expect(within(sms).getByText('SMS notifications are coming soon')).toBeInTheDocument();
    expect(sms.textContent).not.toMatch(/follow-up phase|10DLC|owner widget/i);
  });

  it('shows the email row as Always on', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: false, whatsapp: false }} />);

    const email = channelRow('Email');
    expect(within(email).getByText('Always on')).toBeInTheDocument();
  });
});
