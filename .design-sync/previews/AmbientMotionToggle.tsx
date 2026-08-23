import { AmbientMotionProvider, AmbientMotionToggle } from 'repworth';

// The toggle throws outside AmbientMotionProvider by design, so the provider is
// part of every preview. It lives in the landing footer's bottom bar, which is
// where the dark ground below comes from.
const Bar = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '1rem 1.25rem',
      borderRadius: '999px',
      background: 'var(--rw-ink, #15191a)',
      color: 'var(--rw-cream, #f7f3ec)',
      fontFamily: 'var(--rw-font-body)',
      fontSize: '0.8125rem',
    }}
  >
    {children}
  </div>
);

export const InTheFooterBar = () => (
  <AmbientMotionProvider>
    <Bar>
      <AmbientMotionToggle />
      <span>Pause background motion</span>
    </Bar>
  </AmbientMotionProvider>
);
