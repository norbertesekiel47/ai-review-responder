'use client';

import Link from 'next/link';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react';
import { MarqueeBackground } from '@/components/ui/MarqueeBackground';
import { SiteNav } from '@/components/ui/SiteNav';
import { LeadIntakeForm } from '../lead-intake/LeadIntakeForm';

const FEATURES = [
  { id: 'f-ai',      n: '01', label: 'AI drafting',  sub: 'The engine' },
  { id: 'f-lang',    n: '02', label: 'Languages',    sub: 'Reach' },
  { id: 'f-approve', n: '03', label: 'Approval',     sub: 'Your control' },
  { id: 'f-voice',   n: '04', label: 'Voice',        sub: 'Over time' },
  { id: 'f-brief',   n: '05', label: 'Weekly brief', sub: 'Monday 7am' },
  { id: 'f-roi',     n: '06', label: 'ROI',          sub: 'Proof' },
  { id: 'f-comp',    n: '07', label: 'Competitor',   sub: 'Coming Q3' },
];

const HERO_WORDS_LINE_1 = ['Everything', 'your', 'reviews', 'need,'];
const HERO_WORDS_LINE_2 = ['nothing', 'you', "don't."];

const MARQUEE_REVIEWS: Array<{ lang: string; stars: string; text: string }> = [
  { lang: 'EN', stars: '★★★★★', text: '"Best al pastor tacos in the city — Sarah K."' },
  { lang: 'ES', stars: '★★★★★', text: '"El mole es auténtico — Carlos M."' },
  { lang: 'EN', stars: '★★★★☆', text: '"Always remember my order — Daniel T."' },
  { lang: 'VI', stars: '★★★★★', text: '"Phở ngon nhất khu này — Linh N."' },
  { lang: 'EN', stars: '★★★★★', text: '"They saved my anniversary dinner — Em B."' },
  { lang: 'ZH', stars: '★★★★☆', text: '"汤底很赞 — 张先生"' },
  { lang: 'EN', stars: '★★★★★', text: '"Worth the drive across town — Marcus O."' },
  { lang: 'KO', stars: '★★★★★', text: '"불고기 정말 맛있어요 — Min J."' },
  { lang: 'EN', stars: '★★★★☆', text: '"Made my Monday — David K."' },
];

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!ref.current || seen) return;
    const r = ref.current.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setSeen(true)),
      { threshold: 0.08, rootMargin: '0px 0px -80px 0px' }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

function useCountUp(target: number, active: boolean, duration = 1600) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const t0 = performance.now() + 400;
    const tick = (t: number) => {
      const k = Math.max(0, Math.min(1, (t - t0) / duration));
      const eased = 1 - Math.pow(1 - k, 3);
      setV(Math.round(target * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, active]);
  return v;
}

