'use client';

import Link from 'next/link';
import { useCountUp } from '@/hooks/useCountUp';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/ui/cn';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { SiteShell } from '@/components/ui/SiteShell';
import { LeadIntakeForm } from '../lead-intake/LeadIntakeForm';
import { useReveal } from './useReveal';
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

const FEATURES = [
  { id: 'f-reply',     n: '01', label: 'Reply',      sub: 'The drafter',       group: 'Your agent team' },
  { id: 'f-guardian',  n: '02', label: 'Guardian',   sub: 'Negative lane',     group: 'Your agent team' },
  { id: 'f-insights',  n: '03', label: 'Insights',   sub: 'Mondays',           group: 'Your agent team' },
  { id: 'f-gate',      n: '04', label: 'The Gate',   sub: 'Copilot',           group: 'Care and control' },
  { id: 'f-autopilot', n: '05', label: 'Autopilot',  sub: 'Within your rules', group: 'Care and control' },
  { id: 'f-watchdogs', n: '06', label: 'Watchdogs',  sub: 'Judge & Governor',  group: 'Care and control' },
  { id: 'f-lang',      n: '07', label: 'Languages',  sub: 'Reach',             group: 'Craft and proof' },
  { id: 'f-voice',     n: '08', label: 'Voice',      sub: 'Over time',         group: 'Craft and proof' },
  { id: 'f-roi',       n: '09', label: 'Results',    sub: 'Proof',             group: 'Craft and proof' },
];

const FEATURE_GROUPS = ['Your agent team', 'Care and control', 'Craft and proof'] as const;

const HERO_WORDS_LINE_1 = ['A', 'tireless', 'agent', 'drafts', 'a', 'reply', 'to', 'every', 'review.'];
const HERO_WORDS_LINE_2 = ['Nothing', 'goes', 'public', 'without', 'the', 'gate.'];

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

