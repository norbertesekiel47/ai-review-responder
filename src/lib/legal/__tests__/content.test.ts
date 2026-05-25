import { describe, expect, it } from 'vitest';
import { legalDocs } from '../content';

describe('legal content', () => {
  it('publishes material Terms sections on the route-backed typed document', () => {
    const headings = legalDocs.terms.sections.map((section) => section.heading);

    expect(headings).toEqual(expect.arrayContaining([
      'Notifications',
      'Disclaimer of Warranties',
      'Limitation of Liability',
      'Termination',
      'Governing Law',
    ]));
  });

  it('publishes detailed Privacy data classes and live sub-processors', () => {
    const dataSection = legalDocs.privacy.sections.find(
      (section) => section.heading === 'Data We Process',
    );
    const subProcessorSection = legalDocs.privacy.sections.find(
      (section) => section.heading === 'Sub-processors',
    );
    const vendors = subProcessorSection?.table?.rows.map((row) => row[0]) ?? [];

    expect(dataSection?.bullets).toEqual(expect.arrayContaining([
      expect.stringContaining('Account data:'),
      expect.stringContaining('Review data:'),
      expect.stringContaining('Reliability and service metadata:'),
    ]));
    expect(vendors).toEqual(expect.arrayContaining([
      'SerpAPI',
      'Google Maps Platform',
    ]));
    expect(vendors).not.toEqual(expect.arrayContaining([
      'PostHog',
      'Help Scout',
      'Cloudflare',
      'Loops',
      'Customer.io',
    ]));
  });
});
