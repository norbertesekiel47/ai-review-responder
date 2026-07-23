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
  { id: 'f-autopilot', n: '05', label: 'Autopilot',  sub: 'Bounded autonomy',  group: 'Care and control' },
  { id: 'f-watchdogs', n: '06', label: 'Watchdogs',  sub: 'Judge & Governor',  group: 'Care and control' },
  { id: 'f-lang',      n: '07', label: 'Languages',  sub: 'Reach',             group: 'Craft and proof' },
  { id: 'f-voice',     n: '08', label: 'Voice',      sub: 'Over time',         group: 'Craft and proof' },
  { id: 'f-roi',       n: '09', label: 'ROI',        sub: 'Proof',             group: 'Craft and proof' },
];

const FEATURE_GROUPS = ['Your agent team', 'Care and control', 'Craft and proof'] as const;

const HERO_WORDS_LINE_1 = ['A', 'tireless', 'agent', 'answers', 'every', 'review.'];
const HERO_WORDS_LINE_2 = ['Nothing', 'goes', 'public', 'without', 'the'];
const HERO_SERIF_WORD = 'gate.';

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

function DotNav({
  activeSection,
  onJump,
}: {
  activeSection: string;
  onJump: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Section navigation"
      className="fixed right-6 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-1.5 bg-white/85 backdrop-blur-md rounded-3xl py-4 px-2 shadow-xl border border-rw-teal/20"
    >
      {FEATURES.map((f) => {
        const isActive = activeSection === f.id;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onJump(f.id)}
            aria-label={`Jump to ${f.label}`}
            className="group flex items-center gap-2 py-1.5 pl-2 pr-1"
          >
            <span className="rw-label-mono text-[10px] text-rw-ink-soft opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
              {f.label}
            </span>
            <span
              className={`w-2 h-2 rounded-full transition-all ${
                isActive ? 'bg-rw-teal rw-pulse-dot' : 'bg-rw-teal/30 group-hover:bg-rw-teal'
              }`}
            />
          </button>
        );
      })}
    </nav>
  );
}

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
    <section id="hero" aria-label="Features overview" className="relative px-8 md:px-16 pt-20 pb-12">
      <div className="grid md:grid-cols-12 gap-8 items-end">
        <div className="md:col-span-8">
          <p
            className={cn('rw-hero-kicker rw-label-mono text-xs uppercase text-rw-teal-strong mb-8 flex items-center gap-3', heroIn && 'in')}
          >
            <span className="line" />
            <span>Features · Your agent team</span>
          </p>
          <h1 className="text-[3.25rem] md:text-[4.75rem] leading-[0.95] tracking-tight text-rw-ink font-medium mb-6">
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
              <span
                className={cn('rw-hero-word rw-display-serif text-rw-teal-strong', heroIn && 'in')}
                style={{
                  ['--word-delay' as string]: `${80 + (HERO_WORDS_LINE_1.length + HERO_WORDS_LINE_2.length) * 80}ms`,
                }}
              >
                {HERO_SERIF_WORD}
              </span>
            </span>
          </h1>
          <p className={cn('rw-hero-lede text-lg text-rw-ink-soft max-w-md leading-relaxed', heroIn && 'in')}>
            RepWorth is an AI agent team, not another dashboard. Reply drafts every response,
            Guardian triages the bad ones, Insights reports on Mondays, and two watchdogs, the
            Judge and the Governor, oversee anything that posts on its own. You pick the autonomy:
            approve every reply on Copilot, or let policy-cleared replies post themselves on
            Autopilot.
          </p>
        </div>

        <div className="md:col-span-4 space-y-4">
          {[
            { val: m1, target: 58, suffix: 'min', label: 'Avg time from review\nposted to response', delay: '0.9s' },
            { val: m2, target: 96, suffix: '%', label: 'Response rate\nacross all reviews', delay: '1.15s' },
            { val: m3, target: 30, suffix: 'sec', label: 'Owner time per\napproval, after week 4', delay: '1.4s' },
          ].map((m, i) => (
            <div
              key={m.label}
              className={cn('rw-hero-metric relative flex items-baseline gap-3', i < 2 && 'pb-3', heroIn && 'in')}
              style={
                {
                  '--m-delay': m.delay,
                  '--u-delay': `${parseFloat(m.delay) + 0.1}s`,
                } as CSSProperties
              }
            >
              <span className="rw-num-tag text-5xl text-rw-ink">
                {m.val}
                <span className="text-lg text-rw-ink-soft ml-1">{m.suffix}</span>
              </span>
              <span className="text-xs text-rw-ink-soft leading-tight whitespace-pre-line">
                {m.label}
              </span>
              {i < 2 && <span className="rw-hero-metric-underline" />}
            </div>
          ))}
          <p className="text-[10px] italic text-rw-ink-soft pt-1">
            Illustrative targets, not live performance data.
          </p>
        </div>
      </div>

      {/* Hero review marquee */}
      <div className="mt-14 -mx-8 md:-mx-16 rw-feat-marquee-mask">
        <div className="rw-feat-marquee-track flex gap-3 whitespace-nowrap w-max">
          {[
            ...MARQUEE_REVIEWS.map((r) => ({ r, k: `a-${r.text}` })),
            ...MARQUEE_REVIEWS.map((r) => ({ r, k: `b-${r.text}` })),
          ].map(({ r, k }) => (
            <div
              key={k}
              className="flex items-center gap-3 px-4 py-2.5 rounded-full bg-rw-cream/70 border border-rw-teal/15"
            >
              <span className="rw-label-mono text-[10px] uppercase text-rw-teal-strong">{r.lang}</span>
              <span className="text-xs" aria-label={`${r.ratingValue} out of 5 stars`}>
                <span className="text-rw-teal" aria-hidden="true">{r.stars}</span>
              </span>
              <span className="text-sm text-rw-ink">{r.text}</span>
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
    <section
      aria-label="Feature index"
      className="px-8 md:px-16 py-10 border-y border-rw-teal/10 bg-rw-cream/40"
    >
      <div className="flex items-center gap-4 mb-6">
        <span className="rw-label-mono text-xs uppercase text-rw-teal-strong">Index</span>
        <div className="flex-1 h-px bg-rw-teal/20" />
        <span className="rw-label-mono text-xs uppercase text-rw-ink-soft">3 agents · 2 watchdogs · 2 modes</span>
      </div>
      <div ref={tocRef} className="space-y-6">
        {FEATURE_GROUPS.map((group) => (
          <div key={group}>
            <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-2">{group}</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {FEATURES.filter((f) => f.group === group).map((f) => {
                const i = FEATURES.indexOf(f);
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => onJump(f.id)}
                    className={`rw-toc-chip group flex flex-col gap-1 p-3 rounded-2xl border border-rw-teal/15 bg-white hover:bg-rw-teal/5 hover:border-rw-teal/40 text-left ${tocSeen ? 'in' : ''}`}
                    style={{ ['--chip-delay' as string]: `${i * 70}ms` }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="rw-num-tag text-lg text-rw-teal-strong">{f.n}</span>
                      <svg
                        className="size-3 text-rw-ink-soft group-hover:text-rw-teal-strong transition-colors"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
                      </svg>
                    </div>
                    <span className="text-sm font-medium text-rw-ink">{f.label}</span>
                    <span className="rw-label-mono text-[10px] uppercase text-rw-ink-soft">{f.sub}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface FeaturesContentProps {
  comingSoon?: boolean;
  selfServeEnabled?: boolean;
}

export function FeaturesContent({
  comingSoon = false,
  selfServeEnabled = false,
}: FeaturesContentProps) {
  // Section refs (one per feature) for the dot nav.
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

  const [activeSection, setActiveSection] = useState<string>('f-reply');

  // Track the section currently in view for the dot nav.
  useEffect(() => {
    const observers: IntersectionObserver[] = [];
    FEATURES.forEach((f) => {
      const el = refMap[f.id]?.current;
      if (!el) return;
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) setActiveSection(f.id);
          });
        },
        { rootMargin: '-40% 0px -50% 0px' }
      );
      io.observe(el);
      observers.push(io);
    });
    return () => observers.forEach((o) => o.disconnect());
  }, [refMap]);

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
    <SiteShell
      scope="rw-feat-page"
      comingSoon={comingSoon}
      selfServeEnabled={selfServeEnabled}
      overlay={<DotNav activeSection={activeSection} onJump={scrollTo} />}
    >

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

          {/* CTA */}
          <section
            aria-label="Call to action"
            className="px-8 md:px-16 py-24 text-center relative overflow-hidden"
            style={{ background: 'linear-gradient(135deg, #557069, #46645d)' }}
          >
            <svg
              className="absolute -top-20 -left-20 size-80 opacity-20"
              viewBox="0 0 200 200"
              fill="none"
              aria-hidden
            >
              <circle cx="100" cy="100" r="80" stroke="white" strokeWidth="1" />
              <circle cx="100" cy="100" r="60" stroke="white" strokeWidth="1" />
              <circle cx="100" cy="100" r="40" stroke="white" strokeWidth="1" />
            </svg>
            <svg
              className="absolute -bottom-32 -right-20 size-96 opacity-15"
              viewBox="0 0 200 200"
              fill="none"
              aria-hidden
            >
              <circle cx="100" cy="100" r="80" stroke="white" strokeWidth="1" />
              <circle cx="100" cy="100" r="60" stroke="white" strokeWidth="1" />
            </svg>
            <p className="rw-label-mono text-xs uppercase text-white/75 mb-6 relative">
              Early access
            </p>
            <h2 className="text-4xl md:text-6xl font-medium text-white leading-tight mb-5 relative max-w-3xl mx-auto">
              Join the early access waitlist.
            </h2>
            <p className="text-white/85 text-lg mb-10 relative max-w-xl mx-auto leading-relaxed">
              Tell us about your business and we&apos;ll reach out when early access opens for
              your area.
            </p>
            <div className="relative w-full max-w-md mx-auto">
              {comingSoon ? (
                <span className="inline-block px-8 py-4 bg-white text-rw-teal-strong rounded-full font-medium shadow-xl opacity-60 cursor-default select-none">
                  Coming soon
                </span>
              ) : (
                <LeadIntakeForm intent="waitlist" source="features" tone="onTeal" />
              )}
            </div>
            <div className="relative mt-6">
              <Link
                href="/how-it-works"
                className="inline-flex items-center gap-1 text-sm text-white/80 underline underline-offset-4 decoration-white/40 hover:text-white hover:decoration-white transition-colors"
              >
                See how it works
                <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
                </svg>
              </Link>
            </div>
          </section>
    </SiteShell>
  );
}

