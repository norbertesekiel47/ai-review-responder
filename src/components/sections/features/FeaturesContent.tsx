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
  type RefObject,
} from 'react';
import { SiteShell } from '@/components/ui/SiteShell';
import { LeadIntakeForm } from '../lead-intake/LeadIntakeForm';
import { useReveal } from './useReveal';
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

// Illustrative targets — the stack's fine print labels them as such. The bar
// is each card's colour bar (sage / teal / mist), wiping in with the card.
const HERO_METRICS = [
  { target: 58, suffix: 'min', label: 'Target: time from review\nposted to reply', bar: 'var(--rw-sage-bar)' },
  { target: 96, suffix: '%', label: 'Goal: response rate\nacross all reviews', bar: 'var(--rw-teal-bar)' },
  { target: 30, suffix: 'sec', label: 'Aim: your time per\napproval, after week 4', bar: 'var(--rw-mist-bar)' },
] as const;

const METRIC_DELAY_MS = 600;
const METRIC_STAGGER_MS = 280;

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

// The marquee track is doubled so the -50% translate loops seamlessly.
const MARQUEE_TRACK = [
  ...MARQUEE_REVIEWS.map((r) => ({ r, k: `a-${r.text}` })),
  ...MARQUEE_REVIEWS.map((r) => ({ r, k: `b-${r.text}` })),
];

function HeroSection({
  heroIn,
  values,
}: {
  heroIn: boolean;
  values: readonly [number, number, number];
}) {
  return (
    <section className={cn('feat-hero', heroIn && 'is-in')} aria-labelledby="feat-h1">
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
            RepWorth is an AI agent team, not another dashboard. Reply drafts every response,
            Guardian triages the bad ones, Insights reports on Mondays, and two watchdogs, the
            Judge and the Governor, oversee anything that posts on its own. You pick the autonomy:
            approve every reply on Copilot, or let policy-cleared replies post themselves on
            Autopilot.
          </p>
          <div className="feat-hero-links feat-fade d2">
            <Link href="/pricing" className="rw-dl-txtlink">
              See pricing <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        {/* The three targets as a stack of stat cards: left bar wipes in, cards
            stagger top → bottom, numbers count up (the /how-it-works stat card). */}
        <div className="feat-hero-stats">
          {HERO_METRICS.map((m, i) => (
            <div
              key={m.label}
              className="feat-stat"
              style={
                {
                  '--bar': m.bar,
                  '--m-delay': `${METRIC_DELAY_MS + i * METRIC_STAGGER_MS}ms`,
                } as CSSProperties
              }
            >
              <div className="feat-stat-n">
                {values[i]}
                <small>{m.suffix}</small>
              </div>
              <div className="feat-stat-d">{m.label}</div>
            </div>
          ))}
          <p className="rw-dl-fine feat-fade d3">Illustrative targets, not live performance data.</p>
        </div>
      </div>

      {/* Hero review marquee */}
      <div className="rw-feat-marquee-mask" aria-hidden={false}>
        <div className="rw-feat-marquee-track">
          {MARQUEE_TRACK.map(({ r, k }) => (
            <div key={k} className="feat-mq-chip">
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
    <section id="feat-index" aria-label="Feature index" className="rw-dl-band is-paper feat-toc">
      <div className="rw-dl-col">
        <div className="feat-toc-head">
          <span>Index</span>
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
    <section aria-label="Call to action" className="rw-dl-cta">
      <div className="rw-dl-col">
        <div>
          <h2>{showSignupCta ? 'Start with Copilot today.' : 'Join the early access waitlist.'}</h2>
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

  // Metrics count up in step with their card's stagger.
  const m1 = useCountUp(HERO_METRICS[0].target, { active: heroIn, duration: 1400, delayMs: METRIC_DELAY_MS, round: true });
  const m2 = useCountUp(HERO_METRICS[1].target, { active: heroIn, duration: 1400, delayMs: METRIC_DELAY_MS + METRIC_STAGGER_MS, round: true });
  const m3 = useCountUp(HERO_METRICS[2].target, { active: heroIn, duration: 1400, delayMs: METRIC_DELAY_MS + 2 * METRIC_STAGGER_MS, round: true });

  const scrollTo = (id: ChapterId) => {
    refs[id].current?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  return (
    <SiteShell scope="rw-feat-page" comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} trialEnabled={trialEnabled}>
      <HeroSection heroIn={heroIn} values={[m1, m2, m3]} />
      <FeatureIndex onJump={scrollTo} />

      <FeatReply innerRef={refs['f-reply']} />
      <FeatGuardian innerRef={refs['f-guardian']} />
      <FeatInsights innerRef={refs['f-insights']} />
      <FeatGate innerRef={refs['f-gate']} />
      <FeatAutopilot innerRef={refs['f-autopilot']} />
      <FeatWatchdogs innerRef={refs['f-watchdogs']} />
      <FeatLang innerRef={refs['f-lang']} />
      <FeatVoice innerRef={refs['f-voice']} />
      <FeatRoi innerRef={refs['f-roi']} />
      <RoadmapBand />

      <FeaturesCta comingSoon={comingSoon} signupCtaLabel={selfServeEnabled ? signupCtaLabel : null} />
    </SiteShell>
  );
}
