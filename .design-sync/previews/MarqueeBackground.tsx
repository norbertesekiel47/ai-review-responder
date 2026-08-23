import { MarqueeBackground } from 'repworth';

// The drifting-reviews field is absolutely positioned and decorative: it fills
// whatever it is placed behind. SiteShell gives it the page; a card has to give
// it a box. Speed variants are motion-only, so one still is the honest story.
export const BehindTheIsland = () => (
  <div style={{ position: 'relative', width: '100%', height: 420, overflow: 'hidden', background: 'var(--rw-sage, #d2e0d3)' }}>
    <MarqueeBackground />
    <div
      style={{
        position: 'absolute',
        inset: '3rem 2rem',
        borderRadius: '2rem',
        background: '#fff',
        boxShadow: '0 24px 60px rgba(0,0,0,0.12)',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--rw-font-display)',
        fontSize: '1.25rem',
        color: 'var(--rw-ink, #15191a)',
      }}
    >
      The island sits on top
    </div>
  </div>
);
