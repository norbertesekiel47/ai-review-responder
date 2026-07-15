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
    expect(html).toContain('>Copilot</h2>');
    expect(html).toContain('>Autopilot</h2>');
    expect(html).toContain('<span class="pr-price-amt">29</span>');
    expect(html).toContain('<span class="pr-price-amt">69</span>');
    expect(html).toContain('$15/month per extra location');
    expect(html).toContain('$20/month per extra location');
    expect(html).not.toMatch(/Founders|Basic|Standard|Premium/);
  });

  it('renders both founding rates with list context and the lifetime lock', () => {
    const html = renderPricing({ founding: true });

    expect(html).toContain('<span class="pr-price-amt">19</span>');
    expect(html).toContain('<span class="pr-price-amt">49</span>');
    expect(html).toContain('$29 list');
    expect(html).toContain('$69 list');
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

  it('keeps unavailable Autopilot visible, disabled, and accessibly explained', () => {
    const html = renderPricing({ autopilot: false, selfServe: true });

    expect(html).toContain('Autopilot unavailable');
    expect(html).toMatch(/disabled="" aria-describedby="pricing-autopilot-unavailable"/);
    expect(html).toContain('safety runtime is closed. Copilot remains available');
    expect(html).toContain('href="/signup"');
  });

  it('states the shipped agent-team and autonomy boundary precisely', () => {
    const html = renderPricing();

    expect(html).toContain('Reply drafts personalized responses');
    expect(html).toContain('Guardian holds negative and flagged reviews');
    expect(html).toContain('Insights files your weekly review brief');
    expect(html).toContain('Owner approval required before every public response');
    expect(html).toContain('Only 4–5★ unflagged replies may post automatically');
    expect(html).toContain('Moderation, judge, and governor gates must all pass');
    expect(html).toContain('Negative and flagged reviews are never auto-posted');
  });

  it('keeps the two-column comparison keyboard reachable and the site footer present', () => {
    const html = renderPricing();

    expect(html).toContain('aria-label="Plan comparison, scroll horizontally to compare both plans"');
    expect(html).toMatch(/class="pr-matrix"[^>]*tabindex="0"/);
    expect(html).toContain('class="rw-foot');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
  });
});
