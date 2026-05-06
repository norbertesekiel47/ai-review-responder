import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PricingContent } from '../PricingContent';

describe('PricingContent', () => {
  it('renders pre-launch public tiers as disabled coming soon cards', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).not.toContain('Most popular');
    expect(html).toContain('Recommended');
    expect(html).toContain('7 of 100');
    expect(html).toContain('width:7%');
    expect(html).toContain('Billed annually ($1908/yr) - 20% off $199/mo');
    expect(html).not.toContain('Start 14-day trial');
    expect(html.match(/Coming soon/g)).toHaveLength(3);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3);
  });

  it('renders updated tier positioning without overpromising SLA-backed public support', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).toContain('Everything in Standard');
    expect(html).toContain('Best for up to ~50 review responses/month');
    expect(html).toContain('AI-drafted replies in your business voice');
    expect(html).toContain('Responds in the reviewer');
    expect(html).toContain('High-volume or fair-use unlimited review responses');
    expect(html).toContain('Historical unanswered review backfill');
    expect(html).not.toContain('SLA-backed response time');
  });

  it('renders billing toggle state without inline thumb sizing', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).toContain('class="pr-toggle is-annual"');
    expect(html).toContain('aria-pressed="false">Monthly</button>');
    expect(html).toContain('aria-pressed="true">Annual');
    expect(html).not.toContain('left:');
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
});
