'use client';

// ═══════════════════════════════════════════════════════════════════════════
// PROTOTYPE — THROWAWAY. DO NOT SHIP. DO NOT IMPORT FROM PRODUCTION CODE.
//
// Ticket #536 (wayfinder map #528): Voice Report Card — which register traits
// from the voice-learning corpus (src/lib/responses/voice-learning.ts) do we
// show, what does the sub-5-example activation state look like, and where
// does the screen live (settings vs dashboard)?
//
// Three variants on the existing /settings/voice route, switchable via
// ?variant=A|B|C, with a second toggle ?state=learned|empty for the
// pre-activation state (fewer than 5 owner-edited posted replies).
//
//   A — Trait report card: named register traits, each backed by one
//       before→after evidence snippet. Settings placement.
//   B — Evidence ledger: the owner's actual edits lead; traits are margin
//       annotations on the diffs. Settings placement.
//   C — Dashboard digest: compact glance-style card as it would sit on
//       /dashboard, prose summary + doorway. Placement mock.
//
// All data below is HARDCODED MOCK DATA. No fetching, no mutations.
// The production build is its own ticket; this file never graduates.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Icon } from '@/components/dashboard/shell/Icon';

// ── Mock corpus: owner-edited pairs, shaped like VoiceExample ──────────────

interface MockPair {
  reviewStarRating: number;
  reviewerFirstName: string;
  originalDraft: string;
  editedVersion: string;
}

const MOCK_PAIRS: MockPair[] = [
  {
    reviewStarRating: 5,
    reviewerFirstName: 'Amanda',
    originalDraft:
      'Dear Amanda, thank you so much for taking the time to share your wonderful feedback. We are thrilled to hear that you enjoyed your visit and we look forward to welcoming you back soon. — The Copper Kettle Team',
    editedVersion:
      'Hi Amanda — thanks so much! The oat-milk cortado is my favorite too. See you next week. — Maria',
  },
  {
    reviewStarRating: 2,
    reviewerFirstName: 'Derek',
    originalDraft:
      'Dear Derek, we sincerely apologize for any inconvenience you may have experienced. Customer satisfaction is our highest priority and we would love the opportunity to make this right. Please reach out to us at your earliest convenience.',
    editedVersion:
      "Derek, I'm sorry — a 20-minute wait for a drip coffee isn't okay. We were down a barista that morning, but that's on me to staff better. Next one's on the house. — Maria",
  },
  {
    reviewStarRating: 5,
    reviewerFirstName: 'Priya',
    originalDraft:
      'Dear Priya, thank you for your kind words about our pastries and atmosphere. We truly appreciate your support and hope to see you again very soon!',
    editedVersion:
      'Hi Priya — the cardamom buns sell out by 10am for a reason. Thanks for the kind words. — Maria',
  },
  {
    reviewStarRating: 4,
    reviewerFirstName: 'Tom',
    originalDraft:
      'Dear Tom, thank you for your feedback. We are glad you enjoyed your experience overall and we appreciate your suggestion regarding additional seating. We are always looking for ways to improve.',
    editedVersion:
      "Hi Tom — glad the flat white landed. You're right about seating on Saturdays; we're adding two more tables this month. — Maria",
  },
  {
    reviewStarRating: 5,
    reviewerFirstName: 'Rosa',
    originalDraft:
      'Dear Rosa, we are so happy to hear that our team made your morning special. Thank you for choosing us and for sharing your experience with others!',
    editedVersion:
      'Hi Rosa — I read your review to the morning crew and it made their day. Thank you. — Maria',
  },
];

// ── Mock derived traits: the candidate register traits under evaluation ────

interface MockTrait {
  key: string;
  name: string;
  claim: string;
  before: string;
  after: string;
  pairIndex: number;
}