function FeatureSection({
  innerRef,
  id,
  label,
  className = '',
  children,
}: {
  innerRef: MutableRefObject<HTMLElement | null>;
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section ref={innerRef} id={id} aria-label={label} className={className}>
      {children}
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
  const aiRef = useRef<HTMLElement>(null);
  const langRef = useRef<HTMLElement>(null);
  const approveRef = useRef<HTMLElement>(null);
  const voiceRef = useRef<HTMLElement>(null);
  const briefRef = useRef<HTMLElement>(null);
  const roiRef = useRef<HTMLElement>(null);
  const compRef = useRef<HTMLElement>(null);

  const refMap: Record<string, RefObject<HTMLElement | null>> = {
    'f-ai': aiRef,
    'f-lang': langRef,
    'f-approve': approveRef,
    'f-voice': voiceRef,
    'f-brief': briefRef,
    'f-roi': roiRef,
    'f-comp': compRef,
  };

  const [activeSection, setActiveSection] = useState<string>('f-ai');

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
    // refMap is stable across renders (refs only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hero entry — trigger immediately on mount.
  const [heroIn, setHeroIn] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setHeroIn(true), 50);
    return () => window.clearTimeout(id);
  }, []);

  // Metrics count-up — fire after hero is in.
  const m1 = useCountUp(58, heroIn);
  const m2 = useCountUp(100, heroIn);
  const m3 = useCountUp(30, heroIn);

  // TOC reveal trigger.
  const [tocRef, tocSeen] = useReveal<HTMLDivElement>();

  const scrollTo = (id: string) => {
    refMap[id]?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="rw-feat-page">
      <MarqueeBackground />

      {/* Right-rail dot navigation */}
      <nav
        aria-label="Section navigation"
        className="fixed right-6 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-1.5 bg-white/85 backdrop-blur-md rounded-3xl py-4 px-2 shadow-xl border border-[#97B3AE]/20"
      >
        {FEATURES.map((f) => {
          const isActive = activeSection === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => scrollTo(f.id)}
              aria-label={`Jump to ${f.label}`}
              className="group flex items-center gap-2 py-1.5 pl-2 pr-1"
            >
              <span className="rw-label-mono text-[10px] text-[#6a6a6a] opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                {f.label}
              </span>
              <span
                className={`w-2 h-2 rounded-full transition-all ${
                  isActive ? 'bg-[#97B3AE] rw-pulse-dot' : 'bg-[#97B3AE]/30 group-hover:bg-[#97B3AE]'
                }`}
              />
            </button>
          );
        })}
      </nav>

      {/* Island */}
      <div className="rw-island-wrap">
        <main className="rw-island">
          <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />

          {/* HERO */}
          <section
            id="hero"
            aria-label="Features overview"
            className="relative px-8 md:px-16 pt-20 pb-12"
          >
            <div className="grid md:grid-cols-12 gap-8 items-end">
              <div className="md:col-span-8">
                <p
                  className={`rw-hero-kicker rw-label-mono text-xs uppercase text-[#97B3AE] mb-8 flex items-center gap-3 ${heroIn ? 'in' : ''}`}
                >
                  <span className="line" />
                  <span>Features · 2026 Edition</span>
                </p>
                <h1 className="text-[3.25rem] md:text-[4.75rem] leading-[0.95] tracking-tight text-[#2a2a2a] font-medium mb-6">
                  <span className="block">
                    {HERO_WORDS_LINE_1.map((w, i) => (
                      <span
                        key={`l1-${i}`}
                        className={`rw-hero-word ${heroIn ? 'in' : ''}`}
                        style={{ ['--word-delay' as string]: `${80 + i * 80}ms` }}
                      >
                        {w}
                        {i < HERO_WORDS_LINE_1.length - 1 ? ' ' : ''}
                      </span>
                    ))}
                  </span>
                  <span className="block">
                    <span
                      className={`rw-hero-word rw-display-serif text-[#97B3AE] ${heroIn ? 'in' : ''}`}
                      style={{ ['--word-delay' as string]: `${80 + HERO_WORDS_LINE_1.length * 80}ms` }}
                    >
                      nothing{' '}
                    </span>
                    {HERO_WORDS_LINE_2.slice(1).map((w, i) => (
                      <span
                        key={`l2-${i}`}
                        className={`rw-hero-word ${heroIn ? 'in' : ''}`}
                        style={{
                          ['--word-delay' as string]: `${80 + (HERO_WORDS_LINE_1.length + 1 + i) * 80}ms`,
                        }}
                      >
                        {w}
                        {i < HERO_WORDS_LINE_2.length - 2 ? ' ' : ''}
                      </span>
                    ))}
                  </span>
                </h1>
                <p
                  className={`rw-hero-lede text-lg text-[#6a6a6a] max-w-md leading-relaxed ${heroIn ? 'in' : ''}`}
                >
                  RepWorth is a done-for-you service — not another dashboard to learn.
                  Seven pieces, one weekly rhythm, zero late-night copywriting.
                </p>
              </div>

              <div className="md:col-span-4 space-y-4">
                {[
                  { val: m1, target: 58, suffix: 'min', label: 'Avg time from review\nposted to response', delay: '0.9s' },
                  { val: m2, target: 100, suffix: '%', label: 'Response rate\nacross all reviews', delay: '1.15s' },
                  { val: m3, target: 30, suffix: 'sec', label: 'Owner time per\napproval, after week 4', delay: '1.4s' },
                ].map((m, i) => (
                  <div
                    key={i}
                    className={`rw-hero-metric relative flex items-baseline gap-3 ${i < 2 ? 'pb-3' : ''} ${heroIn ? 'in' : ''}`}
                    style={
                      {
                        '--m-delay': m.delay,
                        '--u-delay': `${parseFloat(m.delay) + 0.1}s`,
                      } as CSSProperties
                    }
                  >
                    <span className="rw-num-tag text-5xl text-[#2a2a2a]">
                      {m.val}
                      <span className="text-lg text-[#6a6a6a] ml-1">{m.suffix}</span>
                    </span>
                    <span className="text-xs text-[#6a6a6a] leading-tight whitespace-pre-line">
                      {m.label}
                    </span>
                    {i < 2 && <span className="rw-hero-metric-underline" />}
                  </div>
                ))}
              </div>
            </div>

            {/* Hero review marquee */}
            <div className="mt-14 -mx-8 md:-mx-16 rw-feat-marquee-mask">
              <div className="rw-feat-marquee-track flex gap-3 whitespace-nowrap w-max">
                {[...MARQUEE_REVIEWS, ...MARQUEE_REVIEWS].map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-full bg-[#F0EEEA]/70 border border-[#97B3AE]/15"
                  >
                    <span className="rw-label-mono text-[10px] uppercase text-[#97B3AE]">
                      {r.lang}
                    </span>
                    <span className="text-yellow-400 text-xs">{r.stars}</span>
                    <span className="text-sm text-[#2a2a2a]">{r.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* TOC */}
          <section
            aria-label="Feature index"
            className="px-8 md:px-16 py-10 border-y border-[#97B3AE]/10 bg-[#F0EEEA]/40"
          >
            <div className="flex items-center gap-4 mb-6">
              <span className="rw-label-mono text-xs uppercase text-[#97B3AE]">Index</span>
              <div className="flex-1 h-px bg-[#97B3AE]/20" />
              <span className="rw-label-mono text-xs uppercase text-[#6a6a6a]">07 features</span>
            </div>
            <div ref={tocRef} className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
              {FEATURES.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => scrollTo(f.id)}
                  className={`rw-toc-chip group flex flex-col gap-1 p-3 rounded-2xl border border-[#97B3AE]/15 bg-white hover:bg-[#97B3AE]/5 hover:border-[#97B3AE]/40 text-left ${tocSeen ? 'in' : ''}`}
                  style={{ ['--chip-delay' as string]: `${i * 70}ms` }}
                >
                  <div className="flex items-center justify-between">
                    <span className="rw-num-tag text-lg text-[#97B3AE]">{f.n}</span>
                    <svg
                      className="w-3 h-3 text-[#6a6a6a] group-hover:text-[#97B3AE] transition-colors"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
                    </svg>
                  </div>
                  <span className="text-sm font-medium text-[#2a2a2a]">{f.label}</span>
                  <span className="rw-label-mono text-[10px] uppercase text-[#6a6a6a]">{f.sub}</span>
                </button>
              ))}
            </div>
          </section>

          <FeatAi innerRef={aiRef} />
          <FeatLang innerRef={langRef} />
          <FeatApprove innerRef={approveRef} />
          <FeatVoice innerRef={voiceRef} />
          <FeatBrief innerRef={briefRef} />
          <FeatRoi innerRef={roiRef} />
          <FeatComp innerRef={compRef} />

          {/* CTA */}
          <section
            aria-label="Call to action"
            className="px-8 md:px-16 py-24 text-center relative overflow-hidden"
            style={{ background: 'linear-gradient(135deg, #97B3AE, rgba(151,179,174,0.82))' }}
          >
            <svg
              className="absolute -top-20 -left-20 w-80 h-80 opacity-20"
              viewBox="0 0 200 200"
              fill="none"
              aria-hidden
            >
              <circle cx="100" cy="100" r="80" stroke="white" strokeWidth="1" />
              <circle cx="100" cy="100" r="60" stroke="white" strokeWidth="1" />
              <circle cx="100" cy="100" r="40" stroke="white" strokeWidth="1" />
            </svg>
            <svg
              className="absolute -bottom-32 -right-20 w-96 h-96 opacity-15"
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
                <span className="inline-block px-8 py-4 bg-white text-[#97B3AE] rounded-full font-medium shadow-xl opacity-60 cursor-default select-none">
                  Coming soon
                </span>
              ) : (
                <LeadIntakeForm intent="waitlist" source="features" tone="onTeal" />
              )}
            </div>
            <div className="relative mt-6">
              <Link
                href="/how-it-works"
                className="inline-block px-8 py-4 text-white rounded-full font-medium border border-white/40 hover:bg-white/10 transition-colors"
              >
                See how it works
              </Link>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

