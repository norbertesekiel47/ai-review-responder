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
import { FeatLang } from './FeatLang';
import { FeatGate } from './FeatGate';
import { FeatVoice } from './FeatVoice';
import { FeatRoi } from './FeatRoi';

const FEATURES = [
  { id: 'f-reply',   n: '01', label: 'Reply',        sub: 'The drafter' },
  { id: 'f-lang',    n: '02', label: 'Languages',    sub: 'Reach' },
  { id: 'f-gate',    n: '04', label: 'The Gate',     sub: 'Copilot' },
  { id: 'f-voice',   n: '04', label: 'Voice',        sub: 'Over time' },
  { id: 'f-brief',   n: '05', label: 'Weekly brief', sub: 'Mondays' },
  { id: 'f-roi',     n: '06', label: 'ROI',          sub: 'Proof' },
  { id: 'f-comp',    n: '07', label: 'Competitor',   sub: 'Coming soon' },
];

const HERO_WORDS_LINE_1 = ['Everything', 'your', 'reviews', 'need,'];
const HERO_WORDS_LINE_2 = ['nothing', 'you', "don't."];

// Illustrative sample reviews — not real customer testimonials. Multilingual to
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

const BRIEF_MENTIONS = [
  { topic: 'al pastor tacos', count: '7×', width: 88, tone: 'sage' as const },
  { topic: 'friendly staff', count: '6×', width: 75, tone: 'sage' as const },
  { topic: 'wait time', count: '4×', width: 50, tone: 'peach' as const },
  { topic: 'parking', count: '2×', width: 25, tone: 'peach' as const },
];

