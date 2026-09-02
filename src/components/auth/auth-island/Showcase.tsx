import type { AuthMode } from '@/components/auth/shared/pathForMode';
import { Robot } from './Robot';

export interface ShowcaseProps {
  mode: AuthMode;
}

export function Showcase({ mode }: ShowcaseProps) {
  const heading =
    mode === 'signup' ? (
      <>
        Every review gets the <em>reply it deserves</em>.
      </>
    ) : (
      <>
        Welcome back. Your <em>inbox is quiet</em>.
      </>
    );
  // Static, truthful copy only — no invented counts or live-looking stats.
  // A logged-out visitor has no data behind "127 reviews answered" (A21).
  const lead =
    mode === 'signup'
      ? 'Personal, on-brand replies to every Google review — drafted for you, posted only when you say so.'
      : 'Sign in to review the replies waiting for you.';
  const eyebrow = mode === 'signup' ? 'Get started in a few minutes' : 'Welcome back';

  return (
    <div className="rw-showcase">
      <div className="rw-brand">
        {/* Wordmark only — keep markup self-contained; no asset dependency. */}
        <span className="rw-brand-word">RepWorth</span>
      </div>

      <div>
        <div className="rw-showcase-eyebrow">{eyebrow}</div>
        <h2 className="rw-showcase-h">{heading}</h2>
        <p className="rw-showcase-lead">{lead}</p>

        <div className="rw-preview">
          <div className="rw-review-card r1">
            <div className="rw-review-head">
              <div className="rw-avatar" />
              <div style={{ flex: 1 }}>
                <div className="rw-review-name">Marisol B.</div>
                <div className="rw-review-stars">★★★★★</div>
              </div>
            </div>
            <p className="rw-review-body">
              &ldquo;Best haircut I&apos;ve had in years. Sofia really listened.&rdquo;
            </p>
            <div className="rw-review-reply">
              <div className="badge">Drafted · 12s ago</div>
              Marisol, thank you so much! Sofia will be thrilled. We&apos;d love to see you again soon.
            </div>
          </div>
          <div className="rw-review-card r2">
            <div className="rw-review-head">
              <div className="rw-avatar t" />
              <div style={{ flex: 1 }}>
                <div className="rw-review-name">Daniel K.</div>
                <div className="rw-review-stars">★★★★☆</div>
              </div>
            </div>
            <p className="rw-review-body">
              &ldquo;Friendly staff, great vibe. Coffee a little slow today.&rdquo;
            </p>
          </div>
        </div>
      </div>

      {/* Three things RepWorth does — statements, not fabricated metrics. */}
      <div className="rw-stats">
        <div className="rw-stat">
          <div className="rw-stat-val">Every review</div>
          <div className="rw-stat-lbl">gets a drafted reply</div>
        </div>
        <div className="rw-stat">
          <div className="rw-stat-val">You approve</div>
          <div className="rw-stat-lbl">before anything posts</div>
        </div>
        <div className="rw-stat">
          <div className="rw-stat-val">Your voice</div>
          <div className="rw-stat-lbl">learned from your edits</div>
        </div>
      </div>

      <Robot />
    </div>
  );
}
