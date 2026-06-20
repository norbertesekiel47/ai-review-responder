import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HowItWorksContent } from '../HowItWorksContent';

describe('HowItWorksContent', () => {
  it('renders the final CTA as an early access waitlist form', () => {
    const html = renderToStaticMarkup(createElement(HowItWorksContent));

    expect(html).toContain('Join waitlist');
    expect(html).toContain('value="how-it-works"');
    expect(html).toContain('value="waitlist"');
    // SiteFooter renders `class="rw-foot flex-col items-stretch"`.
    expect(html).toContain('class="rw-foot');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).not.toContain('Book a Demo');
  });
});
