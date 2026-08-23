import { useRef } from 'react';
import { PageShell } from 'repworth';

// The Tailwind/parallax island: a drifting card backdrop with a white island
// floating over it. Distinct from SiteShell, which owns the marketing chrome.
//
// Capture note: the island arrives on a 0.8s opacity/scale transition, and the
// screenshot harness fires at `networkidle` — which can beat the first
// animation frame. The card itself is correct in the product; see
// .design-sync/NOTES.md, "PageShell capture race", for the reproduction.
export const WithContent = () => {
  const intro = useRef<HTMLDivElement>(null);
  const terms = useRef<HTMLDivElement>(null);

  return (
    <PageShell sections={[{ ref: intro, label: 'What we collect' }, { ref: terms, label: 'What we never do' }]}>
      <div style={{ padding: '3rem 2.5rem', fontFamily: 'var(--rw-font-body)', color: 'var(--rw-ink, #15191a)' }}>
        <p style={{ margin: 0, fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--rw-ink-soft, #5b6360)' }}>
          Privacy
        </p>
        <div ref={intro}>
          <h1 style={{ margin: '0.5rem 0 1rem', fontFamily: 'var(--rw-font-display)', fontSize: '2rem', lineHeight: 1.15 }}>
            What we collect, and why
          </h1>
          <p style={{ margin: '0 0 1rem', fontSize: '0.9375rem', lineHeight: 1.6 }}>
            RepWorth reads the reviews your Google Business Profile already
            publishes, drafts a reply to each one, and posts only what you
            approve. We store the review, the draft, and the decision you made
            about it.
          </p>
        </div>
        <div ref={terms}>
          <p style={{ margin: 0, fontSize: '0.9375rem', lineHeight: 1.6 }}>
            We never sell your data, and we never post anything on your behalf
            that you did not approve or explicitly delegate.
          </p>
        </div>
      </div>
    </PageShell>
  );
};

export const NarrowIsland = () => (
  <PageShell sections={[]} maxWidthClassName="max-w-2xl">
    <div style={{ padding: '2.5rem 2rem', fontFamily: 'var(--rw-font-body)', color: 'var(--rw-ink, #15191a)' }}>
      <h1 style={{ margin: '0 0 0.75rem', fontFamily: 'var(--rw-font-display)', fontSize: '1.5rem' }}>
        A narrower island
      </h1>
      <p style={{ margin: 0, fontSize: '0.9375rem', lineHeight: 1.6 }}>
        <code>maxWidthClassName</code> defaults to <code>max-w-5xl</code>.
        Long-form legal pages keep the default; short confirmation surfaces
        narrow it. An empty <code>sections</code> array drops the dot nav.
      </p>
    </div>
  </PageShell>
);
