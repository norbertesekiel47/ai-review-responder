'use client';

export function PostArtifact() {
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" />
        <span>Live on Google · posted by owner</span>
        <span className="hiw-artifact-cap-tail">12 sec ago</span>
      </div>
      <div className="hiw-posted">
        <div className="hiw-posted-card">
          <div className="hiw-posted-head">
            <div className="hiw-avatar">SL</div>
            <div>
              <span className="hiw-posted-name">
                Sarah L. ·{' '}
                <span aria-label="5 out of 5 stars">
                  <span aria-hidden="true" style={{ color: '#97B3AE' }}>★★★★★</span>
                </span>
              </span>
              <span className="hiw-posted-when">Bright Linen Dry Cleaning · 1 hour ago</span>
            </div>
          </div>
          <p className="hiw-posted-review">
            Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.
            I&apos;ll be back!
          </p>
          <div className="hiw-posted-reply">
            <div className="hiw-posted-reply-head">
              <strong>Response from the owner</strong>
              <span className="hiw-verified">✓</span>
              <span>· just now</span>
            </div>
            <div className="hiw-posted-reply-body">
              Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality
              seriously because we know your schedule doesn&apos;t wait for ours. See you again soon.
            </div>
          </div>
        </div>
        <div className="hiw-receipt">
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Status</span>
            <span className="hiw-receipt-val">
              <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#97B3AE', display: 'inline-block' }} />
              Posted
            </span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Posted at</span>
            <span className="hiw-receipt-val">10:43 AM</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Total time</span>
            <span className="hiw-receipt-val">1m 04s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