const MOCK_TRAITS: MockTrait[] = [
  {
    key: 'greeting',
    name: 'Greeting',
    claim: 'You open with a casual “Hi” and the customer’s first name — never “Dear.”',
    before: 'Dear Amanda, thank you so much for taking the time…',
    after: 'Hi Amanda — thanks so much!',
    pairIndex: 0,
  },
  {
    key: 'length',
    name: 'Length',
    claim: 'You cut drafts roughly in half. Your replies average 28 words; drafts average 52.',
    before: '“…we truly appreciate your support and hope to see you again very soon!” (41 words)',
    after: '“…the cardamom buns sell out by 10am for a reason. Thanks.” (19 words)',
    pairIndex: 2,
  },
  {
    key: 'signoff',
    name: 'Sign-off',
    claim: 'You sign personally as “— Maria,” not as “The Copper Kettle Team.”',
    before: '— The Copper Kettle Team',
    after: '— Maria',
    pairIndex: 0,
  },
  {
    key: 'voice',
    name: 'Point of view',
    claim: 'You write as “I,” not “we,” and add one specific detail the reviewer mentioned.',
    before: 'We are thrilled to hear that you enjoyed your visit…',
    after: 'The oat-milk cortado is my favorite too.',
    pairIndex: 0,
  },
  {
    key: 'critical',
    name: 'Critical reviews',
    claim: 'On low-star reviews you apologize once, plainly, name the cause, and offer a concrete fix — no hedging.',
    before: 'We sincerely apologize for any inconvenience you may have experienced…',
    after: 'I’m sorry — a 20-minute wait for a drip coffee isn’t okay. Next one’s on the house.',
    pairIndex: 1,
  },
];

const EMPTY_STATE_EDITED_COUNT = 2;
const ACTIVATION_THRESHOLD = 5;

// ── Shared bits ────────────────────────────────────────────────────────────

const mono: React.CSSProperties = { fontSize: 13, lineHeight: 1.55 };

function BeforeAfter({ before, after }: { before: string; after: string }) {
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
      <div
        style={{
          ...mono,
          color: 'var(--rw-app-text-muted, #6B5E50)',
          background: 'var(--rw-recess, #F7F3EC)',
          borderRadius: 10,
          padding: '8px 12px',
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: 2 }}>
          Our draft
        </span>
        {before}
      </div>
      <div
        style={{
          ...mono,
          color: 'var(--rw-app-text, #2A2118)',
          background: 'var(--rw-sage-soft, #EAF1EE)',
          borderRadius: 10,
          padding: '8px 12px',
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: 2, color: 'var(--rw-sage-deep, #5E7C76)' }}>
          Your edit
        </span>
        {after}
      </div>
    </div>
  );
}

function ActivationDots({ count }: { count: number }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} aria-label={`${count} of ${ACTIVATION_THRESHOLD} edited replies`}>
      {Array.from({ length: ACTIVATION_THRESHOLD }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: i < count ? 'var(--rw-sage-deep, #5E7C76)' : 'transparent',
            border: `2px solid ${i < count ? 'var(--rw-sage-deep, #5E7C76)' : 'var(--rw-hair-2, rgba(80,60,40,.14))'}`,
          }}
        />
      ))}
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--rw-app-text-2, #4A3F33)', marginLeft: 4 }}>
        {count} of {ACTIVATION_THRESHOLD}
      </span>
    </div>
  );
}

function EmptyExplainer() {
  return (
    <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--rw-app-text-muted, #6B5E50)', margin: '10px 0 0' }}>
      Every time you edit a draft before posting it, RepWorth studies the difference.
      After {ACTIVATION_THRESHOLD} edited replies it has enough to describe how you write — no setup needed,
      it activates on its own. Replies you post without edits don&apos;t count (they tell us nothing new).
    </p>
  );
}

// ── Variant A — Trait report card ──────────────────────────────────────────

