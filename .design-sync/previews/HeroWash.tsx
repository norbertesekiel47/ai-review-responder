import { HeroWash } from 'repworth';

// The how-it-works hero backdrop: a blurred still that the loop fades in over.
// It is absolutely positioned and decorative, so a card must give it a box.
// The still lives in public/ and loads from the production origin here.
export const BehindTheHeading = () => (
  <div style={{ position: 'relative', width: '100%', height: 320, overflow: 'hidden', borderRadius: '1rem', background: 'var(--rw-beige, #efe6d9)' }}>
    <HeroWash />
    <div
      style={{
        position: 'relative',
        zIndex: 1,
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        padding: '2rem',
        textAlign: 'center',
        fontFamily: 'var(--rw-font-display)',
        fontSize: '1.75rem',
        lineHeight: 1.2,
        color: 'var(--rw-ink, #15191a)',
      }}
    >
      One pipeline from new review to public reply
    </div>
  </div>
);
