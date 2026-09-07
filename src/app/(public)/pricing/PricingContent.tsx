'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type Dispatch, type SetStateAction } from 'react';
import { LeadIntakeForm } from '@/components/sections/lead-intake/LeadIntakeForm';
import type { LeadPlanInterest } from '@/components/sections/lead-intake/LeadIntakeForm';
import { Reveal } from '@/components/ui/Reveal';
import { SiteShell } from '@/components/ui/SiteShell';
import { HeroWash } from '@/components/ui/HeroWash';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import type {
  PlanPresentationViewModel,
  PlanPriceView,
} from '@/lib/payments/plan-presentation';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';

interface PlanCopy {
  tier: SubscriptionTierValue;
  /** Dossier number on the card's header row. */
  n: string;
  name: string;
  tag: string;
  features: readonly string[];
}

const PLANS: readonly PlanCopy[] = [
  {
    tier: 'copilot',
    n: '01',
    name: 'Copilot',
    tag: 'The whole agent team, with every public action and every request batch waiting for your approval.',
    features: [
      'Reply drafts personalized responses in your business voice',
      'Guardian holds negative and flagged reviews for you to see first',
      'Solicitor asks past customers for reviews by email, in batches you approve',
      'A printable review QR code for each location, straight to your Google review form',
      'Insights sends you a weekly review brief and a monthly impact report',
      'Your dashboard: Rep Pulse, rating and volume trends, and the Restraint tab',
      'You approve every reply before it posts',
      'Negative reviews are never auto-posted',
    ],
  },
  {
    tier: 'autopilot',
    n: '02',
    name: 'Autopilot',
    tag: 'The same agent team can act inside the rules you set.',
    features: [
      'Everything in Copilot',
      'Only 4–5★ replies that pass our safety checks may post automatically',
      'Request batches that fit your policy may send on their own after the veto window',
      'Your policy and your veto window stay in force',
      'Safety checks, the Judge, and the Governor must all clear it',
      'Negative and flagged reviews are never auto-posted',
    ],
  },
];

// Bar-only accents (Daylight Gallery II): Copilot wears the sage bar, Autopilot
// the gold bar — the Judge/ink bar never marks a purchasable tier.
const PLAN_BAR: Record<SubscriptionTierValue, string> = {
  copilot: 'var(--rw-sage-bar)',
  autopilot: 'var(--rw-gold-bar)',
};

interface MatrixFeature {
  label: string;
  /** One-line plain-words gloss under the label, for the one term a buyer may not know. */
  hint?: string;
  values: readonly [string | boolean, string | boolean];
}

interface MatrixSection {
  section: string;
  rows: readonly MatrixFeature[];
}

// Every value is either a mark (included / not included) or a sentence an owner
// can read without knowing the product's internals. "Approval context" and
// "Outside your policy" used to sit here; neither decodes without the design doc.
// The veto window is glossed ONCE, on the row that names it.
const MATRIX: readonly MatrixSection[] = [
  {
    section: 'Agent team',
    rows: [
      { label: 'Reply drafts personalized responses', values: [true, true] },
      { label: 'Guardian holds negative and flagged reviews', values: [true, true] },
      { label: 'Solicitor asks past customers for reviews by email, in batches', values: [true, true] },
      { label: 'Printable review QR code per location', values: [true, true] },
      { label: 'Insights sends a weekly brief and a monthly impact report', values: [true, true] },
      { label: 'Dashboard: Rep Pulse, trends, review velocity, Restraint tab', values: [true, true] },
    ],
  },
  {
    section: 'Public actions',
    rows: [
      {
        label: 'Before a reply posts',
        values: ['You approve everything', 'You set the policy and the veto window'],
      },
      { label: 'Replies that may post on their own', values: [false, '4–5★, safety-checked only'] },
      {
        label: 'Request batches that may send on their own',
        values: ['Every batch waits for your approval', 'Inside your policy, after the veto window'],
      },
      { label: 'Negative reviews auto-posted', values: [false, false] },
    ],
  },
  {
    section: 'Safety controls',
    rows: [
      {
        label: 'Veto window',
        hint: 'A 15- or 30-minute pause after a reply clears the checks, when one tap still stops it.',
        values: ['Not needed: nothing posts until you approve it', 'You choose 15 or 30 minutes'],
      },
      { label: 'Safety check on every draft', values: [true, true] },
      { label: 'Judge and Governor watch anything that posts itself', values: [false, true] },
    ],
  },
  {
    section: 'Locations',
    rows: [{ label: 'Included locations', values: ['1', '1'] }],
  },
];

