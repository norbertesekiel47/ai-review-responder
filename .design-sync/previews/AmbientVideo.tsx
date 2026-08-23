import { AmbientMotionProvider, AmbientVideo } from 'repworth';
import { INLINED_ASSETS } from '../.cache/assets';

// A decorative, looping, muted clip. autoPlay/loop/muted/playsInline are baked
// in, so the only props worth showing are the source, the poster and layout.
// The .mp4 clips are too large to inline; the poster is what paints, which is
// also true in production until the clip has buffered.
const poster = (id: string) => INLINED_ASSETS[`/agents/${id}.jpg`] ?? '';

export const AgentAvatar = () => (
  <AmbientMotionProvider>
    <AmbientVideo
      poster={poster('reply')}
      style={{ width: 220, height: 220, objectFit: 'cover', borderRadius: '1rem', display: 'block', background: 'var(--rw-ink, #15191a)' }}
    />
  </AmbientMotionProvider>
);

export const FullBleedBackdrop = () => (
  <AmbientMotionProvider>
    <div style={{ position: 'relative', width: '100%', height: 220, overflow: 'hidden', borderRadius: '1rem', background: 'var(--rw-ink, #15191a)' }}>
      <AmbientVideo
        poster={poster('governor')}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <p
        style={{
          position: 'absolute',
          left: '1.5rem',
          bottom: '1.25rem',
          margin: 0,
          fontFamily: 'var(--rw-font-display)',
          fontSize: '1.25rem',
          color: 'var(--rw-cream, #f7f3ec)',
        }}
      >
        Governor
      </p>
    </div>
  </AmbientMotionProvider>
);
