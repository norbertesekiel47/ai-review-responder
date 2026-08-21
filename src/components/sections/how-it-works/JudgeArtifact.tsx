'use client';

import { Reveal } from './Reveal';

export function JudgeArtifact() {
  return (
    <div className="rw-dl-card">
      <div className="rw-dl-cap">
        <span className="rw-dl-cap-dot" />
        <span>Judge review · after auto-post</span>
        <span className="rw-dl-cap-tail">within a minute of posting</span>
      </div>
      <div className="rw-dl-reply">
        <div className="rw-dl-reply-lbl">Auto-posted reply · under review</div>
        <p>
          Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
          because we know your schedule doesn&apos;t wait for ours. See you again soon.
        </p>
      </div>
      <Reveal>
        <div className="rw-dl-rec hiw-verdict">
          <div>
            <div className="rw-dl-rec-k">Verdict</div>
            <div className="rw-dl-rec-v"><i className="rw-dl-rec-dot" />Pass</div>
          </div>
          <div>
            <div className="rw-dl-rec-k">Coverage</div>
            <div className="rw-dl-rec-v">100% of auto-posts</div>
          </div>
          <div>
            <div className="rw-dl-rec-k">Governor</div>
            <div className="rw-dl-rec-v">Autopilot active</div>
          </div>
        </div>
      </Reveal>
    </div>
  );
}
