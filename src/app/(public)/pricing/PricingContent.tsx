'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { MarqueeBackground } from '@/components/ui/MarqueeBackground';
import { SiteNav } from '@/components/ui/SiteNav';

type Billing = 'monthly' | 'annual';
type TierId = 'founders' | 'basic' | 'standard' | 'premium';

interface Tier {
  id: TierId;
  name: string;
  tag: string;
  swatch: string;
  monthly: number;
  annual: number;
  cta: string;
  ctaStyle: 'primary' | 'ghost';
  ribbon?: string;
  slotsLeft?: number;
  slotsTotal?: number;
  features: { text: string; hl?: boolean }[];
}

const TIERS: Tier[] = [
  {
    id: 'founders',
    name: 'Founders',
    tag: 'Limited offer — locked-in pricing for life',
    swatch: 'linear-gradient(135deg, #F2C3B9, #F0DDD6)',
    monthly: 19,
    annual: 15,
    slotsLeft: 7,
    slotsTotal: 20,
    cta: 'Claim a spot',
    ctaStyle: 'primary',
    features: [
      { text: 'Up to 150 review responses / month', hl: true },
      { text: 'Lifetime price lock — never goes up', hl: true },
      { text: '2 Google Business Profile locations' },
      { text: 'Premium AI model (Claude Sonnet)' },
      { text: 'Custom brand-voice training' },
      { text: 'Direct line to the founders' },
      { text: 'Vote on the roadmap' },
    ],
  },
  {
    id: 'basic',
    name: 'Basic',
    tag: 'For the owner running it solo',
    swatch: 'linear-gradient(135deg, #D2E0D3, #F0EEEA)',
    monthly: 29,
    annual: 24,
    cta: 'Start 14-day trial',
    ctaStyle: 'ghost',
    features: [
      { text: 'Up to 50 review responses / month', hl: true },
      { text: '1 Google Business Profile location' },
      { text: 'AI-drafted replies in your voice' },
      { text: 'Email approval flow' },
      { text: 'Standard brand-voice training' },
      { text: 'Email support within 24 hours' },
    ],
  },
  {
    id: 'standard',
    name: 'Standard',
    tag: 'For growing businesses and small chains',
    swatch: 'linear-gradient(135deg, #97B3AE, #D2E0D3)',
    monthly: 79,
    annual: 64,
    cta: 'Start 14-day trial',
    ctaStyle: 'ghost',
    ribbon: 'Most popular',
    features: [
      { text: 'Up to 300 review responses / month', hl: true },
      { text: 'Up to 5 locations' },
      { text: 'Premium AI model (Claude Sonnet)' },
      { text: 'Custom brand-voice training from your 10 best replies' },
      { text: 'Response analytics & weekly digest' },
      { text: 'Team seats — up to 3 owners' },
      { text: 'Priority email support within 4 hours' },
    ],
  },
  {
    id: 'premium',
    name: 'Premium',
    tag: 'For multi-location operators and franchises',
    swatch: 'linear-gradient(135deg, #D6CBBF, #F0DDD6)',
    monthly: 199,
    annual: 159,
    cta: 'Start 14-day trial',
    ctaStyle: 'ghost',
    features: [
      { text: 'Unlimited review responses', hl: true },
      { text: 'Unlimited locations with per-location voice' },
      { text: 'Premium AI model with fine-tuning' },
      { text: 'Multi-brand support & role-based access' },
      { text: 'API access & CSV export' },
      { text: 'Dedicated success manager' },
      { text: 'SLA-backed response time' },
    ],
  },
];

type MatrixRow =
  | { section: string }
  | { label: string; values: (string | boolean)[] };

