'use client';

import Link from 'next/link';
import { useCountUp } from '@/hooks/useCountUp';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/ui/cn';
import {
  createRef,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { SiteShell } from '@/components/ui/SiteShell';
import { HeroWash } from '@/components/ui/HeroWash';
import { EARLY_ACCESS_CTA } from '@/components/ui/marketing-links';
import { LeadIntakeForm } from '../lead-intake/LeadIntakeForm';
import { useReveal } from '@/hooks/useReveal';
import { ReviewStars } from './FeatPrimitives';
import { FeatReply } from './FeatReply';
import { FeatGuardian } from './FeatGuardian';
import { FeatLang } from './FeatLang';
import { FeatGate } from './FeatGate';
import { FeatAutopilot } from './FeatAutopilot';
import { FeatWatchdogs } from './FeatWatchdogs';
import { FeatVoice } from './FeatVoice';
import { FeatInsights } from './FeatInsights';
import { FeatRoi } from './FeatRoi';
import { RoadmapBand } from './RoadmapBand';

// `bar` is each chapter's colour bar token (bar-only accents, never text) —
// the same dot the chapter header wears, so the index and the chapters agree.
const FEATURES = [
  { id: 'f-reply',     n: '01', label: 'Reply',      sub: 'The drafter',       group: 'Your agent team',  bar: 'var(--rw-mist-bar)' },
  { id: 'f-guardian',  n: '02', label: 'Guardian',   sub: 'Negative lane',     group: 'Your agent team',  bar: 'var(--rw-blush-bar)' },
  { id: 'f-insights',  n: '03', label: 'Insights',   sub: 'Mondays',           group: 'Your agent team',  bar: 'var(--rw-teal-bar)' },
  { id: 'f-gate',      n: '04', label: 'The Gate',   sub: 'Copilot',           group: 'Care and control', bar: 'var(--rw-sage-bar)' },
  { id: 'f-autopilot', n: '05', label: 'Autopilot',  sub: 'Within your rules', group: 'Care and control', bar: 'var(--rw-gold-bar)' },
  { id: 'f-watchdogs', n: '06', label: 'Watchdogs',  sub: 'Judge & Governor',  group: 'Care and control', bar: 'var(--rw-ink2)' },
  { id: 'f-lang',      n: '07', label: 'Languages',  sub: 'Reach',             group: 'Craft and proof',  bar: 'var(--rw-sage-bar)' },
  { id: 'f-voice',     n: '08', label: 'Voice',      sub: 'Over time',         group: 'Craft and proof',  bar: 'var(--rw-mist-bar)' },
  { id: 'f-roi',       n: '09', label: 'Results',    sub: 'Proof',             group: 'Craft and proof',  bar: 'var(--rw-teal-bar)' },
] as const;

type ChapterId = (typeof FEATURES)[number]['id'];
type ChapterRefs = Record<ChapterId, RefObject<HTMLElement | null>>;

const FEATURE_GROUPS = ['Your agent team', 'Care and control', 'Craft and proof'] as const;

// Hero h1, pre-broken into masked lines (the Daylight hero entrance: each line
// rises out of its own overflow mask, +0.1s per line — the same move as
// /how-it-works).
const HERO_LINES = [
  'A tireless agent',
  'drafts a reply',
  'to every review.',
  'Nothing goes public',
  'without the gate.',
];

// Product facts, not performance figures: each is how the shipped pipeline is
// built (design of record §8 — the Judge reviews 100% of auto-posts, the
// owner-set veto window is 15 or 30 minutes, the drafting rules name 30+
// languages). No customer data exists to measure against (PRODUCT.md
// "Evidence on Hand"), so nothing here is a target or a result — the earlier
// "58 min / 96% / 30 sec" targets were invented numbers styled as KPIs. The bar
// is the chapter the fact comes from (06 Watchdogs / 05 Autopilot / 07
// Languages), so the colour means the same thing here as in the index.
// `counts` holds one number, or the two halves of a pair joined by `join`.
const HERO_FACTS = [
  { counts: [100], unit: '%', label: 'of auto-posts reviewed\nby the Judge', bar: 'var(--rw-ink2)' },
  { counts: [15, 30], join: '/', unit: 'min', label: 'veto window before an\nAutopilot reply posts', bar: 'var(--rw-gold-bar)' },
  { counts: [30], unit: '+', label: 'languages Reply\ncan draft in', bar: 'var(--rw-sage-bar)' },
] as const;

const FACT_DELAY_MS = 600;
const FACT_STAGGER_MS = 280;

// Illustrative sample reviews; not real customer testimonials. Multilingual to
// show the language-detection feature; no invented names or business claims.
const MARQUEE_REVIEWS: Array<{ lang: string; stars: string; ratingValue: number; text: string }> = [
  { lang: 'EN', stars: '★★★★★', ratingValue: 5, text: 'Sample review · "Best in the city"' },
  { lang: 'ES', stars: '★★★★★', ratingValue: 5, text: 'Sample review · "Auténtico"' },
  { lang: 'EN', stars: '★★★★☆', ratingValue: 4, text: 'Sample review · "They remembered my order"' },
  { lang: 'VI', stars: '★★★★★', ratingValue: 5, text: 'Sample review · "Ngon nhất khu này"' },
  { lang: 'EN', stars: '★★★★★', ratingValue: 5, text: 'Sample review · "Saved my dinner"' },
  { lang: 'ZH', stars: '★★★★☆', ratingValue: 4, text: 'Sample review · "汤底很赞"' },
  { lang: 'EN', stars: '★★★★★', ratingValue: 5, text: 'Sample review · "Worth the drive"' },
  { lang: 'KO', stars: '★★★★★', ratingValue: 5, text: 'Sample review · "정말 맛있어요"' },
  { lang: 'EN', stars: '★★★★☆', ratingValue: 4, text: 'Sample review · "Made my Monday"' },
];

// The marquee track is doubled so the -50% translate loops seamlessly. The
// second copy exists only to make the wrap invisible, so it is marked as a
// duplicate: the marquee is deliberately IN the accessibility tree (each chip
// says "Sample review"), and without this a screen reader read all nine samples
// twice over.
const MARQUEE_TRACK = [
  ...MARQUEE_REVIEWS.map((r) => ({ r, k: `a-${r.text}`, dup: false })),
  ...MARQUEE_REVIEWS.map((r) => ({ r, k: `b-${r.text}`, dup: true })),
];

function HeroSection({
  heroIn,
  values,
  comingSoon,
  signupCtaLabel,
}: {
  heroIn: boolean;
  /** One entry per fact, in HERO_FACTS order; each holds that fact's counted number(s). */
  values: readonly (readonly number[])[];
  comingSoon: boolean;
  /** The /signup door label when self-serve is on; null means the early-access door. */
  signupCtaLabel: string | null;
}) {
  return (
    <section className={cn('feat-hero rw-dl-wash-host', heroIn && 'is-in')} aria-labelledby="feat-h1">
      <HeroWash />
      <div className="rw-dl-col feat-hero-col">
        <div>
          <p className="feat-eyebrow feat-fade">Features · Your agent team</p>
          <h1 className="feat-h1" id="feat-h1">
            {HERO_LINES.map((line) => (
              <span key={line} className="rw-hero-line">
                <span>{line}</span>
              </span>
            ))}
          </h1>
          <p className="feat-lede feat-fade d1">
            RepWorth runs a team of AI agents on your Google reviews. Reply drafts every response,
            Guardian triages the bad ones, and Insights reports on Mondays. Two watchdogs, the
            Judge and the Governor, oversee anything that posts on its own. You pick the autonomy:
            approve every reply on Copilot, or let policy-cleared replies post themselves on
            Autopilot.
          </p>
          {/* The same door /how-it-works puts in its hero: the forest pill,
              then the pricing text link. Before this the hero had only the
              text link, and with self-serve off the nav had no CTA either, so
              the first door was the closing band, nine chapters down. */}
          <div className="feat-hero-links feat-fade d2 flex flex-wrap items-center gap-x-5 gap-y-3">
            {comingSoon ? null : signupCtaLabel !== null ? (
              <Link href="/signup" className="rw-pill rw-pill-forest">
                {signupCtaLabel}
              </Link>
            ) : (
              <a href="#feat-cta" className="rw-pill rw-pill-forest">
                {EARLY_ACCESS_CTA.label}
              </a>
            )}
            <Link href="/pricing" className="rw-dl-txtlink">
              See pricing <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        {/* The three facts as a stack of stat cards: left bar wipes in, cards
            stagger top → bottom, numbers count up (the /how-it-works stat card). */}
        <div className="feat-hero-stats">
          {HERO_FACTS.map((fact, i) => (
            <div
              key={fact.label}
              className="feat-stat"
              style={
                {
                  '--bar': fact.bar,
                  '--m-delay': `${FACT_DELAY_MS + i * FACT_STAGGER_MS}ms`,
                } as CSSProperties
              }
            >
              <div className="feat-stat-n">
                {(values[i] ?? []).map((n, j) => (
                  <span key={j}>
                    {j > 0 && ('join' in fact ? fact.join : '')}
                    {n}
                  </span>
                ))}
                <small>{fact.unit}</small>
              </div>
              <div className="feat-stat-d">{fact.label}</div>
            </div>
          ))}
          <p className="rw-dl-fine feat-fade d3">How the system is built, not measured results.</p>
        </div>
      </div>

      {/* Hero review marquee */}
      <div className="rw-feat-marquee-mask" aria-hidden={false}>
        <div className="rw-feat-marquee-track">
          {MARQUEE_TRACK.map(({ r, k, dup }) => (
            <div key={k} className="feat-mq-chip" aria-hidden={dup || undefined}>
              <span className="feat-mq-lang">{r.lang}</span>
              <ReviewStars rating={r.ratingValue} glyphs={r.stars} />
              <span className="feat-mq-text">{r.text}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// The index as a ledger (the /how-it-works overview strip): one bordered
// table, a row per group, the group name in a bone cell on the left and the
// three chapters as cells — each a jump button with the chapter's bar tick.
function FeatureIndex({ onJump }: { onJump: (id: ChapterId) => void }) {
  const [tocRef, tocSeen] = useReveal<HTMLDivElement>();
  return (
    <section id="feat-index" aria-label="Feature index" className="rw-dl-band is-paper is-tight feat-toc">
      <div className="rw-dl-col">
        <div className="feat-toc-head">
          <h2 className="feat-toc-name">Index</h2>
          <span className="feat-toc-rule" aria-hidden="true" />
          <span>3 agents · 2 watchdogs · 2 modes</span>
        </div>
        <div ref={tocRef} className="feat-idx">
          {FEATURE_GROUPS.map((group) => (
            <div key={group} className="feat-idx-row">
              <div className="feat-idx-grp">{group}</div>
              {FEATURES.filter((f) => f.group === group).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onJump(f.id)}
                  className={cn('feat-idx-cell', tocSeen && 'in')}
                  style={{ ['--chip-delay' as string]: `${FEATURES.indexOf(f) * 70}ms` }}
                >
                  <span className="feat-idx-k">
                    <span className="feat-intro-tick" style={{ ['--bar' as string]: f.bar }} aria-hidden="true" />
                    {f.n}
                  </span>
                  <span className="feat-idx-l">{f.label}</span>
                  <span className="feat-idx-s">{f.sub}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// One of the three chapter groups the index already names, with a header that
// pins while its three chapters scroll past and hands off to the next group.
//
// Why this and not the /how-it-works stacked deck: that deck needs near-uniform
// card heights (its six steps span 481-538px, a 1.12x spread), one surface, and
// one card shape. These nine chapters span 419-987px (2.36x), alternate
// paper/bone, and use three arrangements — and 09 Results is taller than the
// viewport, so it could never hold a pin. Stacking also reads as "ordered
// stages of one thing", which is /how-it-works. This page is a catalogue, so
// its sticky device says where you are rather than what comes next.
//
// The bar repeats `.feat-ch-grp`, which every chapter header row inside it
// already carries, so it is aria-hidden: screen readers get the group per
// chapter and do not need it a fourth time.
function ChapterGroup({ group, children }: { group: string; children: ReactNode }) {
  // Chapters come from FEATURES so the bar cannot drift from the index.
  const chapters = FEATURES.filter((f) => f.group === group);
  return (
    <div className="feat-grp">
      <div className="feat-grp-hd" aria-hidden="true">
        <div className="rw-dl-col feat-grp-row">
          <span className="feat-grp-name">{group}</span>
          <span className="feat-grp-rule" />
          <span>{chapters.map((f) => f.n).join(' · ')}</span>
        </div>
        {/* One segment per chapter, in that chapter's bar colour, filling in
            turn as you scroll the group — the /how-it-works step ribbon, scoped
            to a group instead of the whole stack. */}
        <div className="feat-grp-ribbon">
          {chapters.map((f) => (
            <span key={f.id} style={{ ['--bar' as string]: f.bar }}>
              <i />
            </span>
          ))}
        </div>
      </div>
      {/* The timeline source: NOT sticky, so its view progress tracks scroll.
          `.feat-grp-hd` is pinned and would freeze. */}
      <div className="feat-grp-body">{children}</div>
    </div>
  );
}

// CTA — the dark ink band. Three honest postures: coming soon (no door),
// self-serve (the /signup door), or the waitlist form.
function FeaturesCta({
  comingSoon,
  signupCtaLabel,
}: {
  comingSoon: boolean;
  /** The /signup door label when self-serve is on; null keeps the waitlist form. */
  signupCtaLabel: string | null;
}) {
  const showSignupCta = signupCtaLabel !== null;
  return (
    // `id` is the hero pill's anchor while self-serve is off.
    <section id="feat-cta" aria-label="Call to action" className="rw-dl-cta">
      <div className="rw-dl-col">
        <div>
          <h2>{showSignupCta ? 'Start with Copilot today.' : `${EARLY_ACCESS_CTA.label}.`}</h2>
          <p className="rw-dl-cta-sub">
            {showSignupCta
              ? 'Connect your Google Business Profile and get your first drafts in minutes.'
              : "Tell us about your business and we'll reach out when early access opens for your area."}
          </p>
          <div className="rw-dl-cta-more">
            <Link href="/how-it-works">See how it works <span aria-hidden="true">→</span></Link>
            <Link href="/pricing">See pricing <span aria-hidden="true">→</span></Link>
          </div>
        </div>
        <div className="rw-dl-cta-panel">
          {comingSoon && <span className="rw-pill rw-pill-paper is-disabled">Coming soon</span>}
          {!comingSoon && showSignupCta && (
            <>
              <Link href="/signup" className="rw-pill rw-pill-paper feat-cta-pill">
                {signupCtaLabel}
              </Link>
              <p className="rw-dl-fine">
                Card required up front. Explicit plan selection. Cancel anytime.
              </p>
            </>
          )}
          {!comingSoon && !showSignupCta && (
            <LeadIntakeForm intent="waitlist" source="features" tone="onTeal" />
          )}
        </div>
      </div>
    </section>
  );
}

interface FeaturesContentProps {
  comingSoon?: boolean;
  selfServeEnabled?: boolean;
  /** Drives the nav CTA label ("Start free trial" vs "Create account"). */
  trialEnabled?: boolean;
  /** Label for the /signup CTA when self-serve is on; null keeps the waitlist form. */
  signupCtaLabel?: string | null;
}

export function FeaturesContent({
  comingSoon = false,
  selfServeEnabled = false,
  trialEnabled = false,
  signupCtaLabel = null,
}: FeaturesContentProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

  // One ref per chapter section, created once, for the index jump targets.
  const refs = useMemo<ChapterRefs>(
    () => Object.fromEntries(FEATURES.map((f) => [f.id, createRef<HTMLElement>()])) as ChapterRefs,
    []
  );

  // Hero entry: one class flip staged by CSS transition delays, via a deferred
  // tick (avoids a synchronous setState in the effect body). Under reduced
  // motion, skip the staged delay so the final frame appears immediately.
  const [heroIn, setHeroIn] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setHeroIn(true), prefersReducedMotion ? 0 : 80);
    return () => window.clearTimeout(id);
  }, [prefersReducedMotion]);

  // Facts count up in step with their card's stagger (both halves of the
  // veto-window pair share the second card's delay).
  const countOpts = (i: number) => ({ active: heroIn, duration: 1400, delayMs: FACT_DELAY_MS + i * FACT_STAGGER_MS, round: true });
  const judge = useCountUp(HERO_FACTS[0].counts[0], countOpts(0));
  const vetoShort = useCountUp(HERO_FACTS[1].counts[0], countOpts(1));
  const vetoLong = useCountUp(HERO_FACTS[1].counts[1], countOpts(1));
  const languages = useCountUp(HERO_FACTS[2].counts[0], countOpts(2));

  const scrollTo = (id: ChapterId) => {
    refs[id].current?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  return (
    <SiteShell scope="rw-feat-page" comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} trialEnabled={trialEnabled}>
      <HeroSection
        heroIn={heroIn}
        values={[[judge], [vetoShort, vetoLong], [languages]]}
        comingSoon={comingSoon}
        signupCtaLabel={selfServeEnabled ? signupCtaLabel : null}
      />
      <FeatureIndex onJump={scrollTo} />

      <ChapterGroup group="Your agent team">
        <FeatReply innerRef={refs['f-reply']} />
        <FeatGuardian innerRef={refs['f-guardian']} />
        <FeatInsights innerRef={refs['f-insights']} />
      </ChapterGroup>
      <ChapterGroup group="Care and control">
        <FeatGate innerRef={refs['f-gate']} />
        <FeatAutopilot innerRef={refs['f-autopilot']} />
        <FeatWatchdogs innerRef={refs['f-watchdogs']} />
      </ChapterGroup>
      <ChapterGroup group="Craft and proof">
        <FeatLang innerRef={refs['f-lang']} />
        <FeatVoice innerRef={refs['f-voice']} />
        <FeatRoi innerRef={refs['f-roi']} />
      </ChapterGroup>
      <RoadmapBand />

      <FeaturesCta comingSoon={comingSoon} signupCtaLabel={selfServeEnabled ? signupCtaLabel : null} />
    </SiteShell>
  );
}
