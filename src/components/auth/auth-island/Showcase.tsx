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
  const lead =
    mode === 'signup'
      ? 'Join the local businesses saving 15 hours every week with personalised, on-brand replies.'
      : '127 reviews answered while you slept. Three are waiting for your one-tap approval.';
  const eyebrow = mode === 'signup' ? 'Get started in 90 seconds' : 'Welcome home';

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

      <div className="rw-stats">
        <div className="rw-stat">
          <div className="rw-stat-val">15h</div>
          <div className="rw-stat-lbl">saved per week</div>
        </div>
        <div className="rw-stat">
          <div className="rw-stat-val">96%</div>
          <div className="rw-stat-lbl">response rate</div>
        </div>
        <div className="rw-stat">
          <div className="rw-stat-val">60s</div>
          <div className="rw-stat-lbl">poll cadence</div>
        </div>
      </div>

      <Robot />
    </div>
  );
}
