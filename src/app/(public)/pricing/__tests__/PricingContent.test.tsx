import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PricingContent } from '../PricingContent';

describe('PricingContent', () => {
  it('renders the bottom CTA as an early access waitlist form', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    expect(html).toContain('Join waitlist');
    expect(html).toContain('value="pricing"');
    expect(html).toContain('value="waitlist"');
    expect(html).not.toContain('Book a Demo');
    expect(html).not.toContain('Book My Demo');
  });
});
