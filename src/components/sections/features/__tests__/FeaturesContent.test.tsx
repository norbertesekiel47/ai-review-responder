import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeaturesContent } from '../FeaturesContent';

describe('FeaturesContent', () => {
  it('renders the final CTA as an early access waitlist form', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).toContain('Join waitlist');
    expect(html).toContain('value="features"');
    expect(html).toContain('value="waitlist"');
    expect(html).toContain('class="rw-foot"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).not.toContain('Book a demo');
    expect(html).not.toContain('Book a Demo');
  });

  it('renders hero words in gap-managed rows', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html.match(/class="rw-hero-line"/g)).toHaveLength(2);
  });
});
