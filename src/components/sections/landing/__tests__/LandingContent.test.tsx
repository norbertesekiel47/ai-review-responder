import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LandingContent } from '../LandingContent';

describe('LandingContent', () => {
  it('renders the landing CTA as an early access waitlist', () => {
    const html = renderToStaticMarkup(createElement(LandingContent));

    expect(html).toContain('Join waitlist');
    expect(html).toContain('Join the early access waitlist.');
    expect(html).toContain('value="landing"');
    expect(html).toContain('value="waitlist"');
    expect(html).not.toContain('personalised demo within 24 hours');
    expect(html).not.toContain('Book a demo');
  });
});
