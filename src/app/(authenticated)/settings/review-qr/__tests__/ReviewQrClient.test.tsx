// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ReviewQrClient } from '../ReviewQrClient';
import type { OwnerReviewQrLocation } from '@/lib/locations/review-qr';

const ELIGIBLE: OwnerReviewQrLocation = {
  businessId: '019db8c1-c3f4-7668-b353-2b8b718ec603',
  displayName: 'Acme',
  qrTargetUrl: 'https://app.example.com/q/019db8c1-c3f4-7668-b353-2b8b718ec603',
  qrDataUrl: 'data:image/png;base64,QQ==',
  ineligibleReason: null,
};

const INELIGIBLE: OwnerReviewQrLocation = {
  businessId: '019db8c1-c3f4-7668-b353-2b8b718ec604',
  displayName: 'Downtown',
  qrTargetUrl: 'https://app.example.com/q/019db8c1-c3f4-7668-b353-2b8b718ec604',
  qrDataUrl: null,
  ineligibleReason: 'bad_place_id',
};

describe('ReviewQrClient', () => {
  it('offers download and print only for eligible locations', () => {
    render(<ReviewQrClient locations={[ELIGIBLE, INELIGIBLE]} />);

    // Eligible card: QR preview + download anchor + print link.
    expect(
      screen.getByRole('img', { name: `Review QR for ${ELIGIBLE.displayName}` }),
    ).toBeInTheDocument();
    const download = screen.getByRole('link', { name: /download png/i });
    expect(download).toHaveAttribute('download', `review-qr-${ELIGIBLE.businessId}.png`);
    expect(download).toHaveAttribute('href', ELIGIBLE.qrDataUrl);
    const print = screen.getByRole('link', { name: /print/i });
    expect(print).toHaveAttribute('href', `/settings/review-qr/print/${ELIGIBLE.businessId}`);

    // Ineligible card: the explanatory copy, and NO QR, download, or print.
    expect(
      screen.getByText(
        'This location needs a canonical Google Place ID before it can have a review QR.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('img', { name: `Review QR for ${INELIGIBLE.displayName}` }),
    ).toBeNull();
    expect(screen.getAllByRole('link', { name: /download png/i })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /print/i })).toHaveLength(1);
  });

  it('shows one empty-state sentence pointing at the dashboard when there are no locations', () => {
    // Never /settings/locations — that route 404s when the multi-location
    // flag is off (adversarial R1 spec appendix).
    render(<ReviewQrClient locations={[]} />);
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.queryByRole('link', { name: /download png/i })).toBeNull();
  });
});
