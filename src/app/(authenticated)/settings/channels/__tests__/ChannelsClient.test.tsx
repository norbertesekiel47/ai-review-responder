// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { EnrollmentState } from '@/lib/notifications/channels/enrollment-reducer';
import {
  ChannelsClient,
  initialMobileChannelStates,
  otherChannelBlockedReason,
  type InitialEnrollment,
  type MobileChannelStates,
} from '../ChannelsClient';

// The owner Telegram/WhatsApp widgets fetch status on mount. Stub them with a
// shell that exposes the two S12 props so the cross-channel block can be
// asserted without network activity.
const { reporters } = vi.hoisted(() => ({
  reporters: {} as Record<string, ((state: EnrollmentState) => void) | undefined>,
}));

function WidgetStub({
  channel,
  blockedReason,
  onStateChange,
}: {
  channel: string;
  blockedReason?: string | null;
  onStateChange?: (state: EnrollmentState) => void;
}) {
  // Registered in an effect (not during render) so the harness can drive the
  // stub's onStateChange from the test body the way the real widget would.
  useEffect(() => {
    reporters[channel] = onStateChange;
  });
  return (
    <div data-testid={`${channel}-widget`}>
      <button type="button" disabled={Boolean(blockedReason)}>Connect</button>
      {blockedReason && <p>{blockedReason}</p>}
    </div>
  );
}

vi.mock('@/components/dashboard/channels/OwnerTelegramWidget', () => ({
  OwnerTelegramWidget: (props: { blockedReason?: string | null; onStateChange?: (s: EnrollmentState) => void }) => (
    <WidgetStub channel="telegram" {...props} />
  ),
}));
vi.mock('@/components/dashboard/channels/OwnerWhatsAppWidget', () => ({
  OwnerWhatsAppWidget: (props: { blockedReason?: string | null; onStateChange?: (s: EnrollmentState) => void }) => (
    <WidgetStub channel="whatsapp" {...props} />
  ),
}));

function enrollment(channel: InitialEnrollment['channel'], status = 'active', handle: string | null = null): InitialEnrollment {
  return {
    channel,
    handle,
    status,
    verified_at: null,
    disabled_at: null,
    unsubscribed_at: null,
    unsubscribed_reason: null,
    expires_at: null,
  };
}

const emailEnrollment = () => enrollment('email', 'active', 'owner@example.com');

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

  // S31: "Reconciling…" was internal vocabulary.
  it('says "Setting up…" (not "Reconciling…") while the email row has no server record yet', () => {
    render(
      <ChannelsClient
        initialEnrollments={[]}
        ownerEmailFallback="owner@example.com"
        initialAvailability={{ telegram: false, whatsapp: false }}
      />,
    );
    const email = channelRow('Email');
    expect(within(email).getByText('Setting up…')).toBeInTheDocument();
    expect(screen.queryByText(/reconciling/i)).toBeNull();
  });

  // S13: the section states its commit model.
  it('states that channel changes apply immediately', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: true, whatsapp: true }} />);
    expect(screen.getByText(/changes here apply immediately/i)).toBeInTheDocument();
  });
});

describe('ChannelsClient one-mobile-channel rule (S12)', () => {
  it('blocks WhatsApp Connect on first paint when Telegram is already verified', () => {
    render(
      <ChannelsClient
        initialEnrollments={[emailEnrollment(), enrollment('telegram', 'verified', '+44…123')]}
        ownerEmailFallback="owner@example.com"
        initialAvailability={{ telegram: true, whatsapp: true }}
      />,
    );

    const whatsapp = screen.getByTestId('whatsapp-widget');
    expect(within(whatsapp).getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(within(whatsapp).getByText(/disconnect telegram first/i)).toBeInTheDocument();

    const telegram = screen.getByTestId('telegram-widget');
    expect(within(telegram).getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('follows the live widget state: a Telegram setup in progress blocks WhatsApp, cancelling frees it', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: true, whatsapp: true }} />);
    const whatsapp = () => screen.getByTestId('whatsapp-widget');
    expect(within(whatsapp()).getByRole('button', { name: 'Connect' })).toBeEnabled();

    act(() => reporters.telegram?.('awaiting_scan'));
    expect(within(whatsapp()).getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(within(whatsapp()).getByText(/finish or cancel the telegram setup first/i)).toBeInTheDocument();

    act(() => reporters.telegram?.('idle'));
    expect(within(whatsapp()).getByRole('button', { name: 'Connect' })).toBeEnabled();
  });
});

describe('otherChannelBlockedReason', () => {
  const states = (telegram: EnrollmentState, whatsapp: EnrollmentState): MobileChannelStates => ({ telegram, whatsapp });

  it('is null when the sibling is idle, disabled, unsubscribed, expired, or errored', () => {
    for (const s of ['idle', 'disabled', 'unsubscribed', 'expired', 'error'] as const) {
      expect(otherChannelBlockedReason(states(s, 'idle'), 'whatsapp')).toBeNull();
    }
  });

  it('names the sibling and the reason for verified and in-progress states', () => {
    expect(otherChannelBlockedReason(states('verified', 'idle'), 'whatsapp')).toBe(
      'Disconnect Telegram first. You can have one mobile channel at a time.',
    );
    expect(otherChannelBlockedReason(states('idle', 'generating'), 'telegram')).toBe(
      'Finish or cancel the WhatsApp setup first. You can have one mobile channel at a time.',
    );
    expect(otherChannelBlockedReason(states('idle', 'awaiting_scan'), 'telegram')).toMatch(/whatsapp setup first/i);
  });

  it('seeds occupancy from SSR rows so the block applies before the widgets report', () => {
    expect(initialMobileChannelStates([emailEnrollment(), enrollment('whatsapp', 'verified')])).toEqual({
      telegram: 'idle',
      whatsapp: 'verified',
    });
    expect(initialMobileChannelStates([enrollment('telegram', 'pending_verification')])).toEqual({
      telegram: 'idle',
      whatsapp: 'idle',
    });
  });
});
