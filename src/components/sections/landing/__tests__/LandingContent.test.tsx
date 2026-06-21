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
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
    expect(html).not.toContain('personalised demo within 24 hours');
    expect(html).not.toContain('Book a demo');
  });

  it('offers a "See how it works" secondary CTA linking to /how-it-works', () => {
    const html = renderToStaticMarkup(createElement(LandingContent));

    expect(html).toContain('See how it works');
    expect(html).toContain('href="/how-it-works"');
  });

  it('does not present fabricated live metrics or named reviewers', () => {
    const html = renderToStaticMarkup(createElement(LandingContent));

    // Fabricated aggregate "live" metrics removed from the ticker.
    expect(html).not.toContain('84,213');
    expect(html).not.toContain('1,240');
    expect(html).not.toContain('+312 today');
    expect(html).not.toContain('+127 replies');
    expect(html).not.toContain('joined this week');
    expect(html).not.toContain('Owner hours saved');

    // Named reviewer / owner copy replaced with generic, unnamed labels.
    expect(html).not.toContain('Rachel');
    expect(html).not.toContain('Claire');
    expect(html).toContain('A recent reviewer');

    // Demo widgets are clearly framed as illustrative.
    expect(html).toContain('Example');
  });

  it('keeps the response-rate figure to a single 96% value', () => {
    const html = renderToStaticMarkup(createElement(LandingContent));

    expect(html).toContain('96%');
    expect(html).not.toContain('96.3%');
  });

  it('uses a consistent, non-overpromised latency phrase', () => {
    const html = renderToStaticMarkup(createElement(LandingContent));
    expect(html).not.toContain('Draft ready in 8 seconds');
    expect(html).toContain('Draft ready in seconds');
  });

  it('exposes the voice dial as a keyboard-operable slider', () => {
    const html = renderToStaticMarkup(createElement(LandingContent));

    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow');
    expect(html).toContain('aria-valuetext="Balanced"');
    // The actual control must not be hidden from assistive tech.
    expect(html).not.toContain('rw-voice-dial " aria-hidden="true"');
  });
});
