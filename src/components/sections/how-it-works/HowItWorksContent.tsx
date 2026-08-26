'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { SiteShell } from '@/components/ui/SiteShell';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { LeadIntakeForm } from '../lead-intake/LeadIntakeForm';
import { Reveal } from '@/components/ui/Reveal';
import { HeroWash } from '@/components/ui/HeroWash';
import { HeroFlowArtifact } from './HeroFlowArtifact';
import { StatCards } from './StatCards';
import { WatchArtifact } from './WatchArtifact';
import { TriageArtifact } from './TriageArtifact';
import { DraftArtifact } from './DraftArtifact';
import { GateArtifact } from './GateArtifact';
import { PostArtifact } from './PostArtifact';
import { JudgeArtifact } from './JudgeArtifact';

interface HowItWorksContentProps {
  comingSoon?: boolean;
  selfServeEnabled?: boolean;
  /** Drives the nav CTA label ("Start free trial" vs "Create account"). */
  trialEnabled?: boolean;
  /** Label for the /signup CTA when self-serve is on; null keeps the waitlist form. */
  signupCtaLabel?: string | null;
}

// The six dossier steps (Daylight Gallery II sticky stack). `bar` is the
// step's colour bar token — bar-only accents, never text (the Judge bar is
// deliberately ink, docs/design/daylight-ii/system-amendments.md).
const STEPS = [
  {
    num: '01',
    bar: 'var(--rw-sage-bar)',
    tick: 'T + 0:00',
    kicker: 'Watch',
    title: "We watch your reviews so you don't have to.",
    sub: 'Through our review partner, Google tells us within seconds when a new review lands. We also double-check every 5 minutes as a backup. We never draft the same review twice, and new reviews go straight to drafting.',
    bullets: [
      'Hears about new reviews within seconds, with a backup check every 5 minutes',
      'Multi-location supported on Copilot and Autopilot (extra locations billed per location)',
      'Star rating, reviewer name, and full text captured',
    ],
    Artifact: WatchArtifact,
  },
  {
    num: '02',
    bar: 'var(--rw-blush-bar)',
    tick: 'T + 0:01',
    kicker: 'Triage',
    title: 'Guardian reads it before anyone answers.',
    sub: 'Reviews of 3★ or less, or with no rating, get a quick AI read of how serious they are: low, medium, or high. The ones that need a human escalate straight to you with the context attached; positive reviews flow on to drafting.',
    bullets: [
      'Reviews of 3★ or less get a quick AI read of how serious they are',
      'Escalations reach you by email; you mark them acknowledged or resolved from your dashboard',
      'Guardian never posts anything, anywhere',
    ],
    Artifact: TriageArtifact,
  },
  {
    num: '03',
    bar: 'var(--rw-mist-bar)',
    tick: 'T + 0:12',
    kicker: 'Draft',
    title: 'AI drafts a reply, in your voice.',
    sub: 'From day one, drafts follow your Brand Voice settings: tone, staff names, products, facts to mention or avoid. Once you have edited and posted five replies, RepWorth starts matching your own phrasing and rhythm too. Each draft renders in seconds.',
    bullets: [
      'Learns from the replies you edit and post',
      'Every draft passes a safety check before the gate',
      'Regenerate if the first pass misses, up to 3 times a day per review',
    ],
    Artifact: DraftArtifact,
  },
  {
    num: '04',
    bar: 'var(--rw-gold-bar)',
    tick: 'T + 0:20',
    kicker: 'The Gate',
    title: 'Copilot asks you. Autopilot asks your policy.',
    sub: 'On Copilot, every draft comes to you by email with one tap to approve, edit, or regenerate. On Autopilot, 4–5★ replies that pass the safety checks and fit your settings post after a 15- or 30-minute veto window, and one tap stops them. Negative reviews are never auto-posted.',
    bullets: [
      'One-tap approve, straight from your inbox',
      'Autopilot posts only for the star ratings you allow (5★ only, or 4–5★) and up to your daily limit',
      'The veto window is your one-tap stop before anything goes live',
    ],
    Artifact: GateArtifact,
  },
  {
    num: '05',
    bar: 'var(--rw-teal-bar)',
    tick: 'T + 1:04',
    kicker: 'Post',
    title: 'Posted to Google, on your behalf.',
    sub: "Once a reply clears the gate, we post it to your Google listing. It usually shows up within seconds, attributed to the business owner. Replies that posted on Autopilot send you an FYI the moment they're live.",
    bullets: [
      'Shows as "Response from the owner" on Google',
      'Auto-posts send an FYI with a link to the live reply',
      'Receipt logged in your dashboard for audit',
    ],
    Artifact: PostArtifact,
  },
  {
    num: '06',
    bar: 'var(--rw-ink2)',
    tick: 'T + 1:47',
    kicker: 'Judge',
    title: 'Every auto-post gets a second opinion.',
    sub: 'After any reply posts without your tap, the Judge grades it. The Judge is a separate AI check with its own rulebook, and it applies a fixed safety rubric: no unauthorized promises, no personal details, no made-up facts about your business, no hostile tone. The Governor watches those results. If trust slips it pauses Autopilot for your whole account and emails you, and support switches it back on after a review.',
    bullets: [
      '100% of auto-posted replies are reviewed',
      'The Governor can pause Autopilot for your whole account',
      'Judge unavailable → auto-posting halts',
    ],
    Artifact: JudgeArtifact,
  },
];

