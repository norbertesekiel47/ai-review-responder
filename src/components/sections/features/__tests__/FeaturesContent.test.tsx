import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeaturesContent } from '../FeaturesContent';

describe('FeaturesContent', () => {
  it('renders the final CTA as an early access waitlist form', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).toContain('Get early access.');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Get early access</);
    expect(html).not.toContain('Join waitlist');
    expect(html).not.toContain('Join the early access waitlist');
    expect(html).toContain('value="features"');
    expect(html).toContain('value="waitlist"');
    expect(html).toContain('class="rw-foot'); // footer now carries extra layout classes
    expect(html).toContain('href="/legal/privacy"');
    expect(html).not.toContain('Book a demo');
    expect(html).not.toContain('Book a Demo');
  });

  it('renders the hero headline as masked rows (the Daylight line-rise entrance)', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    // Five pre-broken lines, each inside its own overflow mask — the same
    // entrance /how-it-works uses, so the two heroes move alike.
    expect(html.match(/class="rw-hero-line"/g)).toHaveLength(5);
    expect(html).toContain('A team of agents');
    expect(html).toContain('answers, asks,');
    expect(html).toContain('briefs, measures.');
    expect(html).toContain('without the gate.');
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

    expect(html).toContain('How the system is built, not measured results.');
  });

  it('shows product facts in the hero stack, never invented performance figures', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    const stack = html.slice(html.indexOf('feat-hero-stats'), html.indexOf('rw-feat-marquee-mask'));

    // Three facts about how the pipeline is built (design of record §8).
    expect(stack).toContain('of auto-posts reviewed');
    expect(stack).toContain('veto window before an');
    expect(stack).toContain('languages Reply');
    expect(stack).toContain('<small>%</small>');
    expect(stack).toContain('<small>min</small>');
    expect(stack).toContain('<small>+</small>');
    expect(stack).toContain('How the system is built, not measured results.');
    // The invented targets are gone — no "Target:/Goal:/Aim:" framing, no
    // response-rate or turnaround figures dressed as KPIs.
    expect(stack).not.toMatch(/Target:|Goal:|Aim:/);
    expect(stack).not.toContain('Illustrative targets');
    expect(stack).not.toContain('96');
    expect(stack).not.toContain('58');
    expect(stack).not.toContain('sec');
  });

  it('reframes the results chapter as dashboard chrome with no fabricated before/after', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    const start = html.indexOf('id="f-roi"');
    const roi = html.slice(start, html.indexOf('</section>', start));

    expect(roi).toContain('Response rate');
    expect(roi).toContain('Average rating');
    expect(roi).toContain('Local map rank');
    expect(roi).toContain('No sample numbers here');
    // Invented before → after pairs and the sample weekly total are gone.
    for (const figure of ['12%', '96', '4.1', '4.6', '#14', '#3', '1.6', '14 reviews', 'feat-roi-before', 'feat-roi-after']) {
      expect(roi).not.toContain(figure);
    }
    // The time-saved heuristic is the product's own constant, as a formula.
    expect(roi).toContain('About 7 minutes per handled review');
    expect(roi).toContain('handled reviews × 7 min');
  });

  it('puts the same forest pill in the hero as /how-it-works, anchored to the CTA band', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toMatch(/<a(?=[^>]*href="#feat-cta")(?=[^>]*class="rw-pill rw-pill-forest")[^>]*>Get early access</);
    expect(html).toContain('id="feat-cta"');
    // The pill comes before the pricing text link inside the hero link row.
    expect(html).toMatch(/feat-hero-links[\s\S]{0,400}?href="#feat-cta"[\s\S]{0,400}?href="\/pricing"/);
  });

  it('turns the hero pill into the /signup door when self-serve is on, and hides it when coming soon', () => {
    const on = renderToStaticMarkup(
      createElement(FeaturesContent, { selfServeEnabled: true, signupCtaLabel: 'Create account' })
    );
    const hero = on.slice(on.indexOf('feat-hero-links'), on.indexOf('feat-hero-stats'));
    expect(hero).toMatch(/<a(?=[^>]*href="\/signup")(?=[^>]*class="rw-pill rw-pill-forest")[^>]*>Create account</);
    expect(on).not.toContain('href="#feat-cta"');

    const soon = renderToStaticMarkup(createElement(FeaturesContent, { comingSoon: true }));
    expect(soon).not.toContain('href="#feat-cta"');
    expect(soon).not.toContain('href="/signup"');
  });

  it('describes the lineup honestly (jobs, agents, watchdogs, modes)', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).toContain('5 jobs · 4 agents · 2 watchdogs · 2 modes');
    expect(html).not.toContain('3 agents · 2 watchdogs');
    expect(html).not.toContain('Six features today');
    expect(html).not.toContain('6 live · 1 in testing');
  });

  it('keeps the competitor feature labeled as not-yet-released', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).toContain('Coming soon');
    expect(html).toContain('preview');
  });

  it('reads as one system with five jobs, closing on the gate', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('One system, five jobs');
    expect(html).toContain('gate.');
    // The five job groups, in page order; the old three role groups are gone.
    const order = ['Respond', 'Request', 'Brief', 'Measure', 'Govern'].map((g) =>
      html.indexOf(`<span class="feat-grp-name">${g}</span>`)
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const stale of ['Your agent team', 'Care and control', 'Craft and proof']) {
      expect(html).not.toContain(stale);
    }
  });

  it('gives every job its own chapters, so the reply pipeline is a minority of the page', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    const chapterIds = ['f-reply', 'f-voice', 'f-lang', 'f-qr', 'f-solicitor', 'f-insights', 'f-dashboard', 'f-restraint', 'f-roi', 'f-guardian', 'f-gate', 'f-autopilot', 'f-watchdogs'];
    for (const id of chapterIds) expect(html).toContain(`id="${id}"`);
    // Index rows size themselves to their group (1–4 chapters), never a fixed three.
    expect(html).toContain('--idx-n:3');
    expect(html).toContain('--idx-n:2');
    expect(html).toContain('--idx-n:1');
    expect(html).toContain('--idx-n:4');
  });

  it('presents the Review QR as live: one code per location, straight to Google, no page of ours', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    const start = html.indexOf('id="f-qr"');
    const qr = html.slice(start, html.indexOf('</section>', start));
    expect(qr).toContain('Review QR · on the counter');
    expect(qr).toContain('One identical code per location');
    expect(qr).toContain('Google review form');
    expect(qr).toContain('Sample QR code, not scannable');
    expect(qr).not.toContain('landing page');
    expect(qr).not.toMatch(/\bwill\b/);
  });

  it('presents Solicitor in present tense, email-only, consent-first, never posting', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    const start = html.indexOf('id="f-solicitor"');
    const sol = html.slice(start, html.indexOf('</section>', start));
    expect(sol).toContain('Solicitor · managed batches');
    expect(sol).toContain('Solicitor is the requesting agent');
    expect(sol).toContain('One-click unsubscribe');
    expect(sol).toContain('never posts anything publicly');
    expect(sol).toContain('Withheld');
    expect(sol).not.toContain('SMS');
    expect(sol).not.toContain('text message');
    expect(sol).not.toMatch(/\bwill\b/);
  });

  it('states the Rep Pulse formula from the product constants, with sample values labelled', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    const start = html.indexOf('id="f-dashboard"');
    const dash = html.slice(start, html.indexOf('</section>', start));
    expect(dash).toContain('Dashboard · Rep Pulse');
    expect(dash).toContain('rating ÷ 5 × 70 + response rate × 30');
    expect(dash).toContain('Your dashboard · sample');
    expect(dash).toContain('Review velocity');
    expect(dash).toContain('until it has enough history');
  });

  it('shows the Restraint tab as the record of what the system declined to do', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    const start = html.indexOf('id="f-restraint"');
    const r = html.slice(start, html.indexOf('</section>', start));
    expect(r).toContain('Restraint · what it declined');
    expect(r).toContain('Owner review required');
    expect(r).toContain('Watchdog unavailable');
    expect(r).toContain('Illustrative entries');
  });

  it('pairs the weekly brief with the monthly impact report', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    const start = html.indexOf('id="f-insights"');
    const brief = html.slice(start, html.indexOf('</section>', start));
    expect(brief).toContain('Weekly brief · sample');
    expect(brief).toContain('Monthly impact report · sample');
    expect(brief).toContain('Monthly Intelligence Brief');
    expect(brief).toContain('Best Review of the Month');
  });

  it('states only claims true to the system (2026-08-16 truth pass)', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    // drafting is what happens on its own; posting depends on the owner or their settings
    expect(html).toContain('drafts');
    // sample replies must not invent business facts (prompt-policy.ts forbids it)
    expect(html).not.toContain('achiote marinade from scratch');
    expect(html).not.toContain('abuela');
    // ranking has no radius; the check is centred on the listing
    expect(html).not.toContain('RADIUS');
    // '+14 more' mapped to nothing; the drafting rules name 31 languages
    expect(html).not.toContain('+14');
    expect(html).toContain('30+');
    // plain-language pass
    expect(html).not.toContain('Bounded autonomy');
    expect(html).not.toContain('unflagged');
    expect(html).not.toContain('independent AI');
    expect(html).not.toContain('via webhook');
    // the hero stack states how the pipeline is built, not a performance target
    expect(html).toContain('by the Judge');
    // real digest sections + time-saved estimate now named
    expect(html).toContain('Estimated time saved this week');
    expect(html).toContain('Time saved · estimate');
    // the weekly brief cannot know day/hour; the sample must not claim it
    expect(html).not.toContain('Saturday nights');
    // Features gained the pricing link How It Works already had
    expect(html).toContain('href="/pricing"');
  });

  it('swaps the waitlist form for the /signup CTA when self-serve is on', () => {
    const html = renderToStaticMarkup(
      createElement(FeaturesContent, {
        selfServeEnabled: true,
        signupCtaLabel: 'Start your 30-day free trial',
      })
    );
    expect(html).toContain('href="/signup"');
    expect(html).toContain('Start your 30-day free trial');
    expect(html).not.toContain('value="waitlist"');
  });

  it('keeps roadmap items as verb phrases, not shipped claims', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Flag fakes · Watch everywhere · Compare with competitors');
    // "Get reviews" shipped (Review QR + Solicitor), so it left the roadmap roster.
    expect(html).not.toContain('Get reviews ·');
    expect(html).toContain('Coming soon');
    expect(html).toContain('preview');
  });

  it('exposes the before/after toggle state via aria-pressed', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    // Default tab is "after"; exactly one pressed and one unpressed toggle.
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
    // The secondary CTA is a text link inside the CTA band's link row
    // (.rw-dl-cta-more underlines via border-bottom), never a pill.
    expect(html).toMatch(/rw-dl-cta-more[\s\S]{0,200}?href="\/how-it-works"/);
    expect(html).not.toMatch(/rw-pill[^"]*"[^>]*href="\/how-it-works"/);
  });

  it('states only feature claims true to the system', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).not.toContain('Top mentions, scored by sentiment');
    expect(html).not.toContain('over 90 days');
    expect(html).not.toContain('Webhook from Google');
    expect(html).not.toContain('ever posted without your explicit go-ahead');
    expect(html).not.toContain('7am');
    // triage severity vocabulary is low/medium/high (triage-schema.ts), and
    // review-bombing detection is proposed-only, not built (PRODUCT.md)
    expect(html).not.toContain('elevated');
    expect(html).not.toContain('critical');
    expect(html).not.toContain('review-bombing');
    // no measured customer data exists (PRODUCT.md "Evidence on Hand"): any
    // figure must carry an illustrative disclaimer, and empirical claims about
    // owner behaviour may not appear at all
    expect(html).not.toContain('Median owner time');
    expect(html).not.toContain('most owners');
    expect(html).not.toContain('86%');
    // the digest has no topic-frequency extraction and no avg-star tile
    expect(html).not.toContain('Top mentions this week');
    expect(html).not.toContain('Avg stars');
    // competitor scorecard is a roadmap preview, not a live program
    expect(html).not.toContain('private testing');

    expect(html).toContain('Nothing is posted without your go-ahead');
    expect(html).toContain('Insights · every Monday');
    // the one remaining illustrative figure (08 Voice) keeps its disclaimer;
    // the hero facts and the results tiles carry no figures to disclaim
    expect(html).toContain('How the system is built, not measured results.');
    expect(html).toContain('Illustrative target, not live performance data.');
    expect(html).toContain('No sample numbers here: the tiles fill with your own.');
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

  it('describes the Copilot gate as email-only until other channels launch', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Copilot · your control');
    expect(html).toContain('comes to you by email');
    // Telegram and WhatsApp exist in code but are off in production
    // (CHANNELS_TELEGRAM_ENABLED / CHANNELS_WHATSAPP_ENABLED) — do not name
    // them in marketing copy until they are actually on.
    expect(html).not.toContain('Telegram');
    expect(html).not.toContain('WhatsApp');
    expect(html).toContain('Nothing is posted without your go-ahead');
  });

  it('introduces Guardian triage and escalation without public actions', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Guardian · reviews of 3★ or less');
    expect(html).toContain('Guardian never posts anything, anywhere');
    expect(html).toContain('Severity read');
  });

  it('describes Autopilot as autonomy within the owner\'s rules, with a veto window', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Autopilot · within your rules');
    expect(html).toContain('veto window');
    expect(html).toContain('Negative reviews are never auto-posted');
  });

  it('explains the Judge and Governor watchdogs', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));
    expect(html).toContain('Judge &amp; Governor · oversight');
    expect(html).toContain('auto-posting stops');
    expect(html).toContain('Governor pauses Autopilot');
  });
});