function HeroSection({
  heroIn,
  m1,
  m2,
  m3,
}: {
  heroIn: boolean;
  m1: number;
  m2: number;
  m3: number;
}) {
  return (
    <section id="hero" aria-label="Features overview" className="feat-hero">
      <div className="rw-dl-col feat-hero-grid">
        <div>
          <p className={cn('feat-hero-kicker', heroIn && 'in')}>Features · Your agent team</p>
          <h1 className="feat-h1">
            <span className="rw-hero-line">
              {HERO_WORDS_LINE_1.map((w, i) => (
                <span
                  key={`l1-${w}`}
                  className={cn('rw-hero-word', heroIn && 'in')}
                  style={{ ['--word-delay' as string]: `${80 + i * 80}ms` }}
                >
                  {w}
                </span>
              ))}
            </span>
            <span className="rw-hero-line">
              {HERO_WORDS_LINE_2.map((w, i) => (
                <span
                  key={`l2-${w}`}
                  className={cn('rw-hero-word', heroIn && 'in')}
                  style={{
                    ['--word-delay' as string]: `${80 + (HERO_WORDS_LINE_1.length + i) * 80}ms`,
                  }}
                >
                  {w}
                </span>
              ))}
            </span>
          </h1>
          <p className={cn('feat-hero-lede', heroIn && 'in')}>
            RepWorth is an AI agent team, not another dashboard. Reply drafts every response,
            Guardian triages the bad ones, Insights reports on Mondays, and two watchdogs, the
            Judge and the Governor, oversee anything that posts on its own. You pick the autonomy:
            approve every reply on Copilot, or let policy-cleared replies post themselves on
            Autopilot.
          </p>
        </div>

        <div className="feat-hero-metrics">
          {[
            { val: m1, target: 58, suffix: 'min', label: 'Target: time from review\nposted to reply', delay: '0.9s' },
            { val: m2, target: 96, suffix: '%', label: 'Goal: response rate\nacross all reviews', delay: '1.15s' },
            { val: m3, target: 30, suffix: 'sec', label: 'Aim: your time per\napproval, after week 4', delay: '1.4s' },
          ].map((m) => (
            <div
              key={m.label}
              className={cn('feat-hero-metric', heroIn && 'in')}
              style={{ '--m-delay': m.delay } as CSSProperties}
            >
              <span className="feat-hero-metric-n">
                {m.val}
                <small>{m.suffix}</small>
              </span>
              <span className="feat-hero-metric-l">{m.label}</span>
            </div>
          ))}
          <p className="rw-dl-fine">Illustrative targets, not live performance data.</p>
        </div>
      </div>

      {/* Hero review marquee */}
      <div className="rw-feat-marquee-mask" aria-hidden={false}>
        <div className="rw-feat-marquee-track">
          {[
            ...MARQUEE_REVIEWS.map((r) => ({ r, k: `a-${r.text}` })),
            ...MARQUEE_REVIEWS.map((r) => ({ r, k: `b-${r.text}` })),
          ].map(({ r, k }) => (
            <div key={k} className="feat-mq-chip">
              <span className="feat-mq-lang">{r.lang}</span>
              <span className="rw-dl-stars" aria-label={`${r.ratingValue} out of 5 stars`}>
                <span aria-hidden="true">{r.stars}</span>
              </span>
              <span className="feat-mq-text">{r.text}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureTOC({
  tocRef,
  tocSeen,
  onJump,
}: {
  tocRef: RefObject<HTMLDivElement | null>;
  tocSeen: boolean;
  onJump: (id: string) => void;
}) {
  return (
    <section aria-label="Feature index" className="rw-dl-band is-paper feat-toc">
      <div className="rw-dl-col">
        <div className="feat-toc-head">
          <span>Index</span>
          <span className="feat-toc-rule" aria-hidden="true" />
          <span>3 agents · 2 watchdogs · 2 modes</span>
        </div>
        <div ref={tocRef} className="feat-toc-groups">
          {FEATURE_GROUPS.map((group) => (
            <div key={group}>
              <p className="feat-toc-group">{group}</p>
              <div className="feat-toc-grid">
                {FEATURES.filter((f) => f.group === group).map((f) => {
                  const i = FEATURES.indexOf(f);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => onJump(f.id)}
                      className={`feat-toc-chip ${tocSeen ? 'in' : ''}`}
                      style={{ ['--chip-delay' as string]: `${i * 70}ms` }}
                    >
                      <span className="feat-toc-chip-n">{f.n}</span>
                      <span className="feat-toc-chip-l">{f.label}</span>
                      <span className="feat-toc-chip-s">{f.sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

interface FeaturesContentProps {
  comingSoon?: boolean;
  selfServeEnabled?: boolean;
  /** Label for the /signup CTA when self-serve is on; null keeps the waitlist form. */
  signupCtaLabel?: string | null;
}

export function FeaturesContent({
  comingSoon = false,
  selfServeEnabled = false,
  signupCtaLabel = null,
}: FeaturesContentProps) {
  const showSignupCta = selfServeEnabled && signupCtaLabel !== null;
  // Section refs (one per feature) for the index jump targets.
  const replyRef = useRef<HTMLElement>(null);
  const guardianRef = useRef<HTMLElement>(null);
  const langRef = useRef<HTMLElement>(null);
  const gateRef = useRef<HTMLElement>(null);
  const autopilotRef = useRef<HTMLElement>(null);
  const watchdogsRef = useRef<HTMLElement>(null);
  const voiceRef = useRef<HTMLElement>(null);
  const insightsRef = useRef<HTMLElement>(null);
  const roiRef = useRef<HTMLElement>(null);
  const roadmapRef = useRef<HTMLElement>(null);

  const refMap = useMemo<Record<string, RefObject<HTMLElement | null>>>(
    () => ({
      'f-reply': replyRef,
      'f-guardian': guardianRef,
      'f-lang': langRef,
      'f-gate': gateRef,
      'f-autopilot': autopilotRef,
      'f-watchdogs': watchdogsRef,
      'f-voice': voiceRef,
      'f-insights': insightsRef,
      'f-roi': roiRef,
    }),
    []
  );

  const prefersReducedMotion = usePrefersReducedMotion();

  // Hero entry: trigger on mount via a deferred tick (avoids a synchronous
  // setState in the effect body). Under reduced motion, skip the staged delay
  // so the final frame appears immediately.
  const [heroIn, setHeroIn] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setHeroIn(true), prefersReducedMotion ? 0 : 50);
    return () => window.clearTimeout(id);
  }, [prefersReducedMotion]);

  // Metrics count-up; fire after hero is in.
  const m1 = useCountUp(58, { active: heroIn, duration: 1600, delayMs: 400, round: true });
  const m2 = useCountUp(96, { active: heroIn, duration: 1600, delayMs: 400, round: true });
  const m3 = useCountUp(30, { active: heroIn, duration: 1600, delayMs: 400, round: true });

  // TOC reveal trigger.
  const [tocRef, tocSeen] = useReveal<HTMLDivElement>();

  const scrollTo = (id: string) => {
    refMap[id]?.current?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  return (
    <SiteShell scope="rw-feat-page" comingSoon={comingSoon} selfServeEnabled={selfServeEnabled}>
      <HeroSection heroIn={heroIn} m1={m1} m2={m2} m3={m3} />

      <FeatureTOC tocRef={tocRef} tocSeen={tocSeen} onJump={scrollTo} />

      <FeatReply innerRef={replyRef} />
      <FeatGuardian innerRef={guardianRef} />
      <FeatInsights innerRef={insightsRef} />
      <FeatGate innerRef={gateRef} />
      <FeatAutopilot innerRef={autopilotRef} />
      <FeatWatchdogs innerRef={watchdogsRef} />
      <FeatLang innerRef={langRef} />
      <FeatVoice innerRef={voiceRef} />
      <FeatRoi innerRef={roiRef} />
      <RoadmapBand innerRef={roadmapRef} />

      {/* CTA — dark ink band */}
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
          <div>
            {comingSoon ? (
              <div className="rw-dl-cta-panel">
                <span className="rw-pill rw-pill-paper is-disabled">Coming soon</span>
              </div>
            ) : showSignupCta ? (
              <div className="rw-dl-cta-panel">
                <Link href="/signup" className="rw-pill rw-pill-paper feat-cta-pill">
                  {signupCtaLabel}
                </Link>
                <p className="rw-dl-fine">
                  Card required up front. Explicit plan selection. Cancel anytime.
                </p>
              </div>
            ) : (
              <div className="rw-dl-cta-panel">
                <LeadIntakeForm intent="waitlist" source="features" tone="onTeal" />
              </div>
            )}
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
