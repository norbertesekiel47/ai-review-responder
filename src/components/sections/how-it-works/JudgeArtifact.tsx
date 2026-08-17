'use client';

export function JudgeArtifact() {
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" />
        <span>Judge review · after auto-post</span>
        <span className="hiw-artifact-cap-tail">within a minute of posting</span>
      </div>
      <div className="hiw-draft">
        <div className="hiw-draft-out">
          <span className="hiw-draft-badge">Auto-posted reply · under review</span>
          <p>
            Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
            because we know your schedule doesn&apos;t wait for ours. See you again soon.
          </p>
        </div>
        <div className="hiw-receipt">
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Verdict</span>
            <span className="hiw-receipt-val">
              <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#97B3AE', display: 'inline-block' }} />
              Pass
            </span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Coverage</span>
            <span className="hiw-receipt-val">100% of auto-posts</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Governor</span>
            <span className="hiw-receipt-val">Autopilot active</span>
          </div>
        </div>
      </div>
    </div>
  );
}