function VariantA({ empty }: { empty: boolean }) {
  if (empty) {
    return (
      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon sage">
            <Icon name="sparkle" size={18} />
          </div>
          <div>
            <div className="set-section-title">Voice Report Card</div>
            <div className="set-section-sub">What RepWorth has learned about how you write.</div>
          </div>
        </div>
        <ActivationDots count={EMPTY_STATE_EDITED_COUNT} />
        <EmptyExplainer />
      </div>
    );
  }

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon sage">
          <Icon name="sparkle" size={18} />
        </div>
        <div>
          <div className="set-section-title">Voice Report Card</div>
          <div className="set-section-sub">
            Learned from your last {ACTIVATION_THRESHOLD} edited replies. Updates as you edit more.
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 20 }}>
        {MOCK_TRAITS.map((trait) => (
          <div key={trait.key}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--rw-sage-deep, #5E7C76)',
                }}
              >
                {trait.name}
              </span>
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--rw-app-text, #2A2118)', margin: '4px 0 0', fontWeight: 500 }}>
              {trait.claim}
            </p>
            <BeforeAfter before={trait.before} after={trait.after} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Variant B — Evidence ledger (diffs lead, traits annotate) ──────────────

function VariantB({ empty }: { empty: boolean }) {
  if (empty) {
    return (
      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon sage">
            <Icon name="edit" size={18} />
          </div>
          <div>
            <div className="set-section-title">Your edits, studied</div>
            <div className="set-section-sub">The replies you rewrote — and what each rewrite taught us.</div>
          </div>
        </div>
        <ActivationDots count={EMPTY_STATE_EDITED_COUNT} />
        <div style={{ display: 'grid', gap: 10, marginTop: 14 }} aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              style={{
                height: 52,
                borderRadius: 10,
                border: '1px dashed var(--rw-hair-2, rgba(80,60,40,.14))',
                background: i < EMPTY_STATE_EDITED_COUNT ? 'var(--rw-recess, #F7F3EC)' : 'transparent',
                opacity: 1 - i * 0.25,
              }}
            />
          ))}
        </div>
        <EmptyExplainer />
      </div>
    );
  }

  const traitByPair = new Map<number, MockTrait[]>();
  for (const trait of MOCK_TRAITS) {
    traitByPair.set(trait.pairIndex, [...(traitByPair.get(trait.pairIndex) ?? []), trait]);
  }

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon sage">
          <Icon name="edit" size={18} />
        </div>
        <div>
          <div className="set-section-title">Your edits, studied</div>
          <div className="set-section-sub">The replies you rewrote — and what each rewrite taught us.</div>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 24 }}>
        {MOCK_PAIRS.map((pair, i) => (
          <div key={i} style={{ borderTop: i > 0 ? '1px solid var(--rw-hair, rgba(80,60,40,.08))' : 'none', paddingTop: i > 0 ? 20 : 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--rw-app-text-2, #4A3F33)' }}>
                Reply to {pair.reviewerFirstName}
              </span>
              <span style={{ fontSize: 12, color: 'var(--rw-gold, #D4A24C)' }} aria-label={`${pair.reviewStarRating} star review`}>
                {'★'.repeat(pair.reviewStarRating)}
                <span style={{ color: 'var(--rw-hair-2, rgba(80,60,40,.14))' }}>{'★'.repeat(5 - pair.reviewStarRating)}</span>
              </span>
            </div>
            <BeforeAfter before={pair.originalDraft} after={pair.editedVersion} />
            {(traitByPair.get(i) ?? []).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {(traitByPair.get(i) ?? []).map((trait) => (
                  <span
                    key={trait.key}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '3px 10px',
                      borderRadius: 999,
                      background: 'var(--rw-sage-soft, #EAF1EE)',
                      color: 'var(--rw-sage-deep, #5E7C76)',
                    }}
                    title={trait.claim}
                  >
                    {trait.claim}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Variant C — Dashboard glance card (placement mock) ─────────────────────

function VariantC({ empty }: { empty: boolean }) {
  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--rw-app-text-faint, #9C8E7E)', margin: '0 0 10px' }}>
        Placement mock — this card would sit on the <strong>/dashboard</strong> glance,
        below the Intelligence Brief. Doorway opens the full report in Settings.
      </p>
      <div style={{ border: '2px dashed var(--rw-hair-2, rgba(80,60,40,.14))', borderRadius: 26, padding: 10 }}>
        {empty ? (
          <div className="card">
            <div className="brief-head">
              <div className="brief-head-icon">
                <Icon name="sparkle" size={18} />
              </div>
              <div style={{ flex: 1 }}>
                <h2 className="brief-h2">Your voice</h2>
                <div className="brief-period">
                  Learning how you write — <span className="brief-period-strong">{EMPTY_STATE_EDITED_COUNT} of {ACTIVATION_THRESHOLD}</span> edited replies so far.
                </div>
              </div>
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--rw-app-text-muted, #6B5E50)', margin: 0 }}>
              Edit {ACTIVATION_THRESHOLD - EMPTY_STATE_EDITED_COUNT} more drafts before posting and RepWorth will
              show you what it learned about how you write.
            </p>
          </div>
        ) : (
          <div className="card">
            <div className="brief-head">
              <div className="brief-head-icon">
                <Icon name="sparkle" size={18} />
              </div>
              <div style={{ flex: 1 }}>
                <h2 className="brief-h2">Your voice</h2>
                <div className="brief-period">
                  From your last <span className="brief-period-strong">{ACTIVATION_THRESHOLD} edited replies</span>
                </div>
              </div>
            </div>
            <ul className="brief-list">
              <li className="brief-li">
                <span className="brief-li-bullet">1</span>
                <span>Casual and personal: “Hi” + first name, signed “— Maria,” written as “I,” not “we.”</span>
              </li>
              <li className="brief-li">
                <span className="brief-li-bullet">2</span>
                <span>Short: you cut our drafts roughly in half and add one detail the reviewer mentioned.</span>
              </li>
              <li className="brief-li">
                <span className="brief-li-bullet">3</span>
                <span>On critical reviews: one plain apology, the real cause, and a concrete fix.</span>
              </li>
            </ul>
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              style={{ fontSize: 13, fontWeight: 600, color: 'var(--rw-sage-deep, #5E7C76)', display: 'inline-block', marginTop: 10 }}
            >
              See the full report card →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Switcher + shell ───────────────────────────────────────────────────────

const VARIANTS = [
  { key: 'A', name: 'Trait report card' },
  { key: 'B', name: 'Evidence ledger' },
  { key: 'C', name: 'Dashboard digest' },
] as const;

export function VoiceReportCardPrototype() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const variantKey = searchParams.get('variant')?.toUpperCase() ?? 'A';
  const state = searchParams.get('state') === 'empty' ? 'empty' : 'learned';
  const empty = state === 'empty';
  const index = Math.max(0, VARIANTS.findIndex((v) => v.key === variantKey));
  const current = VARIANTS[index] ?? VARIANTS[0];

  const go = useCallback(
    (nextIndex: number, nextState?: string) => {
      const wrapped = (nextIndex + VARIANTS.length) % VARIANTS.length;
      const params = new URLSearchParams(searchParams.toString());
      params.set('variant', (VARIANTS[wrapped] ?? VARIANTS[0]).key);
      params.set('state', nextState ?? state);
      router.replace(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams, state],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'ArrowLeft') go(index - 1);
      if (event.key === 'ArrowRight') go(index + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index]);

  if (process.env.NODE_ENV === 'production') return null;

  return (
    <div className="settings-content">
      {current.key === 'A' && <VariantA empty={empty} />}
      {current.key === 'B' && <VariantB empty={empty} />}
      {current.key === 'C' && <VariantC empty={empty} />}

      <div
        style={{
          position: 'fixed',
          bottom: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: '#1F2937',
          color: '#F9FAFB',
          borderRadius: 999,
          padding: '8px 14px',
          boxShadow: '0 8px 24px rgba(0,0,0,.35)',
          zIndex: 1000,
          fontSize: 13,
        }}
      >
        <button
          type="button"
          onClick={() => go(index - 1)}
          aria-label="Previous variant"
          style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}
        >
          ←
        </button>
        <span style={{ fontWeight: 600, minWidth: 170, textAlign: 'center' }}>
          {current.key} — {current.name}
        </span>
        <button
          type="button"
          onClick={() => go(index + 1)}
          aria-label="Next variant"
          style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}
        >
          →
        </button>
        <span style={{ opacity: 0.4 }}>|</span>
        <button
          type="button"
          onClick={() => go(index, empty ? 'learned' : 'empty')}
          style={{
            background: empty ? '#B45309' : '#374151',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            borderRadius: 999,
            padding: '3px 10px',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {empty ? `empty (${EMPTY_STATE_EDITED_COUNT}/${ACTIVATION_THRESHOLD})` : 'learned'}
        </button>
      </div>
    </div>
  );
}
