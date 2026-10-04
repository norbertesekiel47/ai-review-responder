import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import { PricingContent } from '../PricingContent';

function renderPricing(input?: {
  founding?: boolean;
  autopilot?: boolean;
  trial?: boolean;
  selfServe?: boolean;
}) {
  const viewModel = buildPlanPresentation({
    priceVariant: input?.founding ? 'founding' : 'list',
    autopilotPurchasable: input?.autopilot ?? true,
    trialEnabled: input?.trial ?? false,
  });
  return renderToStaticMarkup(createElement(PricingContent, {
    viewModel,
    selfServeEnabled: input?.selfServe ?? false,
  }));
}

describe('PricingContent', () => {
  it('renders exactly Copilot and Autopilot with immutable list and overage amounts', () => {
    const html = renderPricing();

    expect(html.match(/class="pr-plan /g)).toHaveLength(2);
    // Plan names sit under the section's h2 ("Two plans · billed monthly"), so h3 (M21).
    expect(html).toContain('<h3 class="pr-plan-name">Copilot</h3>');
    expect(html).toContain('<h3 class="pr-plan-name">Autopilot</h3>');
    expect(html).not.toMatch(/<h2[^>]*>(Copilot|Autopilot)<\/h2>/);
    expect(html).toContain('<span class="pr-price-amt">79</span>');
    expect(html).toContain('<span class="pr-price-amt">149</span>');
    expect(html).toContain('$79/month per extra location');
    expect(html).toContain('$149/month per extra location');
    expect(html).not.toMatch(/Founders|Basic|Standard|Premium/);
  });

  it('renders both founding rates with list context and the lifetime lock', () => {
    const html = renderPricing({ founding: true });

    expect(html).toContain('<span class="pr-price-amt">49</span>');
    expect(html).toContain('<span class="pr-price-amt">99</span>');
    expect(html).toContain('$79 list');
    expect(html).toContain('$149 list');
    expect(html.match(/Founding rate locked for the account/g)).toHaveLength(2);
  });

  it('contains no yearly selector, discount, stale trial claim, or unsupported automation claim', () => {
    const html = renderPricing();

    expect(html).not.toMatch(/annual|yearly|save 20%/i);
    expect(html).not.toMatch(/14-day|14 day|no credit card|95% automation/i);
    expect(html).not.toContain('pr-toggle');
  });

  it('shows the exact card-up-front trial posture only when the server enables it', () => {
    const enabled = renderPricing({ trial: true, selfServe: true });
    const disabled = renderPricing({ trial: false, selfServe: true });

    expect(enabled).toContain('30-day trial · Card required up front · Explicit plan selection');
    expect(enabled).toContain('Choose a plan explicitly and provide a card up front');
    expect(disabled).not.toMatch(/trial|card required/i);
  });

  it('keeps closed Autopilot visible with a quiet status and moves emphasis to Copilot (self-serve)', () => {
    const html = renderPricing({ autopilot: false, selfServe: true });

    // Status, not a dead-end: an "Opening soon" badge and owner-language next step,
    // no disabled button, no "More autonomy" ribbon on the tier you cannot buy.
    expect(html).toContain('>Opening soon</div>');
    expect(html).not.toContain('More autonomy');
    expect(html).not.toMatch(/disabled=""/);
    expect(html).toContain('Not open yet: we are finishing its safety checks. Start on Copilot now');
    // The buyable tier carries the primary action; nothing is visually featured —
    // not the card, not the matrix column, and the band does not offer Autopilot.
    expect(html).toMatch(/class="pr-plan-cta primary"[^>]*href="\/signup"[^>]*>Choose Copilot</);
    expect(html).not.toContain('pr-plan is-featured');
    expect(html).not.toContain('pr-matrix-cell hdr featured');
    expect(html).not.toContain('pr-matrix-cell num featured');
    expect(html).toContain('Start with Copilot today.');
    expect(html).not.toContain('choose Copilot or Autopilot');
  });

  it('points both plan doors and the CTA band at the closed notice, with no form (self-serve off; RepWorth shut down)', () => {
    const html = renderPricing({ autopilot: false, selfServe: false });

    expect(html).toMatch(/<a(?=[^>]*class="pr-plan-cta primary")(?=[^>]*href="\/closed")[^>]*>Read the notice</);
    expect(html).toMatch(/<a(?=[^>]*class="pr-plan-cta ghost")(?=[^>]*href="\/closed")[^>]*>Read the notice</);
    expect(html).not.toContain('href="#pricing-waitlist"');
    expect(html).not.toContain('waitlist sign-ups');
    expect(html).not.toContain('name="pricing-plan-interest"');
    expect(html).not.toContain('<form');
    // The CTA band's h2 is the one closed phrase, same as every pill (M4 handoff).
    expect(html).toContain('<h2 id="pr-cta-h">RepWorth has closed.</h2>');
    expect(html).toContain('We are no longer taking sign-ups.');
    expect(html).toMatch(/<a(?=[^>]*class="rw-pill rw-pill-paper")(?=[^>]*href="\/closed")[^>]*>Read the notice</);
    expect(html).not.toContain('Get early access');
  });

  it('features Autopilot with the primary action only when it is purchasable', () => {
    const html = renderPricing({ autopilot: true, selfServe: true });

    expect(html).toContain('pr-plan is-featured');
    expect(html).toContain('>More autonomy</div>');
    expect(html).not.toContain('Opening soon');
    expect(html).toMatch(/class="pr-plan-cta primary"[^>]*>Choose Autopilot</);
    expect(html).toMatch(/class="pr-plan-cta ghost"[^>]*>Choose Copilot</);
    expect(html).toContain('pr-matrix-cell hdr featured');
    expect(html).toContain('Ready to choose your plan?');
  });

  it('states the shipped agent-team and autonomy boundary precisely', () => {
    const html = renderPricing();

    // The CLAIMS are the contract, not the wording. Reworded 2026-08-26 in a
    // copy pass; each line below asserts the same boundary it always did.
    //
    // 'unflagged' went because this project's own truth pass had already ruled
    // it an internal word on /how-it-works ("→ 'pass our safety checks'"), and
    // that decision had never been applied here. Same for naming the internal
    // components as "gates".
    expect(html).toContain('Reply drafts personalized responses');
    expect(html).toContain('Guardian holds negative and flagged reviews');
    expect(html).toContain('Insights sends you a weekly review brief');
    expect(html).toContain('You approve every reply before it posts');
    // The five-jobs pass (2026-09-06): both plans name requests, the QR, and the
    // dashboard; only Autopilot lets a request batch send on its own.
    expect(html).toContain('Solicitor asks past customers for reviews by email, in batches you approve');
    expect(html).toContain('printable review QR code');
    expect(html).toContain('Rep Pulse');
    expect(html).toContain('Request batches that fit your policy may send on their own after the veto window');
    expect(html).toContain('Every batch waits for your approval');
    expect(html).toContain('Are review requests included on both plans?');
    expect(html).not.toContain('SMS');
    expect(html).not.toContain('WhatsApp');
    expect(html).toContain('Only 4–5★ replies that pass our safety checks may post automatically');
    expect(html).toContain('Safety checks, the Judge, and the Governor must all clear it');
    expect(html).toContain('Negative and flagged reviews are never auto-posted');
    // The internal vocabulary stays out, on this page as on /how-it-works.
    expect(html).not.toContain('unflagged');
  });

  it('labels the comparison region, self-labels each value cell for the stacked phone layout, and keeps the site footer present', () => {
    const html = renderPricing();

    // The matrix no longer scrolls horizontally at any width (it stacks ≤720px), so it
    // is neither focusable nor labelled as scrollable.
    expect(html).toContain('aria-label="Plan comparison"');
    expect(html).not.toMatch(/class="pr-matrix"[^>]*tabindex=/);
    expect(html).toContain('data-plan="Copilot"');
    expect(html).toContain('data-plan="Autopilot"');
    expect(html).toContain('class="rw-foot');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
  });

  it('renders the comparison matrix as a real table with scoped headers and spoken marks (M8)', () => {
    const html = renderPricing();

    // A <table> with explicit roles (the rows are CSS grids for the phone stack,
    // and a table part with a non-table display can lose its implicit role).
    expect(html).toMatch(/<table class="pr-matrix" aria-label="Plan comparison">/);
    expect(html).toMatch(/<th scope="col" class="pr-matrix-cell hdr first">Feature<\/th>/);
    // Feature + Copilot + Autopilot: three column headers, all scoped.
    expect(html.match(/<th scope="col"/g)).toHaveLength(3);
    expect(html).toMatch(/<th scope="col" class="pr-matrix-cell hdr [^"]*"><span class="pr-matrix-plan">.*?Copilot<\/span>/);
    // One <tbody> per section, headed by a rowgroup cell; every feature is a row header.
    expect(html.match(/<tbody>/g)).toHaveLength(4);
    expect(html.match(/<th scope="rowgroup" colSpan="3"/g)).toHaveLength(4);
    // 14 rows since the five-jobs pass (2026-09-06): Solicitor, the review QR,
    // the dashboard, and the request-batch autonomy row joined the matrix.
    expect(html.match(/<th scope="row" class="pr-matrix-cell first">/g)).toHaveLength(14);
    expect(html).not.toContain('pr-matrix-grid');
    expect(html).not.toMatch(/<div class="pr-matrix-cell/);

    // Marks are an aria-hidden glyph plus sr-only text — never an aria-label on a span.
    expect(html).toContain('<span class="pr-check-yes" aria-hidden="true">');
    expect(html).toContain('<span class="pr-check-no" aria-hidden="true"></span><span class="sr-only">Not included</span>');
    expect(html).toContain('<span class="sr-only">Included</span>');
    expect(html).not.toMatch(/aria-label="(Included|Not included)"/);
  });

  it('says what each plan does before a reply posts in plain words, and glosses the veto window once (M9)', () => {
    const html = renderPricing();

    expect(html).toContain('You approve everything');
    expect(html).toContain('You set the policy and the veto window');
    expect(html).toContain('Not needed: nothing posts until you approve it');
    expect(html).toContain('You choose 15 or 30 minutes');
    // The one gloss, on the row that names the term.
    expect(html.match(/class="pr-matrix-hint"/g)).toHaveLength(1);
    expect(html).toContain('A 15- or 30-minute pause after a reply clears the checks, when one tap still stops it.');
    // The internal vocabulary is gone.
    expect(html).not.toContain('Approval context');
    expect(html).not.toContain('Outside your policy');
    expect(html).not.toContain('Owner-set policy and veto window</th>');
  });
});
