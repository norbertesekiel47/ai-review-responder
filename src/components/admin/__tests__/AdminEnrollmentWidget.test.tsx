// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUseEnrollment, disableMock } = vi.hoisted(() => ({
  mockUseEnrollment: vi.fn(),
  disableMock: vi.fn(async () => {}),
}));
vi.mock('@/lib/notifications/channels/use-enrollment', () => ({
  useEnrollment: mockUseEnrollment,
}));

import { AdminEnrollmentWidget, type AdminEnrollmentPresentation } from '../AdminEnrollmentWidget';

const PRESENTATION: AdminEnrollmentPresentation = {
  channel: 'telegram',
  label: 'Telegram',
  containerClass: 'telegram-enrollment-widget',
  connectButtonClass: 'connect',
  linkClass: 'link',
  awaitingScanCopy: 'Scan the QR.',
  qrAlt: 'QR',
  verifiedLabel: 'Telegram chat',
  disableConfirm: 'Disable Telegram notifications for this business?',
  maskHandle: (handle) => handle ?? '•••',
};

function verifiedEnrollment() {
  return {
    snapshot: { state: 'verified', handle: '1234' },
    actions: {
      connect: vi.fn(),
      cancel: vi.fn(),
      disable: disableMock,
      refresh: vi.fn(),
      dismissError: vi.fn(),
    },
    ttl: { secondsRemaining: null },
  };
}

describe('AdminEnrollmentWidget — disable', () => {
  beforeEach(() => {
    disableMock.mockClear();
    mockUseEnrollment.mockReturnValue(verifiedEnrollment());
  });

  it('arms an inline confirm with the consequence instead of a native confirm()', async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    render(<AdminEnrollmentWidget presentation={PRESENTATION} businessId="biz-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));

    expect(screen.getByText('Disable Telegram notifications for this business?')).toBeInTheDocument();
    expect(screen.getByText(/stops receiving Telegram approval requests/)).toBeInTheDocument();
    expect(disableMock).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Disable Telegram' }));
    expect(disableMock).toHaveBeenCalledTimes(1);
  });

  it('Cancel disarms without disabling', async () => {
    render(<AdminEnrollmentWidget presentation={PRESENTATION} businessId="biz-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable Telegram' })).toBeNull();
    expect(disableMock).not.toHaveBeenCalled();
  });
});
