import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PricingContent } from '../PricingContent';

describe('PricingContent', () => {
  it('renders the pricing page with the site-wide footer', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    // page content sanity
    expect(html).toContain('value="pricing"');
    // site-wide footer now present (SiteFooter renders
    // `class="rw-foot flex-col items-stretch"`).
    expect(html).toContain('class="rw-foot');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
  });

  it('renders pre-launch public tiers as disabled coming soon cards', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).not.toContain('Most popular');
    expect(html).toContain('Recommended');
    // Fabricated scarcity widget removed (UX polish): no fake "spots remaining".
    expect(html).not.toContain('Spots remaining');
    expect(html).not.toContain('7 of 100');
    expect(html).not.toContain('pr-slots');
    expect(html).toContain('Billed annually ($1908/yr) - 20% off $199/mo');
    expect(html).not.toContain('Start 14-day trial');
    expect(html.match(/Coming soon/g)).toHaveLength(3);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3);
  });

  it('renders updated tier positioning without overpromising SLA-backed public support', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).toContain('Everything in Standard');
    expect(html).toContain('1 Google Business Profile location');
    expect(html).toContain('Multi-location setup available');
    expect(html).toContain('AI-drafted replies in your business voice');
    expect(html).toContain('Responds in the reviewer');
    expect(html).toContain('Historical unanswered review backfill');
    expect(html).not.toContain('SLA-backed response time');
  });

  it('renders billing toggle state without inline thumb sizing', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).toContain('class="pr-toggle is-annual"');
    expect(html).toContain('aria-pressed="false">Monthly</button>');
    expect(html).toContain('aria-pressed="true">Annual');
    // The thumb is positioned purely in CSS — it carries no inline style at all.
    // (Scoped to the thumb: the comparison matrix legitimately uses inline
    // `left:0` for its sticky first column, so a page-wide `left:` ban is wrong.)
    expect(html).toContain('<div class="pr-toggle-thumb"></div>');
    expect(html).not.toContain('width:calc(50% - 3px)');
  });

  it('renders the bottom CTA as an early access waitlist form', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).toContain('Join waitlist');
    expect(html).toContain('value="pricing"');
    expect(html).toContain('value="waitlist"');
    expect(html).not.toContain('Book a Demo');
    expect(html).not.toContain('Book My Demo');
  });

  it('exposes the comparison matrix as a labeled, keyboard-scrollable region', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).toContain(
      'aria-label="Plan comparison, scroll horizontally to compare all plans"',
    );
    expect(html).toMatch(/class="pr-matrix"[^>]*tabindex="0"/);
  });

  it('pins the matrix header row and first column with sticky positioning', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    // Header cells pin to the top; the first column pins to the left.
    expect(html).toMatch(/position:sticky;top:0/);
    expect(html).toMatch(/position:sticky;left:0/);
  });

  it('notes the billing currency near the toggle', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).toContain('All prices in USD');
  });

  it('links FAQ triggers to their panels and exposes slider value text', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).toContain('aria-controls=');
    // FAQ answer panels are labelled <section> landmarks (native region, no role= needed)
    expect(html).toMatch(/<section[^>]*aria-labelledby=/);
    expect(html).toContain('aria-valuetext="80 reviews"');
  });

  it('states only billing claims true to the system', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    // removed false / metering claims
    expect(html).not.toContain('refund the unused months');
    expect(html).not.toContain('review responses/month');
    expect(html).not.toContain('What counts as a');
    expect(html).not.toContain('go over my monthly limit');
    expect(html).not.toContain('Multiple approval notification channels');
    expect(html).not.toContain('3-year price lock');
    expect(html).not.toContain('Pay for what you actually use');

    // corrected claims present
    expect(html).toContain('not refunded for unused time');
    expect(html).toContain('apply immediately and are prorated');
    expect(html).toContain('Locked-in founder pricing');
    expect(html).toContain('Billed annually ($756/yr) - 20% off $79/mo');
  });
});