/* ================== 01 AI ================== */
function FeatAi({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [tab, setTab] = useState<'before' | 'after'>('after');
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();

  const replies = {
    before: {
      label: 'Generic reply',
      meta: 'Template · no personalization',
      borderColor: 'rgba(242,195,185,0.6)',
      text: '"Thank you for your feedback! We appreciate your business and hope to see you again soon."',
      diag: [
        ['Named customer', 'No'],
        ['References detail', 'No'],
        ['Invites return', 'Generic'],
      ],
    },
    after: {
      label: 'Your response',
      meta: 'Personalized · in your voice',
      borderColor: 'rgba(151,179,174,0.35)',
      text: `"Sarah, thank you so much! We're thrilled the al pastor tacos hit the spot — our team makes the achiote marinade from scratch every morning. Looking forward to your next visit!"`,
      diag: [
        ['Named customer', 'Sarah'],
        ['References detail', 'Al pastor · achiote'],
        ['Invites return', 'Next visit'],
      ],
    },
  } as const;
  const r = replies[tab];

  return (
    <FeatureSection innerRef={innerRef} id="f-ai" label="AI drafting" className="px-8 md:px-16 py-20 relative">
      <div ref={headRef} className={`rw-reveal flex items-start gap-6 mb-10 ${headSeen ? 'in' : ''}`}>
        <span className="rw-num-tag text-7xl leading-none text-[#97B3AE]/40">01</span>
        <div className="flex-1">
          <p className="rw-label-mono text-xs uppercase text-[#97B3AE] mb-3">The engine</p>
          <h2 className="text-4xl md:text-5xl font-medium text-[#2a2a2a] leading-tight max-w-xl">
            Every reply written from scratch — <span className="rw-display-serif text-[#97B3AE]">never</span> from a template.
          </h2>
          <p className="text-[#6a6a6a] mt-4 max-w-xl leading-relaxed">
            Our AI reads the actual review, references specifics the customer mentioned, and writes in
            a voice that sounds like you wrote it yourself. No &ldquo;thanks for your feedback&rdquo; filler.
          </p>
        </div>
      </div>

      <div ref={cardRef} className={`rw-reveal bg-[#F0EEEA]/60 rounded-3xl p-6 md:p-10 border border-[#97B3AE]/10 ${cardSeen ? 'in' : ''}`}>
        <div className="flex items-center gap-2 mb-6">
          <button
            type="button"
            onClick={() => setTab('before')}
            className={`rw-label-mono text-xs uppercase tracking-wider px-3 py-1.5 rounded-full border border-[#2a2a2a]/20 transition-all ${
              tab === 'before' ? 'bg-[#2a2a2a] text-white shadow-md -translate-y-0.5' : 'text-[#6a6a6a] hover:text-[#2a2a2a]'
            }`}
          >
            Generic reply
          </button>
          <svg className="w-4 h-4 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
          </svg>
          <button
            type="button"
            onClick={() => setTab('after')}
            className={`rw-label-mono text-xs uppercase tracking-wider px-3 py-1.5 rounded-full border border-[#2a2a2a]/20 transition-all ${
              tab === 'after' ? 'bg-[#2a2a2a] text-white shadow-md -translate-y-0.5' : 'text-[#6a6a6a] hover:text-[#2a2a2a]'
            }`}
          >
            RepWorth reply
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-6 items-start">
          {/* Review card */}
          <div className="bg-white rounded-2xl p-6 border border-[#97B3AE]/10 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-10 h-10 rounded-full"
                style={{ background: 'linear-gradient(135deg, #F2C3B9, #D6CBBF)' }}
                aria-hidden
              />
              <div>
                <p className="text-sm font-medium text-[#2a2a2a]">Sarah K.</p>
                <div className="flex gap-0.5 text-yellow-400">★★★★★</div>
              </div>
              <span className="ml-auto text-xs rw-label-mono text-[#6a6a6a]">2h ago · Google</span>
            </div>
            <p className="text-[15px] text-[#2a2a2a] leading-relaxed">
              &ldquo;The al pastor tacos were incredible — the achiote marinade had this perfect
              smoky-sweet balance. Will be back next weekend!&rdquo;
            </p>
          </div>

          {/* Response card */}
          <div
            className="bg-white rounded-2xl p-6 border-2 shadow-sm"
            style={{ borderColor: r.borderColor, transition: 'border-color 0.5s ease' }}
          >
            <div className="flex items-center justify-between mb-4">
              <p className="rw-label-mono text-xs uppercase text-[#97B3AE]">{r.label}</p>
              <p className="text-xs rw-label-mono text-[#6a6a6a]">{r.meta}</p>
            </div>
            <p className="text-[15px] text-[#2a2a2a] leading-relaxed">{r.text}</p>
            <div className="mt-5 pt-5 border-t border-[#97B3AE]/10 grid grid-cols-3 gap-3 text-xs">
              {r.diag.map(([k, v]) => (
                <div key={k}>
                  <p className="rw-label-mono text-[#6a6a6a] mb-1">{k}</p>
                  <p className="text-[#2a2a2a] font-medium">{v}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}

/* ================== 02 LANGUAGES ================== */
function FeatLang({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [leftRef, leftSeen] = useReveal<HTMLDivElement>();
  const [rightRef, rightSeen] = useReveal<HTMLDivElement>();
  const langs = [
    { code: 'ES', name: 'Español' },
    { code: 'VI', name: 'Tiếng Việt' },
    { code: 'ZH', name: '中文' },
    { code: 'TL', name: 'Tagalog' },
    { code: 'KO', name: '한국어' },
    { code: '+14', name: 'more' },
  ];

  return (
    <FeatureSection
      innerRef={innerRef}
      id="f-lang"
      label="Multilingual support"
      className="px-8 md:px-16 py-20 bg-gradient-to-b from-white to-[#F0EEEA]/50 relative"
    >
      <div className="grid md:grid-cols-12 gap-10 items-start">
        <div ref={leftRef} className={`rw-reveal from-left md:col-span-5 ${leftSeen ? 'in' : ''}`}>
          <div className="flex items-start gap-6 mb-8">
            <span className="rw-num-tag text-7xl leading-none text-[#F2C3B9]/80">02</span>
            <div>
              <p className="rw-label-mono text-xs uppercase text-[#97B3AE] mb-3">Reach</p>
              <h2 className="text-4xl md:text-[2.75rem] font-medium text-[#2a2a2a] leading-tight">
                Multilingual, <span className="rw-display-serif text-[#97B3AE]">automatically</span>.
              </h2>
            </div>
          </div>
          <p className="text-[#6a6a6a] max-w-md leading-relaxed mb-8">
            RepWorth detects the language of every review and responds in the same language — no
            setup, no toggles. Your customers feel heard in their own words.
          </p>
          <div className="grid grid-cols-3 gap-2 max-w-md">
            {langs.map((l, i) => (
              <div
                key={l.code}
                className="rw-lang-chip bg-white rounded-2xl p-3 border border-[#97B3AE]/15 text-center"
                style={{ ['--chip-d' as string]: `${80 + i * 90}ms` }}
              >
                <p className="rw-label-mono text-[10px] text-[#6a6a6a] mb-0.5">{l.code}</p>
                <p className={`text-sm font-medium ${l.name === 'more' ? 'text-[#97B3AE]' : ''}`}>
                  {l.name}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div ref={rightRef} className={`rw-reveal from-right md:col-span-7 ${rightSeen ? 'in' : ''}`}>
          <div className="bg-white rounded-3xl p-6 border border-[#97B3AE]/15 shadow-sm max-w-md">
            <div className="flex items-center gap-2 mb-3">
              <div
                className="w-8 h-8 rounded-full"
                style={{ background: 'linear-gradient(135deg, #F2C3B9, #D6CBBF)' }}
                aria-hidden
              />
              <div>
                <p className="text-xs font-medium text-[#2a2a2a]">Carlos M.</p>
                <div className="flex gap-0.5 text-yellow-400 text-[10px]">★★★★★</div>
              </div>
              <span className="ml-auto rw-label-mono text-[10px] text-[#6a6a6a]">detected: ES</span>
            </div>
            <p className="text-sm text-[#2a2a2a] leading-relaxed">
              &ldquo;La mejor enchilada que he comido en años. El mole es auténtico. Volvería todos los
              fines de semana si pudiera.&rdquo;
            </p>
          </div>

          <svg className="ml-16 my-2 w-8 h-16 text-[#97B3AE]/40" viewBox="0 0 32 64" fill="none" aria-hidden>
            <path
              d="M16 0 V 48 M10 44 L 16 52 L 22 44"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray="3 4"
            />
          </svg>

          <div
            className="ml-16 md:ml-24 rounded-3xl p-6 border border-[#97B3AE]/25 max-w-md"
            style={{ background: 'rgba(151,179,174,0.08)' }}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="rw-label-mono text-[10px] uppercase text-[#97B3AE]">Your reply · ES</span>
              <span className="ml-auto rw-label-mono text-[10px] text-[#6a6a6a]">auto-generated</span>
            </div>
            <p className="text-sm text-[#2a2a2a] leading-relaxed">
              &ldquo;Carlos, ¡muchísimas gracias! El mole es la receta de mi abuela — tardan tres días
              en prepararlo. Nos alegra mucho que lo hayas disfrutado. ¡Hasta pronto!&rdquo;
            </p>
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}

/* ================== 03 APPROVAL ================== */
function FeatApprove({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [tlRef, tlSeen] = useReveal<HTMLDivElement>();
  const [phoneRef, phoneSeen] = useReveal<HTMLDivElement>();

  const steps = [
    { n: '01', title: 'New review lands', sub: 'Webhook from Google · detected in < 60 seconds', t: '0:00', dark: false, d: '100ms' },
    { n: '02', title: 'AI drafts a reply in your voice', sub: 'Uses past approvals as style reference', t: '+0:12', dark: false, d: '300ms' },
    { n: '03', title: 'You get a text or email', sub: 'Review + draft + three big buttons', t: '+0:15', dark: false, d: '500ms' },
    { n: '04', title: 'You tap approve · we post it', sub: 'Median owner time: 28 seconds · No login required', t: '+0:58', dark: true, d: '700ms' },
  ];

  return (
    <FeatureSection innerRef={innerRef} id="f-approve" label="One-tap approval" className="px-8 md:px-16 py-20 relative">
      <div ref={headRef} className={`rw-reveal flex items-start gap-6 mb-12 ${headSeen ? 'in' : ''}`}>
        <span className="rw-num-tag text-7xl leading-none text-[#D6CBBF]">03</span>
        <div className="flex-1">
          <p className="rw-label-mono text-xs uppercase text-[#97B3AE] mb-3">Your control</p>
          <h2 className="text-4xl md:text-5xl font-medium text-[#2a2a2a] leading-tight max-w-2xl">
            Every reply needs your <span className="rw-display-serif text-[#97B3AE]">sign-off</span>.
          </h2>
          <p className="text-[#6a6a6a] mt-4 max-w-xl leading-relaxed">
            You get an email with the customer&apos;s review and the AI draft side-by-side. Tap
            approve, edit inline, or ask for a fresh draft. Nothing is ever posted without your
            explicit go-ahead.
          </p>
        </div>
      </div>

      <div className="grid md:grid-cols-12 gap-10 items-center">
        <div ref={tlRef} className={`rw-reveal md:col-span-7 ${tlSeen ? 'in' : ''}`}>
          <ol className="space-y-4">
            {steps.map((s) => (
              <li
                key={s.n}
                className="rw-t-step flex gap-4 items-start"
                style={{ ['--step-d' as string]: s.d }}
              >
                <div
                  className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center rw-label-mono text-sm ${
                    s.dark ? 'bg-[#2a2a2a] text-white' : 'bg-[#97B3AE]/15 text-[#97B3AE]'
                  }`}
                >
                  {s.n}
                </div>
                <div
                  className={`flex-1 rounded-2xl p-4 border ${
                    s.dark
                      ? 'bg-[#2a2a2a] text-white border-[#2a2a2a]'
                      : 'bg-white text-[#2a2a2a] border-[#97B3AE]/15'
                  }`}
                >
                  <p className="text-sm font-medium">{s.title}</p>
                  <p className={`text-xs mt-0.5 ${s.dark ? 'opacity-80' : 'text-[#6a6a6a]'}`}>{s.sub}</p>
                </div>
                <span className="rw-label-mono text-xs text-[#6a6a6a] self-center">{s.t}</span>
              </li>
            ))}
          </ol>
        </div>

        <div ref={phoneRef} className={`rw-reveal scale-in md:col-span-5 flex justify-center ${phoneSeen ? 'in' : ''}`}>
          <div className="rw-phone-float relative w-[260px]" style={{ transform: 'rotate(-2deg)' }}>
            <div className="relative rounded-[2.5rem] p-[3px]" style={{ background: 'linear-gradient(135deg,#222,#444)' }}>
              <div className="rounded-[2.3rem] bg-[#F0EEEA] overflow-hidden">
                <div className="px-5 pt-3 pb-2 flex justify-between items-center text-[11px] rw-label-mono text-[#2a2a2a]">
                  <span>9:41</span>
                  <div className="w-20 h-5 rounded-full bg-[#2a2a2a]" />
                  <span>·</span>
                </div>
                <div className="p-4 space-y-3">
                  <div className="rw-phone-item bg-white rounded-xl p-3 shadow-sm" style={{ ['--pi-d' as string]: '400ms' }}>
                    <p className="rw-label-mono text-[10px] uppercase text-[#97B3AE] mb-1">New review</p>
                    <p className="text-[11px] text-[#6a6a6a]">★★★★★ · Sarah K.</p>
                    <p className="text-[12px] text-[#2a2a2a] mt-1 leading-snug">
                      &ldquo;Al pastor tacos were incredible — the achiote marinade…&rdquo;
                    </p>
                  </div>
                  <div
                    className="rw-phone-item rounded-xl p-3 border border-[#97B3AE]/25"
                    style={{ ['--pi-d' as string]: '650ms', background: 'rgba(151,179,174,0.10)' }}
                  >
                    <p className="rw-label-mono text-[10px] uppercase text-[#97B3AE] mb-1">Draft reply</p>
                    <p className="text-[12px] text-[#2a2a2a] leading-snug">
                      &ldquo;Sarah, thank you so much! We&apos;re thrilled the al pastor…&rdquo;
                    </p>
                  </div>
                  <div
                    className="rw-phone-item w-full bg-[#2a2a2a] text-white py-2.5 rounded-full text-[12px] font-medium flex items-center justify-center gap-1.5"
                    style={{ ['--pi-d' as string]: '900ms' }}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    Approve &amp; post
                  </div>
                  <div className="rw-phone-item grid grid-cols-2 gap-2" style={{ ['--pi-d' as string]: '1100ms' }}>
                    <div className="py-2 rounded-full text-[11px] border border-[#97B3AE]/30 text-[#6a6a6a] text-center">
                      Edit
                    </div>
                    <div className="py-2 rounded-full text-[11px] border border-[#97B3AE]/30 text-[#6a6a6a] text-center">
                      Redraft
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}

/* ================== 04 VOICE ================== */
function FeatVoice({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [chartRef, chartSeen] = useReveal<HTMLDivElement>();
  const bars = [
    { h: 85, op: 0.8, d: '80ms' },
    { h: 72, op: 0.7, d: '160ms' },
    { h: 61, op: 0.6, d: '240ms' },
    { h: 48, op: 0.55, d: '320ms' },
    { h: 35, op: 0.45, d: '400ms' },
    { h: 28, op: 0.4, d: '480ms' },
    { h: 18, op: 0.35, d: '560ms' },
    { h: 12, op: 1, d: '640ms', anno: true },
  ];

  return (
    <FeatureSection
      innerRef={innerRef}
      id="f-voice"
      label="Voice learning"
      className="px-8 md:px-16 py-20 bg-[#2a2a2a] text-white relative overflow-hidden"
    >
      <div
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.6) 1px, transparent 1.5px)',
          backgroundSize: '3px 3px',
        }}
        aria-hidden
      />
      <div className="relative grid md:grid-cols-12 gap-10 items-end">
        <div ref={headRef} className={`rw-reveal md:col-span-5 ${headSeen ? 'in' : ''}`}>
          <span className="rw-num-tag text-7xl leading-none text-white/20 block mb-4">04</span>
          <p className="rw-label-mono text-xs uppercase text-[#F2C3B9] mb-3">Over time</p>
          <h2 className="text-4xl md:text-5xl font-medium leading-tight mb-4">
            It learns your <span className="rw-display-serif text-[#F2C3B9]">voice</span> — edit by edit.
          </h2>
          <p className="text-white/70 max-w-md leading-relaxed">
            Every time you tweak a draft, RepWorth notices the change. Your warmth level, your phrasing,
            the way you handle a complaint. By week 8, most owners approve drafts untouched.
          </p>
        </div>

        <div ref={chartRef} className={`rw-reveal md:col-span-7 ${chartSeen ? 'in' : ''}`}>
          <div className="flex items-baseline justify-between mb-5">
            <p className="rw-label-mono text-xs uppercase text-white/50">% of drafts edited by owner</p>
            <p className="rw-label-mono text-xs text-[#F2C3B9]">↓ 86% over 8 weeks</p>
          </div>
          <div className="relative h-48">
            <div className="absolute inset-0 flex flex-col justify-between">
              <div className="border-t border-white/10" />
              <div className="border-t border-white/10" />
              <div className="border-t border-white/10" />
              <div className="border-t border-white/10" />
            </div>
            <div className="absolute inset-0 flex items-end gap-3 px-1">
              {bars.map((b, i) => (
                <div
                  key={i}
                  className="rw-voice-bar flex-1 rounded-t relative"
                  style={{
                    height: `${b.h}%`,
                    background: `rgba(242,195,185,${b.op})`,
                    ['--bar-d' as string]: b.d,
                  }}
                >
                  {b.anno && (
                    <div className="rw-voice-anno absolute -top-10 left-1/2 -translate-x-1/2 bg-[#F2C3B9] text-[#2a2a2a] rounded-lg px-2 py-1 rw-label-mono text-[10px] whitespace-nowrap">
                      most owners: hands-off
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-between mt-3 rw-label-mono text-[10px] text-white/50">
            {['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'].map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}

/* ================== 05 BRIEF ================== */
function FeatBrief({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [leftRef, leftSeen] = useReveal<HTMLDivElement>();
  const [rightRef, rightSeen] = useReveal<HTMLDivElement>();
  const mentions = [
    { topic: 'al pastor tacos', count: '7×', width: 88, tone: 'sage' as const },
    { topic: 'friendly staff', count: '6×', width: 75, tone: 'sage' as const },
    { topic: 'wait time', count: '4×', width: 50, tone: 'peach' as const },
    { topic: 'parking', count: '2×', width: 25, tone: 'peach' as const },
  ];

  return (
    <FeatureSection innerRef={innerRef} id="f-brief" label="Weekly brief" className="px-8 md:px-16 py-20 relative">
      <div className="grid md:grid-cols-12 gap-10 items-start">
        <div ref={leftRef} className={`rw-reveal from-left md:col-span-5 ${leftSeen ? 'in' : ''}`}>
          <span className="rw-num-tag text-7xl leading-none text-[#97B3AE]/40 block mb-4">05</span>
          <p className="rw-label-mono text-xs uppercase text-[#97B3AE] mb-3">Every Monday · 7am</p>
          <h2 className="text-4xl md:text-5xl font-medium text-[#2a2a2a] leading-tight mb-5">
            A brief you&apos;ll <span className="rw-display-serif text-[#97B3AE]">actually</span> read.
          </h2>
          <p className="text-[#6a6a6a] max-w-md leading-relaxed mb-6">
            Not a dashboard. Not a chart dump. A short, plain-language summary of what customers said
            this week — what they loved, what they complained about, and what to look at on the ops side.
          </p>
          <ul className="space-y-3 text-sm">
            {[
              'Top mentions, scored by sentiment',
              'Week-over-week review volume & stars',
              'One concrete operational suggestion',
            ].map((t) => (
              <li key={t} className="flex items-start gap-3">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#97B3AE] shrink-0" />
                <span className="text-[#2a2a2a]">{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div ref={rightRef} className={`rw-reveal from-right md:col-span-7 ${rightSeen ? 'in' : ''}`}>
          <article className="bg-[#F0EEEA] rounded-3xl p-8 md:p-10 border border-[#97B3AE]/15 shadow-xl">
            <div className="flex items-start justify-between mb-6 pb-4 border-b border-[#97B3AE]/20">
              <div>
                <p className="rw-label-mono text-xs uppercase text-[#97B3AE]">Weekly brief</p>
                <p className="rw-display-serif text-2xl text-[#2a2a2a] mt-1">Mama Rosa&apos;s Taqueria</p>
              </div>
              <div className="text-right">
                <p className="rw-label-mono text-[10px] text-[#6a6a6a]">ISSUE</p>
                <p className="rw-label-mono text-xs text-[#2a2a2a]">18 · Apr 14–20</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-6">
              <div>
                <p className="rw-label-mono text-[10px] uppercase text-[#6a6a6a] mb-1">Reviews</p>
                <p className="rw-num-tag text-3xl text-[#2a2a2a]">14 <span className="text-xs text-[#97B3AE]">↑3</span></p>
              </div>
              <div>
                <p className="rw-label-mono text-[10px] uppercase text-[#6a6a6a] mb-1">Avg stars</p>
                <p className="rw-num-tag text-3xl text-[#2a2a2a]">4.6 <span className="text-xs text-[#97B3AE]">↑0.2</span></p>
              </div>
              <div>
                <p className="rw-label-mono text-[10px] uppercase text-[#6a6a6a] mb-1">Responded</p>
                <p className="rw-num-tag text-3xl text-[#2a2a2a]">100<span className="text-lg">%</span></p>
              </div>
            </div>

            <p className="rw-label-mono text-[10px] uppercase text-[#6a6a6a] mb-3">Top mentions this week</p>
            <div className="space-y-2 mb-6">
              {mentions.map((m, i) => {
                const dot = m.tone === 'sage' ? 'bg-[#97B3AE]' : 'bg-[#F2C3B9]';
                const fill = m.tone === 'sage' ? 'bg-[#97B3AE]' : 'bg-[#F2C3B9]';
                const track = m.tone === 'sage' ? 'bg-[#97B3AE]/15' : 'bg-[#F2C3B9]/20';
                return (
                  <div key={m.topic} className="flex items-center gap-3 text-sm bg-white rounded-xl px-3 py-2">
                    <span className={`w-2 h-2 rounded-full ${dot}`} />
                    <span className="text-[#2a2a2a] flex-1">{m.topic}</span>
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
                    <span className="rw-label-mono text-xs text-[#6a6a6a] w-8 text-right">{m.count}</span>
                  </div>
                );
              })}
            </div>

            <div className="border-t border-[#97B3AE]/20 pt-5">
              <p className="rw-label-mono text-[10px] uppercase text-[#97B3AE] mb-2">One thing to look at</p>
              <p className="text-[#2a2a2a] rw-display-serif text-lg leading-snug">
                &ldquo;Wait time came up in 4 reviews this week — all on Saturday nights. Worth looking at
                7–9pm staffing.&rdquo;
              </p>
            </div>
          </article>
        </div>
      </div>
    </FeatureSection>
  );
}

/* ================== 06 ROI ================== */
function FeatRoi({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [gridRef, gridSeen] = useReveal<HTMLDivElement>();

  return (
    <FeatureSection
      innerRef={innerRef}
      id="f-roi"
      label="ROI dashboard"
      className="px-8 md:px-16 py-20 bg-[#F0EEEA]/50 relative"
    >
      <div ref={headRef} className={`rw-reveal flex items-start gap-6 mb-10 ${headSeen ? 'in' : ''}`}>
        <span className="rw-num-tag text-7xl leading-none text-[#D6CBBF]">06</span>
        <div className="flex-1 max-w-2xl">
          <p className="rw-label-mono text-xs uppercase text-[#97B3AE] mb-3">Proof</p>
          <h2 className="text-4xl md:text-5xl font-medium text-[#2a2a2a] leading-tight">
            Numbers to show your <span className="rw-display-serif text-[#97B3AE]">accountant</span>.
          </h2>
          <p className="text-[#6a6a6a] mt-4 leading-relaxed">
            Response rate before and after. Average time to respond. Where you sit in local search over
            90 days. The kind of numbers that justify the line item.
          </p>
        </div>
      </div>

      <div ref={gridRef} className={`rw-reveal grid md:grid-cols-12 gap-6 ${gridSeen ? 'in' : ''}`}>
        <div className="md:col-span-4 bg-white rounded-3xl p-6 border border-[#97B3AE]/15">
          <p className="rw-label-mono text-[10px] uppercase text-[#6a6a6a] mb-4">Response rate</p>
          <div className="flex items-baseline gap-3">
            <span className="rw-num-tag text-lg line-through text-[#6a6a6a]/60">12%</span>
            <svg className="w-4 h-4 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
            </svg>
            <span className="rw-num-tag text-4xl text-[#2a2a2a]">100<span className="text-lg">%</span></span>
          </div>
          <div className="mt-4 h-8 relative">
            <div className="absolute inset-0 bg-[#97B3AE]/15 rounded-full" />
            <div className="absolute inset-y-0 left-0 right-0 bg-[#97B3AE] rounded-full" />
          </div>
        </div>

        <div className="md:col-span-4 bg-white rounded-3xl p-6 border border-[#97B3AE]/15">
          <p className="rw-label-mono text-[10px] uppercase text-[#6a6a6a] mb-4">Avg response time</p>
          <div className="flex items-baseline gap-3">
            <span className="rw-num-tag text-lg line-through text-[#6a6a6a]/60">4 days</span>
            <svg className="w-4 h-4 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
            </svg>
            <span className="rw-num-tag text-4xl text-[#2a2a2a]">58<span className="text-lg">min</span></span>
          </div>
          <svg className="mt-4 w-full h-8" viewBox="0 0 200 32" preserveAspectRatio="none" aria-hidden>
            <path
              d="M0,4 L30,8 L60,14 L90,18 L120,22 L150,26 L180,28 L200,29"
              stroke="#97B3AE"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="200" cy="29" r="3" fill="#97B3AE" />
          </svg>
        </div>

        <div className="md:col-span-4 bg-white rounded-3xl p-6 border border-[#97B3AE]/15">
          <p className="rw-label-mono text-[10px] uppercase text-[#6a6a6a] mb-4">Local map rank</p>
          <div className="flex items-baseline gap-3">
            <span className="rw-num-tag text-lg line-through text-[#6a6a6a]/60">#14</span>
            <svg className="w-4 h-4 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
            </svg>
            <span className="rw-num-tag text-4xl text-[#2a2a2a]">#3</span>
          </div>
          <svg className="mt-4 w-full h-8" viewBox="0 0 200 32" preserveAspectRatio="none" aria-hidden>
            <path
              d="M0,28 L30,26 L60,22 L90,20 L120,14 L150,10 L180,6 L200,4"
              stroke="#97B3AE"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="200" cy="4" r="3" fill="#97B3AE" />
          </svg>
        </div>

        <div className="md:col-span-12 bg-[#2a2a2a] text-white rounded-3xl p-8 relative overflow-hidden">
          <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
            <div>
              <p className="rw-label-mono text-xs uppercase text-[#F2C3B9] mb-2">Google map position — 90 days</p>
              <p className="rw-display-serif text-2xl">From #14 to top 3 in the neighborhood.</p>
            </div>
            <div className="text-right">
              <p className="rw-label-mono text-[10px] text-white/50">SEARCH: &ldquo;taqueria near me&rdquo;</p>
              <p className="rw-label-mono text-[10px] text-white/50">RADIUS: 2mi</p>
            </div>
          </div>
          <div className="relative h-36">
            <svg className="w-full h-full" viewBox="0 0 800 144" preserveAspectRatio="none" aria-hidden>
              <line x1="0" y1="36" x2="800" y2="36" stroke="rgba(255,255,255,0.1)" />
              <line x1="0" y1="72" x2="800" y2="72" stroke="rgba(255,255,255,0.1)" />
              <line x1="0" y1="108" x2="800" y2="108" stroke="rgba(255,255,255,0.1)" />
              <path
                d="M0,124 L80,118 L160,110 L240,92 L320,84 L400,74 L480,60 L560,46 L640,38 L720,30 L800,24 L800,144 L0,144 Z"
                fill="rgba(242,195,185,0.15)"
              />
              <path
                className="rw-sparkline-path"
                d="M0,124 L80,118 L160,110 L240,92 L320,84 L400,74 L480,60 L560,46 L640,38 L720,30 L800,24"
                stroke="#F2C3B9"
                strokeWidth="2.5"
                fill="none"
                strokeLinecap="round"
              />
              <circle cx="800" cy="24" r="5" fill="#F2C3B9" />
              <circle cx="800" cy="24" r="10" fill="#F2C3B9" opacity="0.25" />
            </svg>
            <div className="absolute left-0 top-0 rw-label-mono text-[10px] text-white/50">#1</div>
            <div className="absolute left-0 bottom-0 rw-label-mono text-[10px] text-white/50">#20</div>
          </div>
          <div className="flex justify-between mt-3 rw-label-mono text-[10px] text-white/40">
            <span>Jan</span>
            <span>Feb</span>
            <span>Mar</span>
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}

/* ================== 07 COMPETITOR ================== */
function FeatComp({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [leftRef, leftSeen] = useReveal<HTMLDivElement>();
  const [rightRef, rightSeen] = useReveal<HTMLDivElement>();
  const rows = [
    { rank: '#1', name: 'You — Mama Rosa’s', stars: '4.8', resp: '100% responded', highlighted: true },
    { rank: '#2', name: 'El Farolito', stars: '4.4', resp: '28% responded' },
    { rank: '#3', name: 'La Taqueria', stars: '4.2', resp: '8% responded' },
    { rank: '#4', name: 'Tacos El Primo', stars: '4.0', resp: '0% responded' },
  ];

  return (
    <FeatureSection innerRef={innerRef} id="f-comp" label="Competitor monitoring" className="px-8 md:px-16 py-20 relative">
      <div className="grid md:grid-cols-12 gap-10 items-center">
        <div ref={leftRef} className={`rw-reveal from-left md:col-span-6 ${leftSeen ? 'in' : ''}`}>
          <div className="flex items-start gap-6 mb-6">
            <span className="rw-num-tag text-7xl leading-none text-[#97B3AE]/40">07</span>
            <div>
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <p className="rw-label-mono text-xs uppercase text-[#97B3AE]">Coming Q3</p>
                <span className="inline-block w-px h-4 bg-[#97B3AE]/30" />
                <p className="rw-label-mono text-xs uppercase text-[#6a6a6a]">In private beta</p>
              </div>
              <h2 className="text-4xl md:text-5xl font-medium text-[#2a2a2a] leading-tight">
                Know where you <span className="rw-display-serif text-[#97B3AE]">stand</span> on the block.
              </h2>
            </div>
          </div>
          <p className="text-[#6a6a6a] max-w-md leading-relaxed">
            Track the shop next door. Response rates, star trends, the words showing up in their reviews
            vs. yours. A one-page local market read, refreshed weekly.
          </p>
        </div>

        <div ref={rightRef} className={`rw-reveal from-right md:col-span-6 ${rightSeen ? 'in' : ''}`}>
          <div className="bg-white rounded-3xl p-6 border border-[#97B3AE]/15 shadow-lg relative overflow-hidden">
            <span className="absolute top-4 right-4 rw-label-mono text-[10px] uppercase text-[#F2C3B9] bg-[#F2C3B9]/15 px-2 py-1 rounded-full border border-[#F2C3B9]/40">
              preview
            </span>
            <p className="rw-label-mono text-[10px] uppercase text-[#6a6a6a] mb-4">
              Neighborhood scorecard · Mission District
            </p>
            <div className="space-y-3">
              {rows.map((r, i) => (
                <div
                  key={r.name}
                  className={`rw-comp-row flex items-center gap-3 p-3 rounded-2xl ${
                    r.highlighted ? 'bg-[#97B3AE]/10 border border-[#97B3AE]/30' : ''
                  }`}
                  style={{ ['--cr-d' as string]: `${120 + i * 140}ms` }}
                >
                  <span className={`rw-num-tag text-2xl w-8 ${r.highlighted ? 'text-[#2a2a2a]' : 'text-[#6a6a6a]'}`}>
                    {r.rank}
                  </span>
                  <div className="flex-1">
                    <p className={`text-sm ${r.highlighted ? 'font-medium text-[#2a2a2a]' : 'text-[#2a2a2a]'}`}>
                      {r.name}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-[#6a6a6a]">
                      <span>★ {r.stars}</span>
                      <span>·</span>
                      <span>{r.resp}</span>
                    </div>
                  </div>
                  {r.highlighted && (
                    <svg className="w-4 h-4 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}
