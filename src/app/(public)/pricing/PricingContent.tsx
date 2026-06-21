'use client';

import Link from 'next/link';
import { useId, useMemo, useReducer, useState, type CSSProperties, type ReactNode } from 'react';
import { LeadIntakeForm } from '@/components/sections/lead-intake/LeadIntakeForm';
import { SiteShell } from '@/components/ui/SiteShell';

type Billing = 'monthly' | 'annual';
type TierId = 'founders' | 'basic' | 'standard' | 'premium';
type TierIcon = 'spark' | 'solo' | 'growth' | 'locations';

interface Tier {
  id: TierId;
  name: string;
  tag: string;
  swatch: string;
  icon: TierIcon;
  monthly: number;
  annual: number;
  cta: string;
  ctaStyle: 'primary' | 'ghost';
  ctaDisabled?: boolean;
  ribbon?: string;
  features: { text: string; hl?: boolean }[];
}

const TIERS: Tier[] = [
  {
    id: 'founders',
    name: 'Founders',
    tag: 'Limited offer - locked-in pricing for early operators',
    swatch: 'linear-gradient(135deg, #F2C3B9, #F0DDD6)',
    icon: 'spark',
    monthly: 19,
    annual: 15,
    cta: 'Claim a spot',
    ctaStyle: 'primary',
    features: [
      { text: 'Everything in Standard', hl: true },
      { text: 'Locked-in founder pricing', hl: true },
      { text: 'Limited founder spots' },
      { text: 'Direct line to founders' },
      { text: 'Vote on the roadmap' },
    ],
  },
  {
    id: 'basic',
    name: 'Basic',
    tag: 'For the owner running it solo',
    swatch: 'linear-gradient(135deg, #D2E0D3, #F0EEEA)',
    icon: 'solo',
    monthly: 29,
    annual: 23,
    cta: 'Coming soon',
    ctaStyle: 'ghost',
    ctaDisabled: true,
    features: [
      { text: '1 Google Business Profile location', hl: true },
      { text: 'AI-drafted replies in your business voice' },
      { text: 'Email approval flow' },
      { text: "Responds in the reviewer's language" },
      { text: 'Basic dashboard access' },
      { text: 'Email support within 24 hours' },
    ],
  },
  {
    id: 'standard',
    name: 'Standard',
    tag: 'For growing businesses and small chains',
    swatch: 'linear-gradient(135deg, #97B3AE, #D2E0D3)',
    icon: 'growth',
    monthly: 79,
    annual: 63,
    cta: 'Coming soon',
    ctaStyle: 'ghost',
    ctaDisabled: true,
    ribbon: 'Recommended',
    features: [
      { text: '1 Google Business Profile location' },
      { text: 'Everything in Basic' },
      { text: 'Weekly and monthly review digest', hl: true },
      { text: 'Response analytics' },
      { text: 'Email approval plus 1 extra notification channel' },
      { text: 'Priority email support within 4 hours' },
    ],
  },
  {
    id: 'premium',
    name: 'Premium',
    tag: 'For multi-location operators and franchises',
    swatch: 'linear-gradient(135deg, #D6CBBF, #F0DDD6)',
    icon: 'locations',
    monthly: 199,
    annual: 159,
    cta: 'Coming soon',
    ctaStyle: 'ghost',
    ctaDisabled: true,
    features: [
      { text: 'Multi-location setup available', hl: true },
      { text: 'Email plus one mobile channel (SMS, Telegram, or WhatsApp)' },
      { text: 'Weekly and monthly review digest' },
      { text: 'Historical unanswered review backfill, up to 50 reviews before activation' },
      { text: 'Ranking tracking / search visibility reporting' },
      { text: 'Priority setup and support' },
      { text: 'Dedicated success manager' },
    ],
  },
];

type MatrixRow =
  | { section: string }
  | { label: string; values: (string | boolean)[] };

