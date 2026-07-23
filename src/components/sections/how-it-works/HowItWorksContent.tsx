'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { SiteShell } from '@/components/ui/SiteShell';
import { LeadIntakeForm } from '../lead-intake/LeadIntakeForm';
import { Reveal } from './Reveal';
import { WatchArtifact } from './WatchArtifact';
import { DraftArtifact } from './DraftArtifact';
import { CopilotGateCard } from './CopilotGateCard';
import { PostArtifact } from './PostArtifact';

interface HowItWorksContentProps {
  comingSoon?: boolean;
  selfServeEnabled?: boolean;
}

const SECTIONS = [
  { id: 'hiw-hero', label: 'Overview' },
  { id: 'hiw-steps', label: 'The four steps' },
  { id: 'hiw-hood', label: 'Under the hood' },
  { id: 'hiw-faq', label: 'FAQ' },
  { id: 'hiw-cta', label: 'Join waitlist' },
];

const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const STEPS = [
  {
    num: '01',
    color: '#D2E0D3',
    tick: 'T + 0:00',
    kicker: 'Monitor',
    title: "We watch your reviews so you don't have to.",
    sub: "We're notified the moment a new review is posted via a provider webhook, with a safety-net check every ~5 minutes as backup. New reviews are deduplicated against what we've seen and queued for drafting right away.",
    bullets: [
      'Reacts in near-real-time via webhook, with a ~5-minute safety-net poll',
      'Multi-location supported on Copilot and Autopilot',
      'Star rating, reviewer name, and full text captured',
    ],
    Artifact: WatchArtifact,
  },
  {
    num: '02',
    color: '#F0DDD6',
    tick: 'T + 0:12',
    kicker: 'Generate',
    title: 'AI drafts a reply — in your voice.',
    sub: 'RepWorth learns from the replies you approve and edit. The model picks up your phrasing, your rhythm, how you handle thanks and how you handle complaints. Each draft renders in seconds.',
    bullets: [
      'Learns from the replies you approve and edit',
      'Separate handling for 1–3★ vs 4–5★ reviews',
      'Regenerate button if the first pass misses',
    ],
    Artifact: DraftArtifact,
  },
  {
    num: '03',
    color: '#F2C3B9',
    tick: 'T + 0:20',
    kicker: 'Approve',
    title: 'You get an email. Thirty seconds, done.',
    sub: 'The draft arrives at your inbox with one-tap Approve, Edit, and Regenerate buttons. No login, no dashboard to check. Signed link, expires in 48 hours.',
    bullets: [
      'One-tap approve — no password, no app to open',
      'Edit inline if you want to tweak a word',
      "Regenerate if the tone doesn't feel right",
    ],
    Artifact: CopilotGateCard,
  },
  {
    num: '04',
    color: '#D6CBBF',
    tick: 'T + 1:04',
    kicker: 'Post',
    title: 'Posted to Google, on your behalf.',
    sub: 'Once you approve, we post the reply back to your Google listing. It shows up within seconds, attributed to the business owner, exactly as it would if you\'d typed it yourself.',
    bullets: [
      'Posts within seconds of approval',
      'Shows as "Response from the owner" on Google',
      'Receipt logged in your dashboard for audit',
    ],
    Artifact: PostArtifact,
  },
];

const HOOD = [
  { color: '#D2E0D3', title: 'Review ingest', sub: 'Reacts to a provider webhook in near-real-time; a safety-net poll runs every ~5 minutes.', tech: 'webhook · BullMQ', glyph: '⏱' },
  { color: '#F0DDD6', title: 'Voice model', sub: 'Drafts a reply in your voice, sourced from past replies.', tech: 'LLM · tuned', glyph: '✎' },
  { color: '#F2C3B9', title: 'Approval email', sub: 'One-tap signed link, no password needed.', tech: 'Resend · signed link', glyph: '✉' },
  { color: '#D6CBBF', title: 'Post back', sub: 'Submits the approved reply to Google on your behalf.', tech: 'Google', glyph: '↗' },
];

const GUARANTEES = [
  {
    title: 'Nothing posts without you',
    desc: 'Every reply waits for your approval by default. You can optionally turn on auto-approval (off by default), which only posts after passing automated safety checks.',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    title: 'Sounds like you wrote it',
    desc: 'RepWorth learns from your existing replies. Your tone, your phrasing, your voice.',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="m18.5 2.5 3 3L12 15l-4 1 1-4z" />
      </svg>
    ),
  },
  {
    title: 'Pause anytime',
    desc: 'Toggle off for a location in a single tap. Vacation, staff change, rebrand — we follow your lead.',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="6" y="4" width="4" height="16" />
        <rect x="14" y="4" width="4" height="16" />
      </svg>
    ),
  },
];

