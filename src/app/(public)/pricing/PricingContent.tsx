'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { LeadIntakeForm } from '@/components/sections/lead-intake/LeadIntakeForm';
import type { LeadPlanInterest } from '@/components/sections/lead-intake/LeadIntakeForm';
import { SiteShell } from '@/components/ui/SiteShell';
import type {
  PlanPresentationViewModel,
  PlanPriceView,
} from '@/lib/payments/plan-presentation';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';

interface PlanCopy {
  tier: SubscriptionTierValue;
  name: string;
  tag: string;
  icon: 'copilot' | 'autopilot';
  features: readonly string[];
}

const PLANS: readonly PlanCopy[] = [
  {
    tier: 'copilot',
    name: 'Copilot',
    tag: 'The agent team prepares every public action for your approval.',
    icon: 'copilot',
    features: [
      'Reply drafts personalized responses in your business voice',
      'Guardian holds negative and flagged reviews for owner attention',
      'Insights files your weekly review brief',
      'Owner approval required before every public response',
      'Negative reviews are never auto-posted',
    ],
  },
  {
    tier: 'autopilot',
    name: 'Autopilot',
    tag: 'The same agent team may act inside the rules you set.',
    icon: 'autopilot',
    features: [
      'Everything in Copilot',
      'Only 4–5★ unflagged replies may post automatically',
      'Owner-set policy and veto window remain in control',
      'Moderation, judge, and governor gates must all pass',
      'Negative and flagged reviews are never auto-posted',
    ],
  },
];

type MatrixRow =
  | { section: string }
  | { label: string; values: readonly [string | boolean, string | boolean] };

const MATRIX: readonly MatrixRow[] = [
  { section: 'Agent team' },
  { label: 'Reply drafts personalized responses', values: [true, true] },
  { label: 'Guardian holds negative and flagged reviews', values: [true, true] },
  { label: 'Insights files a weekly brief', values: [true, true] },
  { section: 'Public actions' },
  { label: 'Owner approval required', values: ['Every response', 'Outside policy'] },
  { label: 'Eligible automatic posting', values: [false, '4–5★, unflagged only'] },
  { label: 'Negative reviews auto-posted', values: [false, false] },
  { section: 'Safety controls' },
  { label: 'Owner-set policy and veto window', values: ['Approval context', true] },
  { label: 'Moderation protects every draft', values: [true, true] },
  { label: 'Judge and governor required for eligible autonomy', values: [false, true] },
  { section: 'Locations' },
  { label: 'Included locations', values: ['1', '1'] },
];

const BASE_FAQS = [
  {
    q: 'Can I change plans later?',
    a: 'Yes. You can change plans from Billing. Eligible plan changes are previewed first and Stripe applies any required proration.',
  },
  {
    q: 'What can Autopilot post without approval?',
    a: 'Only 4–5★ unflagged replies that fit your owner-set policy may post after the veto window and after moderation, judge, and governor safeguards pass. Negative reviews are never auto-posted.',
  },
  {
    q: 'Is there a contract?',
    a: 'RepWorth plans are month-to-month and renew each month until cancelled.',
  },
] as const;

const PLAN_PICK_OPTIONS: readonly { value: LeadPlanInterest | null; label: string }[] = [
  { value: 'copilot', label: 'Copilot' },
  { value: 'autopilot', label: 'Autopilot' },
  { value: null, label: 'Not sure yet' },
];

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 13l4 4L19 7" />
  </svg>
);

function PlanIcon({ icon }: { icon: PlanCopy['icon'] }) {
  return icon === 'copilot' ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" />
      <path d="m8 12 2.3 2.3L16 9" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <circle cx="12" cy="12" r="5" />
      <path d="m10 12 1.3 1.3L14.5 10" />
    </svg>
  );
}

function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

