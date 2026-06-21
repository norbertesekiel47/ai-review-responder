'use client';

import Link from 'next/link';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { SiteShell } from '@/components/ui/SiteShell';
import { LeadIntakeForm } from '../lead-intake/LeadIntakeForm';

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

function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      const id = window.setTimeout(() => setSeen(true), delay);
      return () => window.clearTimeout(id);
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          window.setTimeout(() => setSeen(true), delay);
          io.disconnect();
        }
      },
      { threshold: 0.05, rootMargin: '0px 0px -50px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delay, seen]);
  return (
    <div ref={ref} className={`hiw-reveal ${seen ? 'is-in' : ''}`}>
      {children}
    </div>
  );
}

/* ───── Step artifacts ───── */

const STEP1_ROWS = [
  { name: 'Sarah L.', initials: 'SL', stars: 5, excerpt: 'Best dry cleaners in town. Picked up my suits on time and they...', time: 'Just now', isNew: true },
  { name: 'Marcus T.', initials: 'MT', stars: 4, excerpt: 'Quick service, friendly staff. Will return for my shirts next week.', time: '12 min ago' },
  { name: 'Priya R.', initials: 'PR', stars: 5, excerpt: 'Saved my wedding dress. Honestly, nothing short of magic.', time: '48 min ago' },
  { name: 'David C.', initials: 'DC', stars: 3, excerpt: 'Decent service but the pickup hours could be better on weekends.', time: '2 hrs ago' },
];
const STEP1_COLORS = ['#F2C3B9', '#D6CBBF', '#D2E0D3', '#F0DDD6'];

function Step1Artifact() {
  const reducedMotion = usePrefersReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const i = setInterval(() => setTick((t) => t + 1), 4200);
    return () => clearInterval(i);
  }, [reducedMotion]);
  const rows = STEP1_ROWS;
  const colors = STEP1_COLORS;
  const mins = String(59 - (tick % 60)).padStart(2, '0');
  const secs = String(59 - ((tick * 3) % 60)).padStart(2, '0');
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" />
        <span>Google Business Profile: Bright Linen Dry Cleaning</span>
        <span className="hiw-artifact-cap-tail">polling · next in {mins}:{secs}</span>
      </div>
      <div className="hiw-feed">
        {rows.map((r, i) => (
          <div key={r.name} className={`hiw-feed-row ${r.isNew ? 'is-new' : ''}`}>
            <div className="hiw-avatar" style={{ background: colors[i % colors.length] }}>{r.initials}</div>
            <div>
              <div className="hiw-feed-line1">
                <span className="hiw-feed-name">{r.name}</span>
                <span className="hiw-feed-stars" aria-label={`${r.stars} out of 5 stars`}>
                  <span aria-hidden="true">{'★'.repeat(r.stars)}</span>
                  <span aria-hidden="true" style={{ color: '#e5e5e5' }}>{'★'.repeat(5 - r.stars)}</span>
                </span>
              </div>
              <div className="hiw-feed-excerpt">{r.excerpt}</div>
            </div>
            <div className="hiw-feed-time">
              {r.isNew && <span className="hiw-pulse-dot" />}
              {r.time}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Step2Artifact() {
  const full =
    "Sarah, thank you — that's genuinely wonderful to hear. We take punctuality seriously because we know your schedule doesn't wait for ours. See you again soon.";
  const reducedMotion = usePrefersReducedMotion();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    // Reduced motion: skip the looping typewriter. The completed draft is
    // rendered statically at render time (`displayedDraft`), so no in-effect
    // setState is needed here.
    if (reducedMotion) return;
    // Single timer drives lead-in → type → hold → loop, so the effect has one
    // state setter (avoids a chain of setState calls across nested timers).
    let i = 0;
    let lead = 0;
    let hold = 0;
    const iv = setInterval(() => {
      if (lead < 400) {
        lead += 22;
        return;
      }
      if (i <= full.length) {
        setTyped(full.slice(0, i));
        i += 2;
      } else if (hold < 2400) {
        hold += 22;
      } else {
        i = 0;
        hold = 0;
      }
    }, 22);
    return () => clearInterval(iv);
  }, [full, reducedMotion]);
  const displayedDraft = reducedMotion ? full : typed;
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span
          className="hiw-artifact-cap-dot"
          style={{ background: '#F2C3B9', boxShadow: '0 0 0 4px rgba(242,195,185,0.2)' }}
        />
        <span>Draft generation · voice model</span>
        <span className="hiw-artifact-cap-tail">~4 sec</span>
      </div>
      <div className="hiw-draft">
        <div className="hiw-draft-src">
          <div className="hiw-draft-src-meta">Input · Review from Sarah L.</div>
          Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.
          I&apos;ll be back!
        </div>
        <div className="hiw-draft-arrow">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
        </div>
        <div className="hiw-draft-out">
          <span className="hiw-draft-badge">Draft · in your voice</span>
          <p>
            {displayedDraft}
            <span className="hiw-draft-typing" />
          </p>
        </div>
        <div className="hiw-draft-voice">
          <div className="hiw-voice-chip">
            <span className="hiw-voice-chip-lbl">Tone</span>
            <span className="hiw-voice-chip-val">Warm · direct</span>
          </div>
          <div className="hiw-voice-chip">
            <span className="hiw-voice-chip-lbl">Length</span>
            <span className="hiw-voice-chip-val">28 words</span>
          </div>

        </div>
      </div>
    </div>
  );
}