const MATRIX: MatrixRow[] = [
  { section: 'Responses & locations' },
  { label: 'Monthly review responses', values: ['150', '50', '300', 'Unlimited'] },
  { label: 'Google Business Profile locations', values: ['2', '1', '5', 'Unlimited'] },
  { label: 'Per-location brand voice', values: [false, false, true, true] },
  { label: 'Lifetime price lock', values: [true, false, false, false] },

  { section: 'AI & brand voice' },
  { label: 'AI model', values: ['Premium', 'Standard', 'Premium', 'Premium + fine-tune'] },
  { label: 'Custom voice training', values: ['Standard', 'Standard', 'From your 10 best replies', 'Continuous fine-tuning'] },
  { label: 'Regenerate with feedback', values: [true, true, true, true] },

  { section: 'Team & workflow' },
  { label: 'Team seats', values: ['2', '1', '3', 'Unlimited'] },
  { label: 'Email approval flow', values: [true, true, true, true] },
  { label: 'Role-based access', values: [false, false, false, true] },

  { section: 'Insights & integrations' },
  { label: 'Response analytics', values: [true, false, true, true] },
  { label: 'Weekly digest email', values: [true, false, true, true] },
  { label: 'API access & CSV export', values: [false, false, false, true] },

  { section: 'Support' },
  { label: 'Support response time', values: ['Direct line', '24 hours', '4 hours', 'SLA-backed'] },
  { label: 'Vote on the roadmap', values: [true, false, false, false] },
  { label: 'Dedicated success manager', values: [false, false, false, true] },
];

const FAQ_ITEMS = [
  { q: 'How does the 14-day trial work?', a: 'Connect your Google Business Profile in under two minutes. We start drafting replies immediately — you approve each one by email. No charge until day 15, and you can cancel anytime with one click.' },
  { q: 'Can I change plans later?', a: 'Yes. Upgrade, downgrade, or cancel any time from the settings page. Upgrades apply instantly; downgrades take effect at the end of your current billing cycle.' },
  { q: 'What counts as a "review response"?', a: 'Any reply we draft, whether you approve, edit, or regenerate it. If you regenerate a draft three times, that counts as one response — not three.' },
  { q: 'Do I have to approve every reply?', a: "Yes. That's the whole point — you stay in control of your brand voice. Approval takes one tap on your phone. Owners typically clear a week's worth of reviews in under five minutes." },
  { q: 'What happens if I go over my monthly limit?', a: "We'll keep drafting so nothing falls through the cracks, and nudge you to upgrade. We never block responses without warning." },
  { q: 'Is there a contract?', a: 'No. Monthly plans are month-to-month. Annual plans lock in a 20% discount but can still be cancelled — we refund the unused months, pro-rated.' },
];

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 13l4 4L19 7" />
  </svg>
);

