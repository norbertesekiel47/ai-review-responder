import { TiltCard } from 'repworth';

// The tilt and the glare are hover-only, and disabled outright for reduced
// motion or a coarse pointer — so the still card IS the render most visitors
// get. These previews show the two shapes it is used for.
export const StatCard = () => (
  <div style={{ maxWidth: 280 }}>
    <TiltCard className="bg-white shadow-xl border border-rw-teal/15 p-6">
      <p style={{ margin: 0, fontFamily: 'var(--rw-font-body)', fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--rw-ink-soft, #5b6360)' }}>
        Replies this week
      </p>
      <p style={{ margin: '0.5rem 0 0', fontFamily: 'var(--rw-font-display)', fontSize: '2.5rem', lineHeight: 1, color: 'var(--rw-ink, #15191a)' }}>
        42
      </p>
      <p style={{ margin: '0.5rem 0 0', fontFamily: 'var(--rw-font-body)', fontSize: '0.8125rem', color: 'var(--rw-ink-soft, #5b6360)' }}>
        Up from 31 the week before.
      </p>
    </TiltCard>
  </div>
);

export const ReviewCard = () => (
  <div style={{ maxWidth: 340 }}>
    <TiltCard max={18} className="bg-rw-cream shadow-lg border border-rw-ink/10 p-6">
      <p style={{ margin: 0, fontFamily: 'var(--rw-font-body)', fontSize: '0.875rem', color: 'var(--rw-ink, #15191a)' }}>
        ★★★★★
      </p>
      <p style={{ margin: '0.5rem 0 0', fontFamily: 'var(--rw-font-serif)', fontSize: '1.0625rem', lineHeight: 1.5, color: 'var(--rw-ink, #15191a)' }}>
        “Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.”
      </p>
      <p style={{ margin: '0.75rem 0 0', fontFamily: 'var(--rw-font-body)', fontSize: '0.8125rem', color: 'var(--rw-ink-soft, #5b6360)' }}>
        Sarah L. · Bright Linen Dry Cleaning
      </p>
    </TiltCard>
  </div>
);