const OVERVIEW = [
  { n: '01', title: 'Watch', time: 'near real-time', bar: 'var(--rw-sage-bar)' },
  { n: '02', title: 'Triage', time: 'seconds', bar: 'var(--rw-blush-bar)' },
  { n: '03', title: 'Draft', time: 'seconds', bar: 'var(--rw-mist-bar)' },
  { n: '04', title: 'The Gate', time: 'you, or your policy', bar: 'var(--rw-gold-bar)' },
  { n: '05', title: 'Post', time: 'seconds', bar: 'var(--rw-teal-bar)' },
  { n: '06', title: 'Judge', time: 'automatic', bar: 'var(--rw-ink2)' },
];

const HOOD = [
  { bar: 'var(--rw-sage-bar)', n: '01', title: 'Review ingest', sub: 'Hears about new reviews within seconds; a backup check runs every 5 minutes.' },
  { bar: 'var(--rw-blush-bar)', n: '02', title: 'Guardian triage', sub: 'Quick read of how serious a 3★-or-less review is; serious reviews escalate to the owner.' },
  { bar: 'var(--rw-mist-bar)', n: '03', title: 'AI writer', sub: 'Drafts a reply in your voice, then runs it through a safety check.' },
  { bar: 'var(--rw-gold-bar)', n: '04', title: 'The gate', sub: 'Owner approval on Copilot; policy + veto window on Autopilot.' },
  { bar: 'var(--rw-teal-bar)', n: '05', title: 'Post back', sub: 'Submits the approved reply to Google on your behalf.' },
  { bar: 'var(--rw-ink2)', n: '06', title: 'Judge', sub: 'Reviews every auto-post; the Governor pauses Autopilot if trust slips.' },
];

const GUARANTEES = [
  {
    title: 'Nothing posts without passing the gate',
    desc: "On Copilot that gate is you. On Autopilot it's your settings, a veto window, a safety check, and the Judge on duty, which then reviews every auto-post. Negative reviews are never auto-posted.",
  },
  {
    title: 'Sounds like you wrote it',
    desc: 'RepWorth learns from the replies you edit and post. Your tone, your phrasing, your voice.',
  },
  {
    title: 'Pause anytime',
    desc: 'Toggle a location off in one tap, and if trust ever slips, the Governor pauses autonomy for you.',
  },
];

const FAQ_ITEMS = [
  { q: 'What can Autopilot post without asking me?', a: 'Only replies to 4–5★ reviews that pass our safety checks and fit your Autopilot settings, and only after the veto window passes, the Judge is on duty, and your account isn’t paused. The Judge then reviews every one of them after it posts. Negative reviews are never auto-posted.' },
  { q: "What happens if I don't approve a draft?", a: 'Nothing. Drafts wait in your dashboard. Email links expire after 48 hours, and if you go quiet for about three days with drafts waiting we send a reminder with a fresh link. If you never approve, we never post.' },
  { q: 'What about negative reviews?', a: 'Guardian reads them first and grades how serious they are; the ones it decides need a human go straight to you. Drafts for 1–3★ reviews always wait for your approval. When Guardian rates an issue medium or high, the draft opens with an apology, avoids admitting fault, and invites the customer to continue offline.' },
  { q: 'How does it learn my voice?', a: 'From day one, drafts follow your Brand Voice settings: tone, staff names, products, facts to mention or avoid. Once you have edited and posted five replies, RepWorth starts matching your most recent edits too: your tone, length, and phrasing.' },
  { q: 'What if the AI safety checks go down?', a: "Auto-posting stops. The Judge must be on duty for anything to post without your tap. If it can't review, pending auto-approved replies fall back to your normal approval queue." },
  { q: 'Which review platforms do you support?', a: "Today, Google only. That's where most of the volume sits. Other review platforms are on the roadmap." },
  { q: 'How do I connect my Google reviews?', a: 'You connect your Google Business Profile with your Google login through our review partner. RepWorth never sees your Google password. Replies post as “Response from the owner”. One location is one Google Business Profile listing.' },
  { q: 'What about my existing reviews?', a: 'When you connect, we offer to import your 100 most recent reviews from the past 12 months. You have 7 days to say yes. Imported reviews get no drafts unless you ask, and they are never auto-posted.' },
  { q: 'Where do approvals arrive?', a: 'By email today. The link works for 48 hours, and your dashboard always works. Approve, edit, or regenerate (up to 3 times a day per review), with no login and no app. Reviews with a star rating but no text still get a reply.' },
  { q: 'Can I turn Autopilot off?', a: 'Yes, any time in Settings, for your account or per location. If the Governor pauses it, you get an email and RepWorth support switches it back on after a review.' },
];