function Step3Artifact() {
  const reducedMotion = usePrefersReducedMotion();
  const [state, setState] = useState<'pending' | 'approving' | 'approved' | 'regenerating'>('pending');
  const onApprove = () => {
    if (reducedMotion) {
      setState('approved');
      return;
    }
    setState('approving');
    setTimeout(() => setState('approved'), 700);
  };
  const onRegen = () => {
    if (reducedMotion) {
      setState('pending');
      return;
    }
    setState('regenerating');
    setTimeout(() => setState('pending'), 1100);
  };
  const statusMessage =
    state === 'approving'
      ? 'Approving the reply.'
      : state === 'approved'
        ? 'Approved. Posting the reply to Google.'
        : state === 'regenerating'
          ? 'Regenerating the draft reply.'
          : '';
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#97B3AE' }} aria-hidden>
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
        <span>owner@brightlinen.com · Inbox</span>
        <span className="hiw-artifact-cap-tail">10:42 AM</span>
      </div>
      <div className="hiw-email">
        <div className="hiw-email-head">
          <div className="hiw-email-head-l">
            <span className="hiw-brand-mini" aria-hidden />
            <strong style={{ color: 'var(--rw-ink)' }}>RepWorth</strong>
            <span>&lt;drafts@repworth.net&gt;</span>
          </div>
          <div>to you</div>
        </div>
        <h4 className="hiw-email-subj">New 5★ review from Sarah L., ready to approve</h4>
        <p className="hiw-email-meta">
          We drafted a reply in your voice. Tap to approve, edit, or regenerate.
        </p>

        <div className="hiw-email-quote">
          <div className="hiw-email-quote-meta">
            SARAH L. ·{' '}
            <span aria-label="5 out of 5 stars">
              <span aria-hidden="true">★★★★★</span>
            </span>
          </div>
          Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.
          I&apos;ll be back!
        </div>
        <div className="hiw-email-reply">
          <div className="hiw-email-reply-meta">Suggested reply</div>
          Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
          because we know your schedule doesn&apos;t wait for ours. See you again soon.
        </div>

        <div className="hiw-email-actions">
          {state === 'approved' ? (
            <button
              type="button"
              className="hiw-btn hiw-btn-approve"
              disabled
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Approved, posting to Google
            </button>
          ) : (
            <>
              <button
                type="button"
                className="hiw-btn hiw-btn-approve"
                onClick={onApprove}
                disabled={state === 'approving'}
              >
                {state === 'approving' ? 'Sending…' : 'Approve & post'}
              </button>
              <button type="button" className="hiw-btn hiw-btn-ghost" disabled={state === 'regenerating'}>
                Edit first
              </button>
              <button
                type="button"
                className="hiw-btn hiw-btn-ghost"
                onClick={onRegen}
                disabled={state === 'regenerating'}
              >
                {state === 'regenerating' ? 'Regenerating…' : 'Regenerate'}
              </button>
            </>
          )}
        </div>
        <div
          aria-live="polite"
          className="sr-only"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0, 0, 0, 0)',
            whiteSpace: 'nowrap',
            border: 0,
          }}
        >
          {statusMessage}
        </div>
        <div className="hiw-email-foot">
          <span>Responds from owner@brightlinen.com</span>
          <span>One-tap · no login</span>
        </div>
      </div>
    </div>
  );
}

function Step4Artifact() {
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" />
        <span>Live on Google · posted by owner</span>
        <span className="hiw-artifact-cap-tail">12 sec ago</span>
      </div>
      <div className="hiw-posted">
        <div className="hiw-posted-card">
          <div className="hiw-posted-head">
            <div className="hiw-avatar">SL</div>
            <div>
              <span className="hiw-posted-name">
                Sarah L. ·{' '}
                <span aria-label="5 out of 5 stars">
                  <span aria-hidden="true" style={{ color: '#97B3AE' }}>★★★★★</span>
                </span>
              </span>
              <span className="hiw-posted-when">Bright Linen Dry Cleaning · 1 hour ago</span>
            </div>
          </div>
          <p className="hiw-posted-review">
            Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.
            I&apos;ll be back!
          </p>
          <div className="hiw-posted-reply">
            <div className="hiw-posted-reply-head">
              <strong>Response from the owner</strong>
              <span className="hiw-verified">✓</span>
              <span>· just now</span>
            </div>
            <div className="hiw-posted-reply-body">
              Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality
              seriously because we know your schedule doesn&apos;t wait for ours. See you again soon.
            </div>
          </div>
        </div>
        <div className="hiw-receipt">
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Status</span>
            <span className="hiw-receipt-val">
              <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#97B3AE', display: 'inline-block' }} />
              Posted
            </span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Posted at</span>
            <span className="hiw-receipt-val">10:43 AM</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Total time</span>
            <span className="hiw-receipt-val">1m 04s</span>
          </div>
        </div>
      </div>
    </div>
  );
}

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
      'Multi-location supported on Premium',
      'Star rating, reviewer name, and full text captured',
    ],
    Artifact: Step1Artifact,
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
    Artifact: Step2Artifact,
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
    Artifact: Step3Artifact,
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
    Artifact: Step4Artifact,
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
                    <div
                      className="hiw-faq-a"
                      id={panelId}
                      role="region"
                      aria-labelledby={buttonId}
                    >
                      <div className="hiw-faq-a-inner">{it.a}</div>
                    </div>
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
