import { AmbientMotionProvider, AmbientMotionToggle, AmbientVideo } from 'repworth';
import { INLINED_ASSETS } from '../.cache/assets';

// The provider renders no markup of its own — it supplies the paused state that
// AmbientVideo obeys and AmbientMotionToggle drives. The honest preview is the
// three of them composed, which is exactly how LandingExperience uses it.
export const GovernsItsChildren = () => (
  <AmbientMotionProvider>
    <div
      style={{
        display: 'grid',
        gap: '1rem',
        justifyItems: 'center',
        padding: '1.5rem',
        borderRadius: '1.25rem',
        maxWidth: 280,
        background: 'var(--rw-ink, #15191a)',
        color: 'var(--rw-cream, #f7f3ec)',
        fontFamily: 'var(--rw-font-body)',
      }}
    >
      <AmbientVideo
        poster={INLINED_ASSETS['/agents/guardian.jpg'] ?? ''}
        style={{ width: 160, height: 160, objectFit: 'cover', borderRadius: '0.75rem', display: 'block' }}
      />
      <AmbientMotionToggle />
      <p style={{ margin: 0, fontSize: '0.8125rem', opacity: 0.75, textAlign: 'center' }}>
        One control pauses every ambient clip on the page — WCAG 2.2.2.
      </p>
    </div>
  </AmbientMotionProvider>
);