const MATRIX: MatrixRow[] = [
  { section: 'Responses & locations' },
  { label: 'Google Business Profile locations', values: ['1', '1', '1', 'Multi-location setup available'] },
  { label: 'Price lock', values: ['Locked in', false, false, false] },

  { section: 'AI & brand voice' },
  { label: 'AI-drafted replies in your business voice', values: [true, true, true, true] },
  { label: "Responds in the reviewer's language", values: [true, true, true, true] },
  { label: 'Brand voice setup', values: ['Standard', 'Standard', 'Expanded', 'Priority setup'] },
  { label: 'Regenerate drafts', values: [true, true, true, true] },

  { section: 'Team & workflow' },
  { label: 'Dashboard access', values: ['Standard', 'Basic', 'Standard', 'Advanced'] },
  { label: 'Email approval flow', values: [true, true, true, true] },
  { label: 'Extra notification channel', values: [true, false, true, true] },

  { section: 'Insights & integrations' },
  { label: 'Response analytics', values: [true, false, true, true] },
  { label: 'Weekly and monthly review digest', values: [true, false, true, true] },
  { label: 'Historical unanswered review backfill', values: [false, false, false, true] },
  { label: 'Ranking / search visibility reporting', values: [false, false, false, true] },

  { section: 'Support' },
  { label: 'Support response time', values: ['Direct line', '24 hours', '4 hours', 'Priority setup'] },
  { label: 'Vote on the roadmap', values: [true, false, false, false] },
  { label: 'Dedicated success manager', values: [false, false, false, true] },
];

// Sticky positioning for the horizontally-scrollable comparison matrix. The
// first column pins on the X axis (the real scroll axis under 720px), the
// header row pins on the Y axis; the corner cell pins on both. Opaque
// backgrounds keep scrolling cells from showing through the pinned column.
const MATRIX_STICKY_FIRST_COL: CSSProperties = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  background: '#fff',
};
const MATRIX_STICKY_HEADER: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
};
const MATRIX_STICKY_CORNER: CSSProperties = {
  position: 'sticky',
  left: 0,
  top: 0,
  zIndex: 3,
  background: '#f4f2ee',
};

const FAQ_ITEMS = [
  { q: 'How does the 14-day trial work?', a: 'Connect your Google Business Profile in under two minutes. We start drafting replies immediately — you approve each one by email. No charge until day 15, and you can cancel anytime with one click.' },
  { q: 'Can I change plans later?', a: 'Yes. Upgrade, downgrade, or cancel any time from the settings page. Plan changes apply immediately and are prorated.' },
  { q: 'Do I have to approve every reply?', a: "By default, yes — every reply waits for your one-tap approval, so you stay in control of your brand voice. You can optionally enable auto-approval (off by default) if you later want hands-off posting. Approval takes one tap on your phone." },
  { q: 'Is there a contract?', a: 'No. Monthly plans are month-to-month; annual plans are paid upfront for the year. Cancel any time — your access continues through the end of the paid period and you are not charged again. Annual plans are not refunded for unused time.' },
];

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 13l4 4L19 7" />
  </svg>
);

