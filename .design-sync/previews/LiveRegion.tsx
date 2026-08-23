import { LiveRegion } from 'repworth';

// LiveRegion is `sr-only` by construction — it has no visible render, and any
// preview that showed one would be a lie. What a card can honestly show is the
// pairing: the visible control that changes, and the region that announces it.
const Frame = ({ note, children }: { note: string; children: React.ReactNode }) => (
  <div
    style={{
      display: 'grid',
      gap: '0.5rem',
      padding: '1rem 1.25rem',
      border: '1px dashed var(--rw-teal, #2f6f6b)',
      borderRadius: '0.75rem',
      fontFamily: 'var(--rw-font-body)',
      fontSize: '0.875rem',
      color: 'var(--rw-ink, #15191a)',
      background: 'var(--rw-cream, #f7f3ec)',
    }}
  >
    {children}
    <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.7 }}>{note}</p>
  </div>
);

export const Polite = () => (
  <Frame note="Announced politely. Nothing is drawn — the region is visually hidden.">
    <strong>Reply saved</strong>
    <LiveRegion message="Reply saved" />
  </Frame>
);

export const Assertive = () => (
  <Frame note="level=&quot;assertive&quot; renders role=alert, for errors that interrupt.">
    <strong style={{ color: 'var(--rw-error, #b3261e)' }}>Could not post the reply</strong>
    <LiveRegion message="Could not post the reply" level="assertive" />
  </Frame>
);
