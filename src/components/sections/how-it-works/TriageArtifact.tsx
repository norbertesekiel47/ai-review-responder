'use client';

export function TriageArtifact() {
  return (
    <div className="rw-dl-card">
      <div className="rw-dl-cap">
        <span className="rw-dl-cap-dot is-bar" style={{ ['--bar' as string]: 'var(--rw-blush-bar)' }} />
        <span>Guardian triage · reviews of 3★ or less</span>
      </div>
      <div className="rw-dl-quote">
        <div className="rw-dl-quote-meta">
          Input · 2★ review ·{' '}
          <span className="rw-dl-stars" aria-label="2 out of 5 stars">
            <span aria-hidden="true">★★</span>
            <span aria-hidden="true" className="off">★★★</span>
          </span>
        </div>
        Waited forty minutes for a pickup that was promised in ten. Nobody at the counter could
        tell me where my order was.
      </div>
      <div className="rw-dl-rec">
        <div>
          <div className="rw-dl-rec-k">Severity</div>
          <div className="rw-dl-rec-v"><i className="rw-dl-rec-dot is-mid" />Medium</div>
        </div>
        <div>
          <div className="rw-dl-rec-k">Route</div>
          <div className="rw-dl-rec-v">Draft with care</div>
        </div>
        <div>
          <div className="rw-dl-rec-k">If serious</div>
          <div className="rw-dl-rec-v">Escalate to owner</div>
        </div>
      </div>
    </div>
  );
}