interface FaqItem {
  q: string;
  a: string;
}

const TRIAL_FAQ: FaqItem = {
  q: 'How does the 30-day trial work?',
  a: 'Choose a plan explicitly and provide a card up front. Your 30-day trial starts through Stripe, and monthly billing for that plan begins after the trial unless you cancel.',
};

const BASE_FAQS: readonly FaqItem[] = [
  {
    q: 'Can I change plans later?',
    a: 'Yes. You can change plans from Billing. Eligible plan changes are previewed first and Stripe applies any required proration.',
  },
  {
    q: 'Are review requests included on both plans?',
    a: 'Yes. On both plans Solicitor builds each batch, decides send or withhold for each person with a reason, and the printable review QR code is included for every location. On Copilot every batch waits for your approval. On Autopilot a batch that fits your policy can send on its own after the veto window, and one tap still halts it.',
  },
  {
    q: 'What can Autopilot post without approval?',
    a: 'Only 4–5★ replies that pass our safety checks and fit the policy you set may post, and only after the veto window closes. Negative reviews are never auto-posted.',
  },
  {
    q: 'Is there a contract?',
    a: 'RepWorth plans are month-to-month and renew each month until cancelled.',
  },
];

const PLAN_PICK_OPTIONS: readonly { value: LeadPlanInterest | null; label: string }[] = [
  { value: 'copilot', label: 'Copilot' },
  { value: 'autopilot', label: 'Autopilot' },
  { value: null, label: 'Not sure yet' },
];

// Hero h1, pre-broken into masked lines (the Daylight hero entrance: each line
// rises out of its own overflow mask, +0.1s per line — the same move as
// /how-it-works).
const HERO_LINES = ['Choose how', 'your agent', 'team works.'];

// The hero artifact: the one thing a buyer must understand before the cards —
// where the same review stops on each plan. Every line restates a claim the
// page already makes (plan tags, the matrix, the FAQ); nothing new is asserted.
const GATE_ROWS = [
  {
    tier: 'copilot' as const,
    name: 'Copilot',
    stop: 'Waits for your tap',
    sub: 'You approve every reply before it posts.',
  },
  {
    tier: 'autopilot' as const,
    name: 'Autopilot',
    stop: 'Posts after the veto window',
    sub: 'Only 4–5★ replies that pass our safety checks, and only after the veto window closes.',
  },
];

// The CTA band's copy follows the same two facts as the cards: is self-serve
// on, and can Autopilot be bought today.
const CTA_COPY = {
  waitlist: {
    h2: 'Get early access.',
    sub: 'Tell us about your business and we’ll reach out when early access opens for your area.',
  },
  choose: {
    h2: 'Ready to choose your plan?',
    sub: 'Create your account, choose Copilot or Autopilot, and continue to secure checkout.',
  },
  copilot: {
    h2: 'Start with Copilot today.',
    sub: 'Create your account and start on Copilot. Autopilot opens when its safety checks are done, and you can switch then.',
  },
} as const;

function ctaCopy(selfServeEnabled: boolean, autopilotOpen: boolean) {
  if (!selfServeEnabled) return CTA_COPY.waitlist;
  return autopilotOpen ? CTA_COPY.choose : CTA_COPY.copilot;
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 13l4 4L19 7" />
  </svg>
);

