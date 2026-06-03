// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EnrollmentSnapshot } from '@/lib/notifications/channels/enrollment-reducer';

const useEnrollmentMock = vi.fn();
vi.mock('@/lib/notifications/channels/use-enrollment', () => ({
  useEnrollment: () => useEnrollmentMock(),
}));

import { OwnerWhatsAppWidget } from '@/components/dashboard/channels/OwnerWhatsAppWidget';

function snap(partial: Partial<EnrollmentSnapshot>): EnrollmentSnapshot {
  return {
    state: 'idle', previousState: null, handle: null, deepLink: null, qrDataUrl: null,
    expiresAt: null, unsubscribedReason: null, errorMessage: null, ...partial,
  } as EnrollmentSnapshot;
}
function mockHook(s: EnrollmentSnapshot) {
  useEnrollmentMock.mockReturnValue({
    snapshot: s,
    actions: { connect: vi.fn(), cancel: vi.fn(), disable: vi.fn(), refresh: vi.fn(), dismissError: vi.fn() },
    ttl: { secondsRemaining: null },
  });
}

describe('OwnerWhatsAppWidget', () => {
  it('renders Connect in idle', () => {
    mockHook(snap({ state: 'idle' }));
    render(<OwnerWhatsAppWidget />);
    expect(screen.getByRole('button', { name: /connect/i })).toBeTruthy();
  });

  it('renders the QR in awaiting_scan', () => {
    mockHook(snap({ state: 'awaiting_scan', qrDataUrl: 'data:image/png;base64,X', deepLink: 'https://wa.me/1?text=start-t' }));
    render(<OwnerWhatsAppWidget />);
    expect(screen.getByAltText(/whatsapp qr/i)).toBeTruthy();
  });

  it('renders the generic conflict message verbatim on error (copy lock)', () => {
    mockHook(snap({ state: 'error', errorMessage: 'Disconnect your current channel before connecting another.' }));
    render(<OwnerWhatsAppWidget />);
    expect(screen.getByText('Disconnect your current channel before connecting another.')).toBeTruthy();
  });
});
