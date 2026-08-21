'use client';

export function PostArtifact() {
  return (
    <div className="rw-dl-card">
      <div className="rw-dl-cap">
        <span className="rw-dl-cap-dot" />
        <span>Live on Google · posted by owner</span>
        <span className="rw-dl-cap-tail">12 sec ago</span>
      </div>
      <div className="hiw-gcard">
        <div className="hiw-gcard-hd">
          <div className="rw-dl-av">SL</div>
          <div>
            <div>
              Sarah L. ·{' '}
              <span className="rw-dl-stars" aria-label="5 out of 5 stars">
                <span aria-hidden="true">★★★★★</span>
              </span>
            </div>
            <div className="hiw-gcard-wh">Bright Linen Dry Cleaning · 1 hour ago</div>
          </div>
        </div>
        <p className="hiw-gcard-rt">
          Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.
          I&apos;ll be back!
        </p>
        <div className="hiw-owner">
          <div className="hiw-owner-hd">
            <span>Response from the owner</span>
            <span className="hiw-owner-ok" aria-hidden="true">✓</span>
            <span>· just now</span>
          </div>
          <p>
            Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality
            seriously because we know your schedule doesn&apos;t wait for ours. See you again soon.
          </p>
        </div>
      </div>
      <div className="rw-dl-rec">
        <div>
          <div className="rw-dl-rec-k">Status</div>
          <div className="rw-dl-rec-v"><i className="rw-dl-rec-dot" />Posted</div>
        </div>
        <div>
          <div className="rw-dl-rec-k">Posted at</div>
          <div className="rw-dl-rec-v">10:43 AM</div>
        </div>
        <div>
          <div className="rw-dl-rec-k">Total time</div>
          <div className="rw-dl-rec-v">1m 04s</div>
        </div>
      </div>
    </div>
  );
}
