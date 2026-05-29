import { describe, expect, it } from 'vitest';
import { legalDocs } from '../content';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';

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
    expect(dataSection).toBeDefined();
    expect(subProcessorSection).toBeDefined();

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
    for (const excluded of ['PostHog', 'Help Scout', 'Cloudflare', 'Loops', 'Customer.io']) {
      expect(vendors).not.toContain(excluded);
    }
  });

  it('does not leak the in-product AI-draft disclosure into legal prose', () => {
    for (const slug of ['privacy', 'aup', 'terms'] as const) {
      const bodies = legalDocs[slug].sections.flatMap((section) => section.body);
      expect(bodies).not.toContain(AI_DRAFT_DISCLOSURE);
    }
  });

  it('publishes a non-misleading, on-request DPA', () => {
    const dpa = legalDocs.dpa;
    const headings = dpa.sections.map((section) => section.heading);
    const bodyText = dpa.sections
      .flatMap((section) => section.body)
      .join(' ')
      .toLowerCase();

    expect(headings).toContain('Requesting a DPA');
    expect(headings).not.toContain('Status');
    expect(bodyText).not.toContain('pending');
    expect(bodyText).not.toContain('should not treat');
    expect(bodyText).toContain('request our dpa');
    expect(bodyText).toContain('info@repworth.net');
  });
});