function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

// The card's action slot. Three honest states: a door to the tier (signup or the
// waitlist band), a plain status when the tier is closed and there is no door to
// offer (self-serve — a signed-up owner switches plans in-product), or a status plus
// a "tell me when" door in the waitlist posture. Never a disabled fake button.
function PlanDoor({
  plan,
  purchasable,
  primary,
  selfServeEnabled,
  onPlanInterest,
}: {
  plan: PlanCopy;
  purchasable: boolean;
  primary: boolean;
  selfServeEnabled: boolean;
  onPlanInterest: (plan: LeadPlanInterest) => void;
}) {
  if (purchasable) {
    return (
      <Link
        href={selfServeEnabled ? '/signup' : '#pricing-waitlist'}
        className={`pr-plan-cta ${primary ? 'primary' : 'ghost'}`}
        onClick={() => onPlanInterest(plan.tier)}
      >
        {selfServeEnabled ? `Choose ${plan.name}` : `Get early access · ${plan.name}`}
      </Link>
    );
  }
  if (selfServeEnabled) {
    return (
      <p className="pr-plan-soon">
        Not open yet: we are finishing its safety checks. Start on Copilot now and switch
        when Autopilot opens.
      </p>
    );
  }
  return (
    <>
      <Link
        href="#pricing-waitlist"
        className="pr-plan-cta ghost"
        onClick={() => onPlanInterest('autopilot')}
      >
        Get early access · Autopilot
      </Link>
      <p className="pr-plan-soon">
        Not open yet: we are finishing its safety checks. Copilot is taking waitlist
        sign-ups now.
      </p>
    </>
  );
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

  return (
    <article
      className={`pr-plan ${featured ? 'is-featured' : ''}`}
      style={{ ['--bar' as string]: PLAN_BAR[plan.tier] }}
    >
      {/* Dossier header row (the /how-it-works step header): number · name · status. */}
      <div className="pr-plan-hd">
        <b>{plan.n}</b>
        <h3 className="pr-plan-name">{plan.name}</h3>
        {featured && <div className="pr-ribbon">More autonomy</div>}
        {isAutopilot && !autopilotOpen && <div className="pr-ribbon is-soon">Opening soon</div>}
      </div>

      <div className="pr-plan-bd">
        <p className="pr-plan-tag">{plan.tag}</p>

        <div className="pr-price">
          <span className="pr-price-currency">$</span>
          <span className="pr-price-amt">{formatDollars(price.basePriceCents)}</span>
          <span className="pr-price-per">per month</span>
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

        <div className="pr-door">
          <PlanDoor
            plan={plan}
            purchasable={purchasable}
            primary={primary}
            selfServeEnabled={selfServeEnabled}
            onPlanInterest={onPlanInterest}
          />
        </div>

        <p className="pr-includes-lbl">What&apos;s included</p>
        <ul className="pr-feature-list">
          {plan.features.map((feature) => (
            <li key={feature}>
              <span className="check"><CheckIcon /></span>
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

// Hero — copy left, the gate artifact right. `heroIn` flips once after mount
// and the CSS transition delays stage the entrance.
function PricingHero({ heroIn }: { heroIn: boolean }) {
  return (
    <section className={`pr-hero rw-dl-wash-host ${heroIn ? 'is-in' : ''}`} aria-labelledby="pr-h1">
      <HeroWash />
      <div className="rw-dl-col pr-hero-col">
        <div>
          <p className="pr-eyebrow pr-fade">Pricing</p>
          <h1 className="pr-h1" id="pr-h1">
            {HERO_LINES.map((line) => (
              <span key={line} className="ln">
                <span>{line}</span>
              </span>
            ))}
          </h1>
          <p className="pr-lede pr-fade d1">
            Two monthly plans, one location included. You decide what can post without your tap.
          </p>
          <div className="pr-hero-links pr-fade d2">
            <Link href="/how-it-works" className="rw-dl-txtlink">
              See how the gate works <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        <article className="rw-dl-card pr-gate pr-fade d3" aria-label="Sample: where the same review stops on each plan">
          <div className="rw-dl-cap">
            <span className="rw-dl-cap-dot" />
            <span>Sample · the same 5★ review on each plan</span>
            <span className="rw-dl-cap-tail">The gate</span>
          </div>
          <div className="pr-gate-rows">
            {GATE_ROWS.map((row) => (
              <div key={row.tier} className="pr-gate-row" style={{ ['--bar' as string]: PLAN_BAR[row.tier] }}>
                <span className="pr-gate-dot" aria-hidden="true" />
                <div>
                  <div className="pr-gate-k">{row.name}</div>
                  <div className="pr-gate-v">{row.stop}</div>
                  <p className="pr-gate-s">{row.sub}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="rw-dl-fine">Negative and flagged reviews are never auto-posted on either plan.</p>
        </article>
      </div>
    </section>
  );
}

// A value cell. A mark is an `aria-hidden` glyph plus `sr-only` text, so a screen
// reader hears "Included" / "Not included" in the cell instead of an empty cell.
// `data-plan` feeds the per-cell plan label pricing.css paints on phones, where
// each row stacks as label → Copilot value → Autopilot value.
function MatrixCell({ value, plan, featured }: { value: string | boolean; plan: string; featured: boolean }) {
  const className = `pr-matrix-cell num ${featured ? 'featured' : ''}`;
  if (value === true) {
    return (
      <td className={className} data-plan={plan}>
        <span className="pr-check-yes" aria-hidden="true"><CheckIcon /></span>
        <span className="sr-only">Included</span>
      </td>
    );
  }
  if (value === false) {
    return (
      <td className={className} data-plan={plan}>
        <span className="pr-check-no" aria-hidden="true" />
        <span className="sr-only">Not included</span>
      </td>
    );
  }
  return <td className={className} data-plan={plan}>{value}</td>;
}

// Matrix column header: plan name with its bar tick, and the monthly price under
// it so the table reads on its own without scrolling back to the cards.
function MatrixPlanHeader({
  tier,
  name,
  price,
  featured,
}: {
  tier: SubscriptionTierValue;
  name: string;
  price: PlanPriceView;
  featured: boolean;
}) {
  return (
    <th scope="col" className={`pr-matrix-cell hdr ${featured ? 'featured' : ''}`}>
      <span className="pr-matrix-plan">
        <i className="pr-matrix-tick" style={{ ['--bar' as string]: PLAN_BAR[tier] }} aria-hidden="true" />
        {name}
      </span>
      <span className="pr-matrix-price">${formatDollars(price.basePriceCents)} per month</span>
    </th>
  );
}

// The comparison ledger on its paper band, as a real table: column headers with
// `scope`, one `<tbody>` per section headed by a `scope="rowgroup"` cell, and a
// `scope="row"` header on every feature. No horizontal scroll at any width:
// ≥721px the three columns fit the 960px ledger; ≤720px each row stacks (label,
// then the two plan values, each self-labelled via data-plan) so the Autopilot
// column is never off-screen. The rows are CSS grids for that stacking, and
// a table element with a non-table `display` loses its role in some engines, so
// every table part restates its role explicitly.
function ComparisonMatrix({
  prices,
  autopilotOpen,
}: {
  prices: PlanPresentationViewModel['prices'];
  autopilotOpen: boolean;
}) {
  return (
    <section className="rw-dl-band is-paper pr-compare" aria-labelledby="pr-cmp-h">
      <div className="rw-dl-col">
        <Reveal>
          <div className="rw-dl-intro is-tight">
            <h2 className="rw-dl-h2" id="pr-cmp-h">What each plan can do on its own</h2>
            <p>The agent team is the same on both plans. What it can do without asking you is different.</p>
          </div>
        </Reveal>
        <Reveal delay={120} scrub>
          <table className="pr-matrix" aria-label="Plan comparison">
            <thead>
              <tr className="pr-matrix-row hdr-row">
                <th scope="col" className="pr-matrix-cell hdr first">Feature</th>
                <MatrixPlanHeader tier="copilot" name="Copilot" price={prices.copilot} featured={false} />
                {/* The bone column follows the same rule as the featured card:
                    emphasis only on a tier you can get today. */}
                <MatrixPlanHeader tier="autopilot" name="Autopilot" price={prices.autopilot} featured={autopilotOpen} />
              </tr>
            </thead>
            {MATRIX.map((group) => (
              <tbody key={group.section}>
                <tr className="pr-matrix-row">
                  <th scope="rowgroup" colSpan={3} className="pr-matrix-cell section first">
                    {group.section}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.label} className="pr-matrix-row">
                    <th scope="row" className="pr-matrix-cell first">
                      {row.label}
                      {row.hint && <span className="pr-matrix-hint">{row.hint}</span>}
                    </th>
                    <MatrixCell value={row.values[0]} plan="Copilot" featured={false} />
                    <MatrixCell value={row.values[1]} plan="Autopilot" featured={autopilotOpen} />
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </Reveal>
      </div>
    </section>
  );
}

// FAQ — heading left, the shared `.rw-dl-faq*` accordion right. The accordion
// keeps `aria-expanded` / `aria-controls` as its contract.
function PricingFaq({ faqs }: { faqs: readonly FaqItem[] }) {
  const [openFaq, setOpenFaq] = useState(0);
  const faqBaseId = useId();
  return (
    <section className="rw-dl-band pr-faq-band" aria-labelledby="pr-faq-h">
      <div className="rw-dl-col pr-faq">
        <Reveal>
          <div className="pr-faq-tx">
            <h2 className="rw-dl-h2" id="pr-faq-h">Frequently asked</h2>
            <p className="rw-dl-lede">What to know before you choose a plan.</p>
            <Link href="/how-it-works" className="rw-dl-txtlink">
              More answers on How it works <span aria-hidden="true">→</span>
            </Link>
          </div>
        </Reveal>
        <Reveal delay={120}>
          <div className="rw-dl-faq">
            {faqs.map((item, index) => {
              const isOpen = openFaq === index;
              const panelId = `${faqBaseId}-faq-panel-${index}`;
              const buttonId = `${faqBaseId}-faq-button-${index}`;
              return (
                <div key={item.q} className={`rw-dl-faq-item ${isOpen ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    id={buttonId}
                    className="rw-dl-faq-q"
                    onClick={() => setOpenFaq(isOpen ? -1 : index)}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                  >
                    <span>{item.q}</span>
                    <span className="rw-dl-faq-toggle" aria-hidden>+</span>
                  </button>
                  <section className="rw-dl-faq-a" id={panelId} aria-labelledby={buttonId}>
                    <div className="rw-dl-faq-a-inner">{item.a}</div>
                  </section>
                </div>
              );
            })}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// The plan-interest chooser on the dark band (waitlist posture only): the tier
// the visitor asked about via a card door stays visible and changeable here,
// and the form sends it with the lead.
function PlanPicker({
  planInterest,
  setPlanInterest,
}: {
  planInterest: LeadPlanInterest | null;
  setPlanInterest: Dispatch<SetStateAction<LeadPlanInterest | null>>;
}) {
  const planPickId = useId();
  return (
    <fieldset className="pr-plan-pick">
      <legend className="pr-plan-pick-lbl">Which plan are you asking about?</legend>
      {PLAN_PICK_OPTIONS.map((option) => {
        const checked = planInterest === option.value;
        const optionId = `${planPickId}-${option.value ?? 'either'}`;
        return (
          <label key={optionId} htmlFor={optionId} className={`pr-plan-pick-opt ${checked ? 'is-on' : ''}`}>
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
  );
}

function PricingCta({
  selfServeEnabled,
  autopilotOpen,
  planInterest,
  setPlanInterest,
}: {
  selfServeEnabled: boolean;
  autopilotOpen: boolean;
  planInterest: LeadPlanInterest | null;
  setPlanInterest: Dispatch<SetStateAction<LeadPlanInterest | null>>;
}) {
  const copy = ctaCopy(selfServeEnabled, autopilotOpen);
  return (
    <section id="pricing-waitlist" className="rw-dl-cta" aria-labelledby="pr-cta-h">
      <div className="rw-dl-col">
        <div>
          <h2 id="pr-cta-h">{copy.h2}</h2>
          <p className="rw-dl-cta-sub">{copy.sub}</p>
          <div className="rw-dl-cta-more">
            <Link href="/how-it-works">How it works <span aria-hidden="true">→</span></Link>
            <Link href="/features">All features <span aria-hidden="true">→</span></Link>
          </div>
        </div>
        <div>
          {selfServeEnabled ? (
            <div className="rw-dl-cta-panel">
              <Link href="/signup" className="rw-pill rw-pill-paper pr-cta-pill">Create account</Link>
            </div>
          ) : (
            <div className="rw-dl-cta-panel">
              <PlanPicker planInterest={planInterest} setPlanInterest={setPlanInterest} />
              <LeadIntakeForm
                intent="waitlist"
                source="pricing"
                plan={planInterest ?? undefined}
                tone="onTeal"
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function PricingContent({
  viewModel,
  selfServeEnabled = false,
}: {
  viewModel: PlanPresentationViewModel;
  selfServeEnabled?: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  // Which tier the visitor asked about via a card door; the waitlist form sends it
  // with the lead, and the chooser above the form keeps it visible and changeable.
  const [planInterest, setPlanInterest] = useState<LeadPlanInterest | null>(null);
  const autopilotOpen = viewModel.purchasable.autopilot;
  const faqs = viewModel.trialEnabled ? [TRIAL_FAQ, ...BASE_FAQS] : BASE_FAQS;

  // Hero entrance: one class flip staged by CSS transition delays.
  const [heroIn, setHeroIn] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setHeroIn(true), prefersReducedMotion ? 0 : 80);
    return () => window.clearTimeout(id);
  }, [prefersReducedMotion]);

  return (
    <SiteShell scope="pr-page" selfServeEnabled={selfServeEnabled} trialEnabled={viewModel.trialEnabled}>
      <PricingHero heroIn={heroIn} />

      {/* Plans — two dossier cards under a ledger rule */}
      <section className="pr-plans-band" aria-labelledby="pr-plans-h">
        <div className="rw-dl-col">
          <Reveal>
            {/* The visible ledger label IS the section heading now. It used to
                sit beside an `sr-only` h2 reading "Plans", so the outline and
                the page said different things and the visible label carried no
                weight at all. */}
            <div className="pr-ledger-hd">
              <h2 className="pr-ledger-name" id="pr-plans-h">Two plans · billed monthly</h2>
              <span className="pr-ledger-rule" aria-hidden="true" />
              <span>All prices in USD</span>
            </div>
          </Reveal>
          <Reveal delay={120}>
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
              <p className="pr-guarantee">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
                <span>30-day trial · Card required up front · Explicit plan selection</span>
              </p>
            )}
          </Reveal>
        </div>
      </section>

      <ComparisonMatrix prices={viewModel.prices} autopilotOpen={autopilotOpen} />

      <PricingFaq faqs={faqs} />

      <PricingCta
        selfServeEnabled={selfServeEnabled}
        autopilotOpen={autopilotOpen}
        planInterest={planInterest}
        setPlanInterest={setPlanInterest}
      />
    </SiteShell>
  );
}
