// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ReviewQrClient, reviewQrFileName } from '../ReviewQrClient';
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

    // Eligible card: QR preview + download anchor (named after the location,
    // S33) + print link.
    expect(
      screen.getByRole('img', { name: `Review QR for ${ELIGIBLE.displayName}` }),
    ).toBeInTheDocument();
    const download = screen.getByRole('link', { name: /download png/i });
    expect(download).toHaveAttribute('download', 'review-qr-acme.png');
    expect(download).toHaveAttribute('href', ELIGIBLE.qrDataUrl);
    const print = screen.getByRole('link', { name: /^print$/i });
    expect(print).toHaveAttribute('href', `/settings/review-qr/print/${ELIGIBLE.businessId}`);

    // Ineligible card: plain-language copy + a Reconnect Google action, and NO
    // QR, download, or print (S24 — never "canonical Google Place ID").
    expect(
      screen.getByText(/we couldn.t verify this location.s google listing yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/canonical|place id/i)).toBeNull();
    expect(screen.getByRole('link', { name: /reconnect google/i })).toHaveAttribute(
      'href',
      `/dashboard/connect?locationId=${INELIGIBLE.businessId}`,
    );
    expect(
      screen.queryByRole('img', { name: `Review QR for ${INELIGIBLE.displayName}` }),
    ).toBeNull();
    expect(screen.getAllByRole('link', { name: /download png/i })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /^print$/i })).toHaveLength(1);
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

describe('reviewQrFileName', () => {
  it('slugs the display name, strips accents and punctuation', () => {
    expect(reviewQrFileName('Harbor Café — Main St')).toBe('review-qr-harbor-cafe-main-st.png');
    expect(reviewQrFileName('  Acme  ')).toBe('review-qr-acme.png');
  });

  it('falls back to "location" when nothing survives the slug', () => {
    expect(reviewQrFileName('***')).toBe('review-qr-location.png');
    expect(reviewQrFileName('')).toBe('review-qr-location.png');
  });

  it('caps the slug so a very long name still makes a sane file name', () => {
    const name = 'x'.repeat(200);
    expect(reviewQrFileName(name)).toBe(`review-qr-${'x'.repeat(60)}.png`);
  });
});
