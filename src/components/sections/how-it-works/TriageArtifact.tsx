'use client';

export function TriageArtifact() {
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" style={{ background: '#F2C3B9', boxShadow: '0 0 0 4px rgba(242,195,185,0.2)' }} />
        <span>Guardian triage · negative lane</span>
        <span className="hiw-artifact-cap-tail">~1 sec</span>
      </div>
      <div className="hiw-draft">
        <div className="hiw-draft-src">
          <div className="hiw-draft-src-meta">
            Input · negative lane ·{' '}
            <span aria-label="2 out of 5 stars">
              <span aria-hidden="true" style={{ color: '#97B3AE' }}>★★</span>
              <span aria-hidden="true" style={{ color: '#e5e5e5' }}>★★★</span>
            </span>
          </div>
          Waited forty minutes for a pickup that was promised in ten. Nobody at the counter could
          tell me where my order was.
        </div>
        <div className="hiw-receipt">
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Severity</span>
            <span className="hiw-receipt-val">
              <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#F2C3B9', display: 'inline-block' }} />
              Medium
            </span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Route</span>
            <span className="hiw-receipt-val">Draft with care</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">If serious</span>
            <span className="hiw-receipt-val">Escalate to owner</span>
          </div>
        </div>
      </div>
    </div>
  );
}