const HERO_LINES = [
  'One pipeline from',
  'new review to',
  'public reply, with a',
  'gate in the middle.',
];

const STICKY_TOP = 116;

export function HowItWorksContent({
  comingSoon = false,
  selfServeEnabled = false,
  trialEnabled = false,
  signupCtaLabel = null,
}: HowItWorksContentProps) {
  const showSignupCta = selfServeEnabled && signupCtaLabel !== null;
  const prefersReducedMotion = usePrefersReducedMotion();
  const [openFaq, setOpenFaq] = useState(0);
  const faqBaseId = useId();

  // Hero entrance: one class flip staged by CSS transition delays.
  const [heroIn, setHeroIn] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setHeroIn(true), prefersReducedMotion ? 0 : 80);
    return () => window.clearTimeout(id);
  }, [prefersReducedMotion]);

  return (
    <SiteShell scope="hiw-page" comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} trialEnabled={trialEnabled}>
      {/* Hero — blurred wash fading to bone before the hero ends */}
      <section className={`hiw-hero rw-dl-wash-host ${heroIn ? "is-in" : ""}`} aria-labelledby="hiw-h1">
        <HeroWash />
        <div className="rw-dl-col hiw-hero-col">
          <div>
            <h1 className="hiw-h1" id="hiw-h1">
              {HERO_LINES.map((line) => (
                <span key={line} className="ln">
                  <span>{line}</span>
                </span>
              ))}
            </h1>
            <p className="hiw-lede hiw-fade d1">
              RepWorth watches your Google reviews, drafts each reply in your voice, and brings it
              to a gate you control: your tap on Copilot, your policy on Autopilot.
            </p>
            <div className="hiw-ctas hiw-fade d2">
              {comingSoon ? null : showSignupCta ? (
                <Link href="/signup" className="rw-pill rw-pill-forest">
                  {signupCtaLabel}
                </Link>
              ) : (
                <a href="#hiw-cta" className="rw-pill rw-pill-forest">
                  Join the waitlist
                </a>
              )}
              <Link href="/pricing" className="rw-dl-txtlink">
                See pricing <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
          <div className="hiw-fade d3">
            <HeroFlowArtifact />
          </div>
        </div>
      </section>

      {/* Stat cards */}
      <section aria-label="Typical figures" className="hiw-stats-band">
        <div className="rw-dl-col">
          <StatCards />
          <p className="rw-dl-fine">
            Typical figures shown for illustration, not live performance data.
          </p>
        </div>
      </section>

      {/* Overview */}
      <section className="rw-dl-band hiw-overview-band" aria-labelledby="hiw-ov-h">
        <div className="rw-dl-col">
          <Reveal>
            <div className="rw-dl-intro">
              <h2 className="rw-dl-h2" id="hiw-ov-h">Six steps from new review to public reply.</h2>
              <p>
                An instant alert, a quick read, an AI writer, a gate, a post, and a check. Two of
                the six exist only to say no.
              </p>
            </div>
          </Reveal>
          <Reveal>
            <div className="hiw-ov">
              {OVERVIEW.map((cell) => (
                <div key={cell.n} style={{ ['--bar' as string]: cell.bar }}>
                  <div className="hiw-ov-k">
                    <span className="hiw-ov-tick" />
                    Step {cell.n}
                  </div>
                  <div className="hiw-ov-t">{cell.title}</div>
                  <div className="hiw-ov-m">{cell.time}</div>
                </div>
              ))}
            </div>
          </Reveal>
          <p className="rw-dl-fine hiw-fine-center">
            Sample walkthrough below: illustrative reviews and business, not real customers.
            Scroll: each step stacks on the last.
          </p>
        </div>
      </section>

      {/* Six steps — sticky dossier stack */}
      <section aria-labelledby="hiw-steps-h" className="hiw-steps-band">
        <div className="rw-dl-col">
          <h2 className="sr-only" id="hiw-steps-h">The pipeline</h2>
          <div className="hiw-stack">
            {STEPS.map((step, i) => (
              <article
                key={step.num}
                className="hiw-step"
                style={{
                  ['--bar' as string]: step.bar,
                  ['--top' as string]: `${STICKY_TOP + i * 8}px`,
                  zIndex: i + 1,
                }}
              >
                <div className="hiw-step-hd">
                  <b>{step.num}</b>
                  <span>{step.kicker}</span>
                  <span className="hiw-step-t">{step.tick}</span>
                </div>
                <div className="hiw-step-bd">
                  <div className="hiw-step-tx">
                    <h3>{step.title}</h3>
                    <p className="hiw-step-s">{step.sub}</p>
                    <ul className="rw-dl-bul">
                      {step.bullets.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="hiw-step-ar">
                    <step.Artifact />
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Pipeline panel */}
      <section className="rw-dl-band" aria-labelledby="hiw-hood-h">
        <div className="rw-dl-col">
          <Reveal>
            <div className="rw-dl-intro">
              <h2 className="rw-dl-h2" id="hiw-hood-h">The pipeline, end to end.</h2>
              <p>Six parts, each with one job. Guardian and the Judge never post anything themselves.</p>
            </div>
          </Reveal>
          <Reveal scrub>
            <div className="hiw-hood">
              {HOOD.map((node) => (
                <div key={node.title} style={{ ['--bar' as string]: node.bar }}>
                  <div className="hiw-hood-n">{node.n}</div>
                  <div className="hiw-hood-t">{node.title}</div>
                  <div className="hiw-hood-s">{node.sub}</div>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal delay={120} scrub>
            <div className="hiw-guarantees">
              {GUARANTEES.map((g) => (
                <div key={g.title} className="hiw-guarantee">
                  <div className="hiw-guar-t">{g.title}</div>
                  <div className="hiw-guar-d">{g.desc}</div>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* FAQ */}
      <section className="rw-dl-band hiw-faq-band" aria-labelledby="hiw-faq-h">
        <div className="rw-dl-col">
          <Reveal>
            <div className="rw-dl-intro is-tight">
              <h2 className="rw-dl-h2" id="hiw-faq-h">What owners ask first.</h2>
            </div>
          </Reveal>
          <Reveal>
            <div className="rw-dl-faq">
              {FAQ_ITEMS.map((item, i) => {
                const isOpen = openFaq === i;
                const panelId = `${faqBaseId}-faq-panel-${i}`;
                const buttonId = `${faqBaseId}-faq-button-${i}`;
                return (
                  <div key={item.q} className={`rw-dl-faq-item ${isOpen ? 'is-open' : ''}`}>
                    <button
                      type="button"
                      id={buttonId}
                      className="rw-dl-faq-q"
                      onClick={() => setOpenFaq(isOpen ? -1 : i)}
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

      {/* CTA — dark ink band */}
      <section id="hiw-cta" className="rw-dl-cta" aria-labelledby="hiw-cta-h">
        <div className="rw-dl-col">
          <div>
            <h2 id="hiw-cta-h">
              {showSignupCta ? 'Start with Copilot today.' : 'Join the early access waitlist.'}
            </h2>
            <p className="rw-dl-cta-sub">
              {showSignupCta
                ? 'Connect your Google Business Profile and get your first drafts in minutes. Every reply waits for your tap until you say otherwise.'
                : "Tell us about your business and we'll reach out when early access opens for your area."}
            </p>
            <div className="rw-dl-cta-more">
              <Link href="/pricing">See pricing <span aria-hidden="true">→</span></Link>
              <Link href="/features">All features <span aria-hidden="true">→</span></Link>
            </div>
          </div>
          <div>
            {comingSoon ? (
              <div className="rw-dl-cta-panel">
                <span className="rw-pill rw-pill-paper is-disabled">Coming soon</span>
              </div>
            ) : showSignupCta ? (
              <div className="rw-dl-cta-panel">
                <Link href="/signup" className="rw-pill rw-pill-paper hiw-cta-pill">
                  {signupCtaLabel}
                </Link>
                <p className="rw-dl-fine">
                  Card required up front. Explicit plan selection. Cancel anytime.
                </p>
              </div>
            ) : (
              <div className="rw-dl-cta-panel">
                <LeadIntakeForm intent="waitlist" source="how-it-works" tone="onTeal" />
              </div>
            )}
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