// Illustrative scorecard for an unreleased feature ("Coming soon" / preview).
// Competitors are anonymized placeholders, not real businesses.
const COMPETITOR_ROWS = [
  { rank: '#1', name: 'You', stars: '4.8', resp: '96% responded', highlighted: true },
  { rank: '#2', name: 'Competitor A', stars: '4.4', resp: 'Sample data' },
  { rank: '#3', name: 'Competitor B', stars: '4.2', resp: 'Sample data' },
  { rank: '#4', name: 'Competitor C', stars: '4.0', resp: 'Sample data' },
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
            <span>Features · 2026 Edition</span>
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
              <span
                className={cn('rw-hero-word rw-display-serif text-rw-teal-strong', heroIn && 'in')}
                style={{ ['--word-delay' as string]: `${80 + HERO_WORDS_LINE_1.length * 80}ms` }}
              >
                nothing
              </span>
              {HERO_WORDS_LINE_2.slice(1).map((w, i) => (
                <span
                  key={`l2-${w}`}
                  className={cn('rw-hero-word', heroIn && 'in')}
                  style={{
                    ['--word-delay' as string]: `${80 + (HERO_WORDS_LINE_1.length + 1 + i) * 80}ms`,
                  }}
                >
                  {w}
                </span>
              ))}
            </span>
          </h1>
          <p className={cn('rw-hero-lede text-lg text-rw-ink-soft max-w-md leading-relaxed', heroIn && 'in')}>
            RepWorth is a done-for-you service and not another dashboard to learn.
            Six features today, one in testing, one weekly rhythm, zero late-night copywriting.
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
        <span className="rw-label-mono text-xs uppercase text-rw-ink-soft">6 live · 1 in testing</span>
      </div>
      <div ref={tocRef} className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {FEATURES.map((f, i) => (
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
  const langRef = useRef<HTMLElement>(null);
  const gateRef = useRef<HTMLElement>(null);
  const voiceRef = useRef<HTMLElement>(null);
  const briefRef = useRef<HTMLElement>(null);
  const roiRef = useRef<HTMLElement>(null);
  const compRef = useRef<HTMLElement>(null);

  const refMap = useMemo<Record<string, RefObject<HTMLElement | null>>>(
    () => ({
      'f-reply': replyRef,
      'f-lang': langRef,
      'f-gate': gateRef,
      'f-voice': voiceRef,
      'f-brief': briefRef,
      'f-roi': roiRef,
      'f-comp': compRef,
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

  // Hero entry — trigger on mount via a deferred tick (avoids a synchronous
  // setState in the effect body). Under reduced motion, skip the staged delay
  // so the final frame appears immediately.
  const [heroIn, setHeroIn] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setHeroIn(true), prefersReducedMotion ? 0 : 50);
    return () => window.clearTimeout(id);
  }, [prefersReducedMotion]);

  // Metrics count-up — fire after hero is in.
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
          <FeatLang innerRef={langRef} />
          <FeatGate innerRef={gateRef} />
          <FeatVoice innerRef={voiceRef} />
          <FeatBrief innerRef={briefRef} />
          <FeatRoi innerRef={roiRef} />
          <FeatComp innerRef={compRef} />

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
              What&apos;s next
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

/* ================== 05 BRIEF ================== */
function FeatBrief({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [leftRef, leftSeen] = useReveal<HTMLDivElement>();
  const [rightRef, rightSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-brief"
      aria-label="Weekly brief"
      className="px-8 md:px-16 py-20 relative"
    >
      <div className="grid md:grid-cols-12 gap-10 items-start">
        <div ref={leftRef} className={`rw-reveal from-left md:col-span-5 ${leftSeen ? 'in' : ''}`}>
          <span className="rw-num-tag text-7xl leading-none text-rw-teal/40 block mb-4" aria-hidden="true">05</span>
          <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Every Monday morning</p>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight mb-5">
            A brief you&apos;ll <span className="rw-display-serif text-rw-teal-strong">actually</span> read.
          </h2>
          <p className="text-rw-ink-soft max-w-md leading-relaxed mb-6">
            Not a dashboard. Not a chart dump. A short, plain-language summary of what customers said
            this week: what they loved, what they complained about, and what to look at on the ops side.
          </p>
          <ul className="space-y-3 text-sm">
            {[
              'Review volume and trend',
              'One concrete operational suggestion',
            ].map((t) => (
              <li key={t} className="flex items-start gap-3">
                <span className="mt-1.5 size-1.5 rounded-full bg-rw-teal shrink-0" />
                <span className="text-rw-ink">{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div ref={rightRef} className={`rw-reveal from-right md:col-span-7 ${rightSeen ? 'in' : ''}`}>
          <article className="bg-rw-cream rounded-3xl p-8 md:p-10 border border-rw-teal/15 shadow-xl">
            <div className="flex items-start justify-between mb-6 pb-4 border-b border-rw-teal/20">
              <div>
                <p className="rw-label-mono text-xs uppercase text-rw-teal-strong">Weekly brief · sample</p>
                <p className="rw-display-serif text-2xl text-rw-ink mt-1">Your Business</p>
              </div>
              <div className="text-right">
                <p className="rw-label-mono text-[10px] text-rw-ink-soft">ISSUE</p>
                <p className="rw-label-mono text-xs text-rw-ink">18 · Apr 14–20</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-6">
              <div>
                <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-1">Reviews</p>
                <p className="rw-num-tag text-3xl text-rw-ink">14 <span className="text-xs text-rw-teal-strong">↑3</span></p>
              </div>
              <div>
                <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-1">Avg stars</p>
                <p className="rw-num-tag text-3xl text-rw-ink">4.6 <span className="text-xs text-rw-teal-strong">↑0.2</span></p>
              </div>
              <div>
                <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-1">Responded</p>
                <p className="rw-num-tag text-3xl text-rw-ink">96<span className="text-lg">%</span></p>
              </div>
            </div>

            <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-3">Top mentions this week</p>
            <div className="space-y-2 mb-6">
              {BRIEF_MENTIONS.map((m, i) => {
                const dot = m.tone === 'sage' ? 'bg-rw-teal' : 'bg-rw-peach';
                const fill = m.tone === 'sage' ? 'bg-rw-teal' : 'bg-rw-peach';
                const track = m.tone === 'sage' ? 'bg-rw-teal/15' : 'bg-rw-peach/20';
                return (
                  <div key={m.topic} className="flex items-center gap-3 text-sm bg-white rounded-xl px-3 py-2">
                    <span className={`w-2 h-2 rounded-full ${dot}`} />
                    <span className="text-rw-ink flex-1">{m.topic}</span>
                    <span className={`w-24 h-1.5 rounded-full overflow-hidden ${track}`}>
                      <span
                        className={`rw-brief-bar-fill ${fill}`}
                        style={
                          {
                            '--fill-w': `${m.width}%`,
                            '--fill-d': `${400 + i * 150}ms`,
                          } as CSSProperties
                        }
                      />
                    </span>
                    <span className="rw-label-mono text-xs text-rw-ink-soft w-8 text-right">{m.count}</span>
                  </div>
                );
              })}
            </div>

            <div className="border-t border-rw-teal/20 pt-5">
              <p className="rw-label-mono text-[10px] uppercase text-rw-teal-strong mb-2">One thing to look at</p>
              <p className="text-rw-ink rw-display-serif text-lg leading-snug">
                &ldquo;Wait time came up in 4 reviews this week; all on Saturday nights. Worth looking at
                7–9pm staffing.&rdquo;
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ================== 07 COMPETITOR ================== */
function FeatComp({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [leftRef, leftSeen] = useReveal<HTMLDivElement>();
  const [rightRef, rightSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-comp"
      aria-label="Competitor monitoring"
      className="px-8 md:px-16 py-20 relative"
    >
      <div className="grid md:grid-cols-12 gap-10 items-center">
        <div ref={leftRef} className={`rw-reveal from-left md:col-span-6 ${leftSeen ? 'in' : ''}`}>
          <div className="flex items-start gap-6 mb-6">
            <span className="rw-num-tag text-7xl leading-none text-rw-teal/40" aria-hidden="true">07</span>
            <div>
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <p className="rw-label-mono text-xs uppercase text-rw-teal-strong">Coming Soon</p>
                <span className="inline-block w-px h-4 bg-rw-teal/30" />
                <p className="rw-label-mono text-xs uppercase text-rw-ink-soft">In private testing</p>
              </div>
              <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight">
                Know where you <span className="rw-display-serif text-rw-teal-strong">stand</span> on the block.
              </h2>
            </div>
          </div>
          <p className="text-rw-ink-soft max-w-md leading-relaxed">
            Track the shop next door. Response rates, star trends, the words showing up in their reviews
            vs. yours. A one-page local market read, refreshed weekly.
          </p>
        </div>

        <div ref={rightRef} className={`rw-reveal from-right md:col-span-6 ${rightSeen ? 'in' : ''}`}>
          <div className="bg-white rounded-3xl p-6 border border-rw-teal/15 shadow-lg relative overflow-hidden">
            <span className="absolute top-4 right-4 rw-label-mono text-[10px] uppercase text-rw-peach bg-rw-peach/15 px-2 py-1 rounded-full border border-rw-peach/40">
              preview
            </span>
            <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-4">
              Neighborhood scorecard · sample data
            </p>
            <div className="space-y-3">
              {COMPETITOR_ROWS.map((r, i) => (
                <div
                  key={r.name}
                  className={`rw-comp-row flex items-center gap-3 p-3 rounded-2xl ${
                    r.highlighted ? 'bg-rw-teal/10 border border-rw-teal/30' : ''
                  }`}
                  style={{ ['--cr-d' as string]: `${120 + i * 140}ms` }}
                >
                  <span className={`rw-num-tag text-2xl w-8 ${r.highlighted ? 'text-rw-ink' : 'text-rw-ink-soft'}`}>
                    {r.rank}
                  </span>
                  <div className="flex-1">
                    <p className={`text-sm ${r.highlighted ? 'font-medium text-rw-ink' : 'text-rw-ink'}`}>
                      {r.name}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-rw-ink-soft">
                      <span aria-label={`${r.stars} out of 5 stars`}>
                        <span aria-hidden="true">★</span> {r.stars}
                      </span>
                      <span>·</span>
                      <span>{r.resp}</span>
                    </div>
                  </div>
                  {r.highlighted && (
                    <svg className="size-4 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
