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

  it('states only claims true to the system', () => {
    const html = renderToStaticMarkup(createElement(HowItWorksContent));

    // removed false/contradicting claims
    expect(html).not.toContain('No auto-post, ever');
    expect(html).not.toContain('Approval is a hard gate');
    expect(html).not.toContain('past 30 owner responses');
    expect(html).not.toContain('import your last 30 owner responses');
    expect(html).not.toContain('Google Business API');
    expect(html).not.toContain('voice model v3');
    expect(html).not.toContain('Matches you');
    expect(html).not.toContain('out of the box');

    // present, corrected claims
    expect(html).toContain('approve and edit');
    expect(html).toContain('Multi-location supported on Copilot and Autopilot');

    // new pipeline claims
    expect(html).toContain('Guardian reads it before anyone answers.');
    expect(html).toContain('Copilot asks you. Autopilot asks your policy.');
    expect(html).toContain('Every auto-post gets a second opinion.');
    expect(html).toContain('Negative reviews are never auto-posted');
    expect(html).toContain('of auto-posts judged');
    // stale claims gone
    expect(html).not.toContain('Four steps from new review');
    expect(html).not.toContain('15 hrs');
    expect(html).not.toContain('saved weekly');
    expect(html).not.toContain('just four well-behaved services');
  });
});