function PlanCard({
  plan,
  price,
  priceVariant,
  purchasable,
  autopilotOpen,
  selfServeEnabled,
  onPlanInterest,
}: {
  plan: PlanCopy;
  price: PlanPriceView;
  priceVariant: PlanPresentationViewModel['priceVariant'];
  purchasable: boolean;
  autopilotOpen: boolean;
  selfServeEnabled: boolean;
  onPlanInterest: (plan: LeadPlanInterest) => void;
}) {
  // Emphasis follows purchasability, never a hardcoded favourite: the featured card
  // is the most-autonomous tier you can actually get today. While Autopilot is closed
  // it wears a quiet "Opening soon" badge and Copilot carries the primary action —
  // the ribboned, tinted card used to be the one you could not buy.
  const isAutopilot = plan.tier === 'autopilot';
  const featured = isAutopilot && autopilotOpen;
  const primary = autopilotOpen ? isAutopilot : !isAutopilot;
  const ctaLabel = selfServeEnabled
    ? `Choose ${plan.name}`
    : `Join the ${plan.name} waitlist`;

  return (
    <article className={`pr-plan ${featured ? 'is-featured' : ''}`}>
      <div className="pr-plan-hatch" aria-hidden>
        {Array.from({ length: 14 }).map((_, index) => <span key={index} />)}
      </div>
      {featured && <div className="pr-ribbon">More autonomy</div>}
      {isAutopilot && !autopilotOpen && <div className="pr-ribbon is-soon">Opening soon</div>}
      <div className={`pr-plan-swatch is-${plan.icon}`} aria-hidden>
        <PlanIcon icon={plan.icon} />
      </div>
      <h2 className="pr-plan-name">{plan.name}</h2>
      <p className="pr-plan-tag">{plan.tag}</p>

      <div className="pr-price">
        <span className="pr-price-currency">$</span>
        <span className="pr-price-amt">{formatDollars(price.basePriceCents)}</span>
        <span className="pr-price-per">/ month</span>
      </div>
      {priceVariant === 'founding' ? (
        <p className="pr-price-foot">
          Founding rate locked for the account&apos;s life.{' '}
          <span className="pr-list-price">${formatDollars(price.listBasePriceCents)} list</span>
        </p>
      ) : (
        <p className="pr-price-foot">Monthly billing. Cancel anytime.</p>
      )}
      <p className="pr-overage-price">
        One location included · ${formatDollars(price.locationsOveragePriceCents)}/month per extra location
      </p>

      {purchasable ? (
        <Link
          href={selfServeEnabled ? '/signup' : '#pricing-waitlist'}
          className={`pr-plan-cta ${primary ? 'primary' : 'ghost'}`}
          onClick={() => onPlanInterest(plan.tier)}
        >
          {ctaLabel}
        </Link>
      ) : selfServeEnabled ? (
        // No door to offer here (a signed-up owner switches plans in-product), so
        // no fake button: plain text says what is true and what to do now.
        <p className="pr-plan-soon">
          Not open yet: we are finishing its safety checks. Start on Copilot now and switch
          when Autopilot opens.
        </p>
      ) : (
        <>
          <Link
            href="#pricing-waitlist"
            className="pr-plan-cta ghost"
            onClick={() => onPlanInterest('autopilot')}
          >
            Tell me when Autopilot opens
          </Link>
          <p className="pr-plan-soon">
            Not open yet: we are finishing its safety checks. Copilot is taking waitlist
            sign-ups now.
          </p>
        </>
      )}

      <div className="pr-divider" />
      <p className="pr-includes-lbl">What&apos;s included</p>
      <ul className="pr-feature-list">
        {plan.features.map((feature) => (
          <li key={feature}>
            <span className="check"><CheckIcon /></span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

// `data-plan` feeds the per-cell plan label that pricing.css shows on phones, where the
// header row is hidden and each row stacks as label → Copilot value → Autopilot value.
function MatrixCell({ value, plan, featured }: { value: string | boolean; plan: string; featured: boolean }) {
  const className = `pr-matrix-cell num ${featured ? 'featured' : ''}`;
  if (value === true) {
    return <div className={className} data-plan={plan}><span className="pr-check-yes" aria-label="Included"><CheckIcon /></span></div>;
  }
  if (value === false) {
    return <div className={className} data-plan={plan}><span className="pr-check-no" aria-label="Not included" /></div>;
  }
  return <div className={className} data-plan={plan}>{value}</div>;
}

export function PricingContent({
  viewModel,
  selfServeEnabled = false,
}: {
  viewModel: PlanPresentationViewModel;
  selfServeEnabled?: boolean;
}) {
  const [openFaq, setOpenFaq] = useState(0);
  // Which tier the visitor asked about via a card door; the waitlist form sends it
  // with the lead, and the chooser above the form keeps it visible and changeable.
  const [planInterest, setPlanInterest] = useState<LeadPlanInterest | null>(null);
  const faqBaseId = useId();
  const planPickId = useId();
  const autopilotOpen = viewModel.purchasable.autopilot;
  const faqs = viewModel.trialEnabled
    ? [
        {
          q: 'How does the 30-day trial work?',
          a: 'Choose a plan explicitly and provide a card up front. Your 30-day trial starts through Stripe, and monthly billing for that plan begins after the trial unless you cancel.',
        },
        ...BASE_FAQS,
      ]
    : BASE_FAQS;

  return (
    <SiteShell scope="pr-page" selfServeEnabled={selfServeEnabled}>
      <section className="pr-hero">
        <p className="pr-eyebrow">Pricing</p>
        <h1>Choose how your agent team works.</h1>
        <p className="sub">
          Two monthly plans. One included location. Clear control over every public action.
        </p>
        <p className="pr-currency">All prices in USD</p>
      </section>

      <div className="pr-plans">
        {PLANS.map((plan) => (
          <PlanCard
            key={plan.tier}
            plan={plan}
            price={viewModel.prices[plan.tier]}
            priceVariant={viewModel.priceVariant}
            purchasable={viewModel.purchasable[plan.tier]}
            autopilotOpen={autopilotOpen}
            selfServeEnabled={selfServeEnabled}
            onPlanInterest={setPlanInterest}
          />
        ))}
      </div>

      {viewModel.trialEnabled && (
        <div className="pr-below-cards">
          <div className="pr-guarantee">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            <span>30-day trial · Card required up front · Explicit plan selection</span>
          </div>
        </div>
      )}

      <div className="pr-matrix-wrap">
        <div className="pr-matrix-head">
          <h2>Compare the control boundary</h2>
          <p>The agent team is the same. The authority you grant it is different.</p>
        </div>
        {/* No horizontal scroll at any width: ≥721px the three columns fit the 880px wrap;
            ≤720px each row stacks (label, then the two plan values, each self-labelled via
            data-plan) so the Autopilot column is never off-screen on a phone. */}
        <section className="pr-matrix" aria-label="Plan comparison">
          <div className="pr-matrix-grid">
            <div className="pr-matrix-row hdr-row">
              <div className="pr-matrix-cell hdr first">Feature</div>
              <div className="pr-matrix-cell hdr">Copilot</div>
              <div className="pr-matrix-cell hdr featured">Autopilot</div>
            </div>
            {MATRIX.map((row) => {
              if ('section' in row) {
                return (
                  <div key={row.section} className="pr-matrix-row">
                    <div className="pr-matrix-cell section first">{row.section}</div>
                  </div>
                );
              }
              return (
                <div key={row.label} className="pr-matrix-row">
                  <div className="pr-matrix-cell first">{row.label}</div>
                  <MatrixCell value={row.values[0]} plan="Copilot" featured={false} />
                  <MatrixCell value={row.values[1]} plan="Autopilot" featured />
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <div className="pr-faq-wrap">
        <div className="pr-faq-head">
          <h2>Frequently asked</h2>
          <p>What to know before you choose a plan.</p>
        </div>
        {faqs.map((item, index) => {
          const isOpen = openFaq === index;
          const panelId = `${faqBaseId}-faq-panel-${index}`;
          const buttonId = `${faqBaseId}-faq-button-${index}`;
          return (
            <div key={item.q} className={`pr-faq-item ${isOpen ? 'is-open' : ''}`}>
              <button
                type="button"
                id={buttonId}
                className="pr-faq-q"
                onClick={() => setOpenFaq(isOpen ? -1 : index)}
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
              <section className="pr-faq-a" id={panelId} aria-labelledby={buttonId}>
                <div className="pr-faq-a-inner">{item.a}</div>
              </section>
            </div>
          );
        })}
      </div>

      <section id="pricing-waitlist" className="pr-cta">
        <h2>{selfServeEnabled ? 'Ready to choose your plan?' : 'Join the early access waitlist.'}</h2>
        <p>
          {selfServeEnabled
            ? 'Create your account, choose Copilot or Autopilot explicitly, and continue to secure checkout.'
            : 'Tell us about your business and we’ll reach out when early access opens for your area.'}
        </p>
        {selfServeEnabled ? (
          <Link href="/signup" className="pr-cta-btn">Create account</Link>
        ) : (
          <div className="w-full max-w-md">
            <fieldset className="pr-plan-pick">
              <legend className="pr-plan-pick-lbl">Which plan are you asking about?</legend>
              {PLAN_PICK_OPTIONS.map((option) => {
                const checked = planInterest === option.value;
                const optionId = `${planPickId}-${option.value ?? 'either'}`;
                return (
                  <label
                    key={optionId}
                    htmlFor={optionId}
                    className={`pr-plan-pick-opt ${checked ? 'is-on' : ''}`}
                  >
                    <input
                      id={optionId}
                      type="radio"
                      name="pricing-plan-interest"
                      value={option.value ?? ''}
                      checked={checked}
                      onChange={() => setPlanInterest(option.value)}
                    />
                    {option.label}
                  </label>
                );
              })}
            </fieldset>
            <LeadIntakeForm
              intent="waitlist"
              source="pricing"
              plan={planInterest ?? undefined}
              tone="onTeal"
            />
          </div>
        )}
      </section>
    </SiteShell>
  );
}
