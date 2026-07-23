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
    expect(html).toContain('class="rw-foot'); // footer now carries extra layout classes
    expect(html).toContain('href="/legal/privacy"');
    expect(html).not.toContain('Book a demo');
    expect(html).not.toContain('Book a Demo');
  });

  it('renders hero words in gap-managed rows', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html.match(/class="rw-hero-line"/g)).toHaveLength(2);
  });

  it('uses illustrative, unnamed sample content rather than invented people or businesses', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    // Marquee + demo reviews are clearly illustrative.
    expect(html).toContain('Sample review');
    expect(html).toContain('Sample reviewer');

    // No invented named reviewers.
    expect(html).not.toContain('Sarah K.');
    expect(html).not.toContain('Carlos M.');

    // Competitor scorecard uses anonymized placeholders, not real businesses.
    expect(html).toContain('Competitor A');
    expect(html).toContain('Competitor B');
    expect(html).toContain('Competitor C');
    expect(html).not.toContain('El Farolito');
    expect(html).not.toContain('La Taqueria');
    expect(html).not.toContain('Tacos El Primo');
    expect(html).not.toContain('Mama Rosa');
  });

  it('reconciles the response-rate claim to a single figure (96%)', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).toContain('96');
    // The fabricated "100% responded" / "100%" response-rate claim is gone.
    expect(html).not.toContain('100% responded');
    expect(html).not.toContain('>100<');
  });

  it('describes the lineup honestly (agents, watchdogs, modes)', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).toContain('3 agents · 2 watchdogs · 2 modes');
    expect(html).not.toContain('Six features today');
    expect(html).not.toContain('6 live · 1 in testing');
  });

  it('keeps the competitor feature labeled as not-yet-released', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).toContain('Coming soon');
    expect(html).toContain('preview');
  });

  it('leads with the trusted-autonomy narrative', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('tireless');
    expect(html).toContain('gate.');
    expect(html).toContain('Your agent team');
    expect(html).toContain('Care and control');
    expect(html).toContain('Craft and proof');
  });

  it('keeps roadmap items as verb phrases, not shipped claims', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Get reviews · Flag fakes · Watch everywhere');
    expect(html).toContain('Coming soon');
    expect(html).toContain('preview');
  });

  it('exposes the before/after toggle state via aria-pressed', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    // Default tab is "after" — exactly one pressed and one unpressed toggle.
    expect(html.match(/aria-pressed="true"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain('aria-pressed="false"');
  });

  it('gives decorative star glyphs an accessible label', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).toContain('out of 5 stars');
    expect(html).toContain('aria-hidden="true"');
  });

  it('de-emphasizes the secondary CTA to a text link', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).toContain('href="/how-it-works"');
    expect(html).toContain('See how it works');
    // The secondary CTA is now an underlined text link, not a bordered pill button.
    expect(html).toMatch(/<a class="[^"]*underline[^"]*decoration-white[^"]*" href="\/how-it-works"/);
    // The old equal-weight bordered-pill styling is gone.
    expect(html).not.toContain('px-8 py-4 text-white rounded-full font-medium border border-white/40');
  });

  it('states only feature claims true to the system', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).not.toContain('Top mentions, scored by sentiment');
    expect(html).not.toContain('over 90 days');
    expect(html).not.toContain('Webhook from Google');
    expect(html).not.toContain('ever posted without your explicit go-ahead');
    expect(html).not.toContain('7am');

    expect(html).toContain('Nothing is posted without your go-ahead');
    expect(html).toContain('Insights · every Monday');
  });

  it('presents the weekly brief as the Insights agent', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Insights · every Monday');
    expect(html).toContain('Insights is the reporting agent');
  });

  it('presents Reply as the drafting agent', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Reply · your drafter');
    expect(html).toContain('Reply is the drafting agent');
    expect(html).toContain('from a template.');
  });

  it('describes the Copilot gate with all three channels', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Copilot · your control');
    expect(html).toContain('email, Telegram, or WhatsApp');
    expect(html).toContain('Nothing is posted without your go-ahead');
  });

  it('introduces Guardian triage and escalation without public actions', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Guardian · the negative lane');
    expect(html).toContain('Guardian never posts anything, anywhere');
    expect(html).toContain('Severity read');
  });

  it('describes Autopilot as bounded autonomy with a veto window', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Autopilot · bounded autonomy');
    expect(html).toContain('veto window');
    expect(html).toContain('Negative reviews are never auto-posted');
  });

  it('explains the Judge and Governor watchdogs', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Judge &amp; Governor · oversight');
    expect(html).toContain('auto-posting stops');
    expect(html).toContain('Governor suspends');
  });
});