const FAQ_ITEMS = [
  { q: "What happens if I don't approve a draft?", a: 'Nothing. Drafts sit and wait, and we send you a reminder. If you never approve, we never post — the review simply stays unanswered on your end.' },
  { q: 'Can RepWorth post without asking me?', a: 'By default, no — every reply waits for your one-tap confirmation from the email. If you want hands-off posting, you can optionally enable auto-approval (off by default), which only posts after passing automated safety checks.' },
  { q: 'How does it learn my voice?', a: 'RepWorth learns your voice from the replies you approve and edit. As you tweak drafts it picks up your tone, length, and phrasing — the more you use it, the more it sounds like you.' },
  { q: 'What about negative reviews?', a: "Drafts for 1–3★ reviews get extra care: we'll never auto-suggest a defensive or dismissive reply — the tone defaults to acknowledging the issue and offering a path forward, and high-risk drafts are held for your review." },
  { q: 'Which review platforms do you support?', a: "Today, Google only — that's where most of the volume sits. Yelp, Tripadvisor and Facebook are on the roadmap." },
];

const OVERVIEW = [
  {
    n: '01', title: 'Monitor', time: 'near real-time', color: '#D2E0D3',
    glyph: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15 14" />
      </svg>
    ),
  },
  {
    n: '02', title: 'Generate', time: '~4 sec', color: '#F0DDD6',
    glyph: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    n: '03', title: 'Approve', time: '30 sec of you', color: '#F2C3B9',
    glyph: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
        <polyline points="2 8 12 14 22 8" />
      </svg>
    ),
  },
  {
    n: '04', title: 'Post', time: 'instant', color: '#D6CBBF',
    glyph: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12h14" />
        <polyline points="13 6 19 12 13 18" />
      </svg>
    ),
  },
];

const jumpTo = (id: string) => {
  const el = document.getElementById(id);
  if (el) {
    window.scrollTo({
      top: el.getBoundingClientRect().top + window.scrollY - 80,
      behavior: 'smooth',
    });
  }
};