const PLAN_ICON_COMMON = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function PlanIcon({ icon }: { icon: TierIcon }) {
  if (icon === 'spark') {
    return (
      <svg viewBox="0 0 24 24" {...PLAN_ICON_COMMON}>
        <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
        <path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8L18 16z" />
      </svg>
    );
  }

  if (icon === 'solo') {
    return (
      <svg viewBox="0 0 24 24" {...PLAN_ICON_COMMON}>
        <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
        <path d="M5 21a7 7 0 0 1 14 0" />
      </svg>
    );
  }

  if (icon === 'growth') {
    return (
      <svg viewBox="0 0 24 24" {...PLAN_ICON_COMMON}>
        <path d="M4 19V5" />
        <path d="M4 19h16" />
        <path d="M7 15l4-4 3 3 5-7" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" {...PLAN_ICON_COMMON}>
      <path d="M4 21V7l6-3 6 3v14" />
      <path d="M16 10l4 2v9" />
      <path d="M8 10h2M8 14h2M8 18h2" />
    </svg>
  );
}

function PlanCard({ tier, billing, isFeatured, onSelect }: { tier: Tier; billing: Billing; isFeatured: boolean; onSelect: () => void }) {
  const price = billing === 'annual' ? tier.annual : tier.monthly;
  return (
    <div className={`pr-plan ${isFeatured ? 'is-featured' : ''}`}>
      <div className="pr-plan-hatch" aria-hidden>
        {Array.from({ length: 14 }).map((_, i) => (
          <span key={i} />
        ))}
      </div>
      {isFeatured && tier.ribbon && <div className="pr-ribbon">{tier.ribbon}</div>}

      <div className="pr-plan-swatch" style={{ background: tier.swatch }} aria-hidden>
        <PlanIcon icon={tier.icon} />
      </div>
      <p className="pr-plan-name">{tier.name}</p>
      <p className="pr-plan-tag">{tier.tag}</p>

      <div className="pr-price">
        <span className="pr-price-currency">$</span>
        <span className="pr-price-amt">{price}</span>
        <span className="pr-price-per">/ month</span>
      </div>
      <p className="pr-price-foot">
        {billing === 'annual'
          ? `Billed annually ($${price * 12}/yr) - 20% off $${tier.monthly}/mo`
          : 'Billed monthly, cancel anytime'}
      </p>

      {tier.ctaDisabled ? (
        <button
          type="button"
          className={`pr-plan-cta ${tier.ctaStyle} is-disabled`}
          disabled
          aria-disabled="true"
        >
          {tier.cta}
        </button>
      ) : (
        <Link
          href="/book-a-demo"
          className={`pr-plan-cta ${tier.ctaStyle}`}
          onClick={onSelect}
        >
          {tier.cta}
        </Link>
      )}

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

interface RoiState {
  reviews: number;
  minutes: number;
  rate: number;
}

type RoiAction =
  | { type: 'setReviews'; value: number }
  | { type: 'setMinutes'; value: number }
  | { type: 'setRate'; value: number };

const roiInitialState: RoiState = {
  reviews: 80,
  minutes: 8,
  rate: 45,
};

function roiReducer(state: RoiState, action: RoiAction): RoiState {
  switch (action.type) {
    case 'setReviews':
      return { ...state, reviews: action.value };
    case 'setMinutes':
      return { ...state, minutes: action.value };
    case 'setRate':
      return { ...state, rate: action.value };
  }
}

export function PricingContent({ selfServeEnabled = false }: { selfServeEnabled?: boolean }) {
  const [billing, setBilling] = useState<Billing>('annual');
  const [featured, setFeatured] = useState<TierId>('standard');

  // ROI calculator
  const [roi, dispatchRoi] = useReducer(roiReducer, roiInitialState);
  const { reviews, minutes, rate } = roi;
  const monthlyHours = useMemo(() => +(reviews * minutes / 60).toFixed(1), [reviews, minutes]);
  const monthlyValue = useMemo(() => Math.round(monthlyHours * rate), [monthlyHours, rate]);
  const yearlyValue = monthlyValue * 12;

  const [openFaq, setOpenFaq] = useState(0);
  const faqBaseId = useId();

  const isAnnual = billing === 'annual';
  const headerFeatured = (id: TierId) => id === featured;

  return (
    <SiteShell scope="pr-page" selfServeEnabled={selfServeEnabled}>

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
            <div
              className={`pr-toggle ${isAnnual ? 'is-annual' : 'is-monthly'}`}
            >
              <div className="pr-toggle-thumb" />
              <button
                type="button"
                onClick={() => setBilling('monthly')}
                className={!isAnnual ? 'is-active' : ''}
                aria-pressed={!isAnnual}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setBilling('annual')}
                className={isAnnual ? 'is-active' : ''}
                aria-pressed={isAnnual}
              >
                Annual <span className="pr-save-badge">Save 20%</span>
              </button>
            </div>
            <p
              className="pr-toggle-note"
              style={{
                marginTop: 10,
                textAlign: 'center',
                font: '500 12px var(--rw-font-body)',
                letterSpacing: '0.04em',
                color: '#557069',
              }}
            >
              All prices in USD
            </p>
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
                  <h2>See what you get back before you pick a plan</h2>
                </div>
              </div>
              <div className="pr-calc-grid">
                <div>
                  <SliderRow label="Reviews per month" value={reviews} display={String(reviews)} valueText={`${reviews} reviews`} min={10} max={500} step={10} onChange={(value) => dispatchRoi({ type: 'setReviews', value })} />
                  <SliderRow label="Minutes to craft each reply" value={minutes} display={`${minutes} min`} valueText={`${minutes} minutes`} min={2} max={20} step={1} onChange={(value) => dispatchRoi({ type: 'setMinutes', value })} />
                  <SliderRow label="Your hourly rate" value={rate} display={`$${rate}/hr`} valueText={`$${rate} per hour`} min={20} max={150} step={5} onChange={(value) => dispatchRoi({ type: 'setRate', value })} />
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
            <section
              className="pr-matrix"
              aria-label="Plan comparison, scroll horizontally to compare all plans"
              // Intentional: makes the horizontally-scrollable matrix keyboard-focusable so keyboard-only users can scroll it (WCAG 2.1.1).
              // react-doctor-disable-next-line react-doctor/no-noninteractive-tabindex
              tabIndex={0}
            >
              <div className="pr-matrix-grid">
                <div className="pr-matrix-row">
                  <div className="pr-matrix-cell hdr first" style={MATRIX_STICKY_CORNER}>Feature</div>
                  <div className={`pr-matrix-cell hdr ${headerFeatured('founders') ? 'featured' : ''}`} style={MATRIX_STICKY_HEADER}>Founders</div>
                  <div className={`pr-matrix-cell hdr ${headerFeatured('basic') ? 'featured' : ''}`} style={MATRIX_STICKY_HEADER}>Basic</div>
                  <div className={`pr-matrix-cell hdr ${headerFeatured('standard') ? 'featured' : ''}`} style={MATRIX_STICKY_HEADER}>Standard</div>
                  <div className={`pr-matrix-cell hdr ${headerFeatured('premium') ? 'featured' : ''}`} style={MATRIX_STICKY_HEADER}>Premium</div>
                </div>
                {MATRIX.map((row) => {
                  if ('section' in row) {
                    return (
                      <div key={`section-${row.section}`} className="pr-matrix-row">
                        <div className="pr-matrix-cell section first">{row.section}</div>
                      </div>
                    );
                  }
                  return (
                    <div key={`feature-${row.label}`} className="pr-matrix-row">
                      <div className="pr-matrix-cell first" style={MATRIX_STICKY_FIRST_COL}>{row.label}</div>
                      <MatrixCell v={row.values[0] ?? ''} featured={headerFeatured('founders')} />
                      <MatrixCell v={row.values[1] ?? ''} featured={headerFeatured('basic')} />
                      <MatrixCell v={row.values[2] ?? ''} featured={headerFeatured('standard')} />
                      <MatrixCell v={row.values[3] ?? ''} featured={headerFeatured('premium')} />
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          {/* FAQ */}
          <div className="pr-faq-wrap">
            <div className="pr-faq-head">
              <h2>Frequently asked</h2>
              <p>Everything you need before you pick a plan.</p>
            </div>
            {FAQ_ITEMS.map((item, i) => {
              const isOpen = openFaq === i;
              const panelId = `${faqBaseId}-faq-panel-${i}`;
              const buttonId = `${faqBaseId}-faq-button-${i}`;
              return (
                <div key={item.q} className={`pr-faq-item ${isOpen ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    id={buttonId}
                    className="pr-faq-q"
                    onClick={() => setOpenFaq(isOpen ? -1 : i)}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                  >
                    <span>{item.q}</span>
                    <span className="pr-faq-icon" aria-hidden>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </span>
                  </button>
                  <div
                    className="pr-faq-a"
                    id={panelId}
                    role="region"
                    aria-labelledby={buttonId}
                  >
                    <div className="pr-faq-a-inner">{item.a}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* CTA */}
          <section id="pricing-waitlist" className="pr-cta">
            <h2>Join the early access waitlist.</h2>
            <p>
              Tell us about your business and we&apos;ll reach out when early access opens for
              your area.
            </p>
            <div className="w-full max-w-md">
              <LeadIntakeForm intent="waitlist" source="pricing" tone="onTeal" />
            </div>
          </section>
    </SiteShell>
  );
}

function SliderRow({
  label,
  value,
  display,
  valueText,
  min,
  max,
  step,
  onChange,
}: {
  label: ReactNode;
  value: number;
  display: string;
  valueText: string;
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
        className="pr-slider focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#557069]"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={typeof label === 'string' ? label : undefined}
      />
    </div>
  );
}