function PlanCard({ tier, billing, isFeatured, onSelect }: { tier: Tier; billing: Billing; isFeatured: boolean; onSelect: () => void }) {
  const price = billing === 'annual' ? tier.annual : tier.monthly;
  return (
    <div className={`pr-plan ${isFeatured ? 'is-featured' : ''}`}>
      <div className="pr-plan-hatch" aria-hidden>
        {Array.from({ length: 14 }).map((_, i) => (
          <span key={i} />
        ))}
      </div>
      {isFeatured && <div className="pr-ribbon">{tier.ribbon || 'Most popular'}</div>}

      <div className="pr-plan-swatch" style={{ background: tier.swatch }} aria-hidden />
      <p className="pr-plan-name">{tier.name}</p>
      <p className="pr-plan-tag">{tier.tag}</p>

      {tier.slotsLeft != null && tier.slotsTotal != null && (
        <div className="pr-slots">
          <div className="pr-slots-top">
            <span className="pr-slots-lbl">Spots remaining</span>
            <span className="pr-slots-val">
              {tier.slotsLeft} of {tier.slotsTotal}
            </span>
          </div>
          <div className="pr-slots-bar">
            <div
              className="pr-slots-fill"
              style={{ width: `${(tier.slotsLeft / tier.slotsTotal) * 100}%` }}
            />
          </div>
        </div>
      )}

      <div className="pr-price">
        <span className="pr-price-currency">$</span>
        <span className="pr-price-amt">{price}</span>
        <span className="pr-price-per">/ month</span>
      </div>
      <p className="pr-price-foot">
        {billing === 'annual'
          ? `Billed annually ($${price * 12}/yr)`
          : 'Billed monthly, cancel anytime'}
      </p>

      <Link
        href="/book-a-demo"
        className={`pr-plan-cta ${tier.ctaStyle}`}
        onClick={onSelect}
      >
        {tier.cta}
      </Link>

      <div className="pr-divider" />
      <p className="pr-includes-lbl">What&apos;s included</p>
      <ul className="pr-feature-list">
        {tier.features.map((f) => (
          <li key={f.text}>
            <span
              className="check"
              style={{ background: isFeatured ? 'var(--rw-teal)' : 'rgba(151,179,174,0.75)' }}
            >
              <CheckIcon />
            </span>
            <span className={f.hl ? 'hl' : undefined}>{f.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MatrixCell({ v, featured }: { v: string | boolean; featured: boolean }) {
  const cls = `pr-matrix-cell num ${featured ? 'featured' : ''}`;
  if (v === true)
    return (
      <div className={cls}>
        <span className="pr-check-yes">
          <CheckIcon />
        </span>
      </div>
    );
  if (v === false)
    return (
      <div className={cls}>
        <span className="pr-check-no" />
      </div>
    );
  return <div className={cls}>{v}</div>;
}

export function PricingContent({ selfServeEnabled = false }: { selfServeEnabled?: boolean }) {
  const [billing, setBilling] = useState<Billing>('annual');
  const [featured, setFeatured] = useState<TierId>('standard');

  // ROI calculator
  const [reviews, setReviews] = useState(80);
  const [minutes, setMinutes] = useState(8);
  const [rate, setRate] = useState(45);
  const monthlyHours = useMemo(() => +(reviews * minutes / 60).toFixed(1), [reviews, minutes]);
  const monthlyValue = useMemo(() => Math.round(monthlyHours * rate), [monthlyHours, rate]);
  const yearlyValue = monthlyValue * 12;

  const [openFaq, setOpenFaq] = useState(0);

  const isAnnual = billing === 'annual';
  const headerFeatured = (id: TierId) => id === featured;

  return (
    <div className="pr-page">
      <MarqueeBackground />

      <div className="rw-island-wrap">
        <div className="rw-island">
          <SiteNav selfServeEnabled={selfServeEnabled} />

          {/* Hero */}
          <section className="pr-hero">
            <p className="pr-eyebrow">Pricing</p>
            <h1>Every reply handled. One honest price.</h1>
            <p className="sub">
              Pay for what you actually use. Switch plans anytime. Cancel whenever.
            </p>
          </section>

          {/* Billing toggle */}
          <div className="pr-toggle-wrap">
            <div className="pr-toggle">
              <div
                className="pr-toggle-thumb"
                style={{
                  left: isAnnual ? 'calc(50% - 3px)' : '6px',
                  width: 'calc(50% - 3px)',
                }}
              />
              <button
                type="button"
                onClick={() => setBilling('monthly')}
                className={!isAnnual ? 'is-active' : ''}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setBilling('annual')}
                className={isAnnual ? 'is-active' : ''}
              >
                Annual <span className="pr-save-badge">Save 20%</span>
              </button>
            </div>
          </div>

          {/* Plan grid */}
          <div className="pr-plans">
            {TIERS.map((t) => (
              <PlanCard
                key={t.id}
                tier={t}
                billing={billing}
                isFeatured={t.id === featured}
                onSelect={() => setFeatured(t.id)}
              />
            ))}
          </div>
          <div className="pr-below-cards">
            <div className="pr-guarantee">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
              <span>14-day free trial · No credit card · Cancel anytime</span>
            </div>
          </div>

          {/* ROI calculator */}
          <div className="pr-calc-wrap">
            <div className="pr-calc">
              <div className="pr-calc-head">
                <div>
                  <p className="pr-calc-eyebrow">How much are reviews costing you?</p>
                  <h2>See what you get back — before you pick a plan</h2>
                </div>
              </div>
              <div className="pr-calc-grid">
                <div>
                  <SliderRow label="Reviews per month" value={reviews} display={String(reviews)} min={10} max={500} step={10} onChange={setReviews} />
                  <SliderRow label="Minutes to craft each reply" value={minutes} display={`${minutes} min`} min={2} max={20} step={1} onChange={setMinutes} />
                  <SliderRow label="Your hourly rate" value={rate} display={`$${rate}/hr`} min={20} max={150} step={5} onChange={setRate} />
                </div>
                <div className="pr-calc-readout">
                  <div className="pr-readout-row">
                    <span className="pr-readout-lbl">Hours spent monthly</span>
                    <span className="pr-readout-val">{monthlyHours} hrs</span>
                  </div>
                  <div className="pr-readout-row">
                    <span className="pr-readout-lbl">Monthly cost of your time</span>
                    <span className="pr-readout-val">${monthlyValue.toLocaleString()}</span>
                  </div>
                  <div className="pr-readout-total">
                    <span className="pr-readout-total-lbl">What RepWorth saves you / year</span>
                    <span className="pr-readout-total-val">${yearlyValue.toLocaleString()}</span>
                  </div>
                  <p className="pr-readout-foot">
                    Assumes 95% automation · Approve or edit in under 30 seconds
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Comparison matrix */}
          <div className="pr-matrix-wrap">
            <div className="pr-matrix-head">
              <h2>Compare every detail</h2>
              <p>The full feature list, side-by-side. No asterisks, no gotchas.</p>
            </div>
            <div className="pr-matrix">
              <div className="pr-matrix-grid">
                <div className="pr-matrix-row">
                  <div className="pr-matrix-cell hdr first">Feature</div>
                  <div className={`pr-matrix-cell hdr ${headerFeatured('founders') ? 'featured' : ''}`}>Founders</div>
                  <div className={`pr-matrix-cell hdr ${headerFeatured('basic') ? 'featured' : ''}`}>Basic</div>
                  <div className={`pr-matrix-cell hdr ${headerFeatured('standard') ? 'featured' : ''}`}>Standard</div>
                  <div className={`pr-matrix-cell hdr ${headerFeatured('premium') ? 'featured' : ''}`}>Premium</div>
                </div>
                {MATRIX.map((row, i) => {
                  if ('section' in row) {
                    return (
                      <div key={`s-${i}`} className="pr-matrix-row">
                        <div className="pr-matrix-cell section first">{row.section}</div>
                      </div>
                    );
                  }
                  return (
                    <div key={`r-${i}`} className="pr-matrix-row">
                      <div className="pr-matrix-cell first">{row.label}</div>
                      <MatrixCell v={row.values[0] ?? ''} featured={headerFeatured('founders')} />
                      <MatrixCell v={row.values[1] ?? ''} featured={headerFeatured('basic')} />
                      <MatrixCell v={row.values[2] ?? ''} featured={headerFeatured('standard')} />
                      <MatrixCell v={row.values[3] ?? ''} featured={headerFeatured('premium')} />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* FAQ */}
          <div className="pr-faq-wrap">
            <div className="pr-faq-head">
              <h2>Frequently asked</h2>
              <p>Everything you need before you pick a plan.</p>
            </div>
            {FAQ_ITEMS.map((item, i) => {
              const isOpen = openFaq === i;
              return (
                <div key={item.q} className={`pr-faq-item ${isOpen ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    className="pr-faq-q"
                    onClick={() => setOpenFaq(isOpen ? -1 : i)}
                    aria-expanded={isOpen}
                  >
                    <span>{item.q}</span>
                    <span className="pr-faq-icon" aria-hidden>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </span>
                  </button>
                  <div className="pr-faq-a">
                    <div className="pr-faq-a-inner">{item.a}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* CTA */}
          <section className="pr-cta">
            <h2>Book a Demo — see your own reviews answered in 60 seconds</h2>
            <p>15 minutes. No commitment. No credit card.</p>
            <Link href="/book-a-demo" className="pr-cta-btn">
              Book My Demo
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}

function SliderRow({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: ReactNode;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="pr-slider-row">
      <div className="pr-slider-row-top">
        <span className="pr-slider-lbl">{label}</span>
        <span className="pr-slider-val">{display}</span>
      </div>
      <input
        className="pr-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={typeof label === 'string' ? label : undefined}
      />
    </div>
  );
}
