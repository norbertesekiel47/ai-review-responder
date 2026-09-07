// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EnrollmentSnapshot } from '@/lib/notifications/channels/enrollment-reducer';

const { mockUseEnrollment, mockToast, actions } = vi.hoisted(() => ({
  mockUseEnrollment: vi.fn(),
  mockToast: vi.fn(),
  actions: {
    connect: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    dismissError: vi.fn(),
  },
}));

vi.mock('@/lib/notifications/channels/use-enrollment', () => ({
  useEnrollment: mockUseEnrollment,
}));
vi.mock('@/components/dashboard/shell/toast/ToastProvider', () => ({
  useToast: () => ({ toast: mockToast, dismiss: vi.fn() }),
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element -- test stub for next/image
  default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} />,
}));

import {
  OwnerMobileChannelWidget,
  type OwnerChannelPresentation,
} from '../OwnerMobileChannelWidget';
import { DISCONNECT_CONSEQUENCE } from '../OwnerMobileChannelWidget.helpers';

const PRESENTATION: OwnerChannelPresentation = {
  channel: 'telegram',
  label: 'Telegram',
  iconClass: 'ch-tg',
  iconGlyph: '💬',
  idleText: 'Get approval requests in Telegram.',
  unsubscribedText: 'You blocked the bot.',
  qrAlt: 'Telegram QR',
  openOnPhoneLabel: 'Open Telegram on this phone',
  endpoints: { start: '/s', cancel: '/c', disable: '/d', status: '/st' },
};

function snapshot(overrides: Partial<EnrollmentSnapshot>): EnrollmentSnapshot {
  return {
    state: 'idle',
    previousState: null,
    handle: null,
    deepLink: null,
    qrDataUrl: null,
    expiresAt: null,
    unsubscribedReason: null,
    errorMessage: null,
    ...overrides,
  };
}

function arrange(snap: EnrollmentSnapshot, secondsRemaining: number | null = null) {
  mockUseEnrollment.mockReturnValue({ snapshot: snap, actions, ttl: { secondsRemaining } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OwnerMobileChannelWidget disconnect (S11)', () => {
  it('confirms through SettingsModal with the consequence, never window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    arrange(snapshot({ state: 'verified', handle: '+447700900123' }));
    render(<OwnerMobileChannelWidget presentation={PRESENTATION} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(actions.disable).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Disconnect Telegram' });
    expect(dialog).toHaveTextContent(DISCONNECT_CONSEQUENCE);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Telegram' }));
    await waitFor(() => expect(actions.disable).toHaveBeenCalledTimes(1));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('"Keep connected" closes the dialog without disabling', () => {
    arrange(snapshot({ state: 'verified', handle: '+447700900123' }));
    render(<OwnerMobileChannelWidget presentation={PRESENTATION} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep connected' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(actions.disable).not.toHaveBeenCalled();
  });

  it('toasts the disconnect once the reducer lands on disabled', () => {
    arrange(snapshot({ state: 'verified', handle: '+447700900123' }));
    const { rerender } = render(<OwnerMobileChannelWidget presentation={PRESENTATION} />);

    arrange(snapshot({ state: 'disabled' }));
    rerender(<OwnerMobileChannelWidget presentation={PRESENTATION} />);

    expect(mockToast).toHaveBeenCalledWith({
      tone: 'success',
      title: 'Telegram disconnected',
      body: DISCONNECT_CONSEQUENCE,
    });
  });

  it('toasts the connection when a scan lands (awaiting_scan → verified)', () => {
    arrange(snapshot({ state: 'awaiting_scan', deepLink: 'tg://x', qrDataUrl: 'data:image/png;base64,QQ==' }));
    const { rerender } = render(<OwnerMobileChannelWidget presentation={PRESENTATION} />);

    arrange(snapshot({ state: 'verified', handle: '+447700900123' }));
    rerender(<OwnerMobileChannelWidget presentation={PRESENTATION} />);

    expect(mockToast).toHaveBeenCalledWith({ tone: 'success', title: 'Telegram connected' });
  });
});

describe('OwnerMobileChannelWidget sibling block (S12)', () => {
  it('disables Connect and explains inline when the other channel is taken', () => {
    arrange(snapshot({ state: 'idle' }));
    const reason = 'Disconnect WhatsApp first. You can have one mobile channel at a time.';
    render(<OwnerMobileChannelWidget presentation={PRESENTATION} blockedReason={reason} />);

    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();
    expect(connect).toHaveAccessibleDescription(reason);
    fireEvent.click(connect);
    expect(actions.connect).not.toHaveBeenCalled();
  });

  it('does not touch a connected row (a block only applies to connectable states)', () => {
    arrange(snapshot({ state: 'verified', handle: '+447700900123' }));
    render(<OwnerMobileChannelWidget presentation={PRESENTATION} blockedReason="irrelevant" />);

    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.queryByText('irrelevant')).toBeNull();
  });

  it('reports every enrollment state to the parent', () => {
    const onStateChange = vi.fn();
    arrange(snapshot({ state: 'idle' }));
    const { rerender } = render(
      <OwnerMobileChannelWidget presentation={PRESENTATION} onStateChange={onStateChange} />,
    );
    arrange(snapshot({ state: 'generating' }));
    rerender(<OwnerMobileChannelWidget presentation={PRESENTATION} onStateChange={onStateChange} />);

    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(['idle', 'generating']);
  });
});

describe('OwnerMobileChannelWidget QR panel (S31)', () => {
  it('renders the deep link as a labelled button, not a raw URL', () => {
    const deepLink = 'https://t.me/RepWorthBot?start=abcdef123456';
    arrange(
      snapshot({ state: 'awaiting_scan', deepLink, qrDataUrl: 'data:image/png;base64,QQ==', expiresAt: 1 }),
      125,
    );
    render(<OwnerMobileChannelWidget presentation={PRESENTATION} />);

    const open = screen.getByRole('link', { name: 'Open Telegram on this phone' });
    expect(open).toHaveAttribute('href', deepLink);
    expect(screen.queryByText(deepLink)).toBeNull();
    expect(screen.getByText('Expires in 2m 5s')).toBeInTheDocument();
  });
});