export function HowItWorksContent({
  comingSoon = false,
  selfServeEnabled = false,
}: HowItWorksContentProps) {
  const [active, setActive] = useState('hiw-hero');
  const [openFaq, setOpenFaq] = useState(0);
  const faqBaseId = useId();

  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => Boolean(el)
    );
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-30% 0px -50% 0px', threshold: [0, 0.25, 0.5, 0.75] }
    );
    els.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  return (
    <SiteShell
      scope="hiw-page"
      comingSoon={comingSoon}
      selfServeEnabled={selfServeEnabled}
      overlay={
        <nav className="hiw-dotnav" aria-label="Section navigation">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jumpTo(s.id)}
              aria-label={s.label}
              title={s.label}
              className={`hiw-dotnav-btn ${active === s.id ? 'is-active' : ''}`}
            />
          ))}
        </nav>
      }
    >

          {/* Hero */}
          <section id="hiw-hero" className="hiw-hero">
            <p className="hiw-eyebrow">How it works</p>
            <h1 className="hiw-h1">Four steps from new review to posted reply.</h1>
            <p className="hiw-lead">
              RepWorth watches for new Google reviews, drafts a response in your voice, emails it
              to you for approval, then posts it back to Google. The whole loop takes under a
              minute of your time.
            </p>
            <div className="hiw-hero-meta">
              <div className="hiw-hero-meta-item">
                <span className="hiw-hero-meta-val">~5 min</span>
                <span className="hiw-hero-meta-lbl">safety-net poll</span>
              </div>
              <div className="hiw-hero-meta-item">
                <span className="hiw-hero-meta-val">30 sec</span>
                <span className="hiw-hero-meta-lbl">your time per reply</span>
              </div>
              <div className="hiw-hero-meta-item">
                <span className="hiw-hero-meta-val">96%</span>
                <span className="hiw-hero-meta-lbl">response rate</span>
              </div>
              <div className="hiw-hero-meta-item">
                <span className="hiw-hero-meta-val">15 hrs</span>
                <span className="hiw-hero-meta-lbl">saved weekly</span>
              </div>
            </div>
            <p className="hiw-hero-meta-note" style={{ marginTop: 12, fontSize: 12, fontStyle: 'italic', color: '#6a6a6a' }}>
              Typical figures shown for illustration, not live performance data.
            </p>
          </section>

          {/* Overview strip */}
          <div className="hiw-overview" id="hiw-overview">
            {OVERVIEW.map((it) => (
              <div key={it.n} className="hiw-overview-cell">
                <div className="hiw-overview-top">
                  <span className="hiw-overview-num">
                    <span className="hiw-overview-dot" />
                    Step {it.n}
                  </span>
                  <span
                    className="hiw-overview-glyph"
                    style={{ background: `linear-gradient(135deg, ${it.color}, ${it.color}cc)` }}
                  >
                    {it.glyph}
                  </span>
                </div>
                <span className="hiw-overview-title">{it.title}</span>
                <span className="hiw-overview-time">{it.time}</span>
              </div>
            ))}
          </div>

          {/* Steps */}
          <section id="hiw-steps" className="hiw-steps">
            <div className="hiw-section-head">
              <p className="hiw-eyebrow">The four steps</p>
              <h2 className="hiw-h2">From new review to posted reply.</h2>
              <p style={{ marginTop: 8, fontSize: 14, fontStyle: 'italic', color: '#6a6a6a' }}>
                Sample walkthrough — illustrative reviews and business, not real customers.
              </p>
            </div>
            {STEPS.map((s) => (
              <Reveal key={s.num}>
                <div className="hiw-step">
                  <div className="hiw-step-rail">
                    <div
                      className="hiw-step-badge"
                      style={{ background: `linear-gradient(135deg, ${s.color}, ${s.color}cc)` }}
                    >
                      {s.num}
                    </div>
                    <div className="hiw-step-rail-tick">{s.tick}</div>
                  </div>
                  <div className="hiw-step-body">
                    <div className="hiw-step-head">
                      <span className="hiw-step-kicker">{s.kicker}</span>
                      <h3 className="hiw-step-title">{s.title}</h3>
                      <p className="hiw-step-sub">{s.sub}</p>
                    </div>
                    <ul className="hiw-step-bullets">
                      {s.bullets.map((b) => (
                        <li key={b}>
                          <IconCheck />
                          {b}
                        </li>
                      ))}
                    </ul>
                    <s.Artifact />
                  </div>
                </div>
              </Reveal>
            ))}
          </section>

          {/* Under the hood */}
          <section id="hiw-hood" className="hiw-section hiw-section-wash">
            <div className="hiw-section-head">
              <p className="hiw-eyebrow">Under the hood</p>
              <h2 className="hiw-h2">The pipeline, end to end.</h2>
              <p className="hiw-lead">
                A poll worker, a voice model, a signed approval email, and a posting API. Nothing
                magical, just four well-behaved services.
              </p>
            </div>
            <Reveal>
              <div className="hiw-hood">
                {HOOD.map((n) => (
                  <div key={n.title} className="hiw-hood-node">
                    <div
                      className="hiw-hood-glyph"
                      style={{
                        background: `linear-gradient(135deg, ${n.color}, ${n.color}dd)`,
                      }}
                    >
                      {n.glyph}
                    </div>
                    <span className="hiw-hood-title">{n.title}</span>
                    <span className="hiw-hood-sub">{n.sub}</span>
                    <span className="hiw-hood-tech">{n.tech}</span>
                  </div>
                ))}
              </div>
            </Reveal>
            <Reveal delay={120}>
              <div className="hiw-guarantees">
                {GUARANTEES.map((g) => (
                  <div key={g.title} className="hiw-guarantee">
                    <div className="hiw-guarantee-icon">{g.icon}</div>
                    <span className="hiw-guarantee-title">{g.title}</span>
                    <span className="hiw-guarantee-desc">{g.desc}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </section>

          {/* FAQ */}
          <section id="hiw-faq" className="hiw-section">
            <div className="hiw-section-head">
              <p className="hiw-eyebrow">FAQ</p>
              <h2 className="hiw-h2">What owners ask first.</h2>
            </div>
            <div className="hiw-faq">
              {FAQ_ITEMS.map((it, i) => {
                const isOpen = openFaq === i;
                const panelId = `${faqBaseId}-faq-panel-${i}`;
                const buttonId = `${faqBaseId}-faq-button-${i}`;
                return (
                  <div key={it.q} className={`hiw-faq-item ${isOpen ? 'is-open' : ''}`}>
                    <button
                      type="button"
                      id={buttonId}
                      className="hiw-faq-q"
                      onClick={() => setOpenFaq(isOpen ? -1 : i)}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                    >
                      <span>{it.q}</span>
                      <span className="hiw-faq-toggle" aria-hidden>+</span>
                    </button>
                    <section
                      className="hiw-faq-a"
                      id={panelId}
                      aria-labelledby={buttonId}
                    >
                      <div className="hiw-faq-a-inner">{it.a}</div>
                    </section>
                  </div>
                );
              })}
            </div>
          </section>

          {/* CTA */}
          <section id="hiw-cta" className="hiw-cta">
            <h2>Join the early access waitlist.</h2>
            <p>
              Tell us about your business and we&apos;ll reach out when early access opens for
              your area.
            </p>
            {comingSoon ? (
              <span className="hiw-cta-btn is-disabled">Coming soon</span>
            ) : (
              <div className="w-full max-w-md">
                <LeadIntakeForm intent="waitlist" source="how-it-works" tone="onTeal" />
              </div>
            )}
            <div className="hiw-cta-row">
              <Link href="/pricing" className="hiw-cta-btn is-ghost">
                See pricing
              </Link>
            </div>
          </section>
    </SiteShell>
  );
}
