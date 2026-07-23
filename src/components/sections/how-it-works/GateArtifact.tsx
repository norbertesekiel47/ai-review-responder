'use client';

import { CopilotGateCard } from './CopilotGateCard';

function AutopilotGateCard() {
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" />
        <span>Autopilot · policy check + veto window</span>
        <span className="hiw-artifact-cap-tail">posting in 14:32</span>
      </div>
      <div className="hiw-draft">
        <div className="hiw-receipt">
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Policy</span>
            <span className="hiw-receipt-val">4–5★ · unflagged</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Daily cap</span>
            <span className="hiw-receipt-val">3 of 10 used</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Veto window</span>
            <span className="hiw-receipt-val">15 min</span>
          </div>
        </div>
        <div className="hiw-draft-out">
          <span className="hiw-draft-badge">Cleared to post · one tap stops it</span>
          <p>
            Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
            because we know your schedule doesn&apos;t wait for ours. See you again soon.
          </p>
        </div>
        <div className="hiw-email-actions">
          <button type="button" className="hiw-btn hiw-btn-ghost">Veto this reply</button>
        </div>
      </div>
    </div>
  );
}

export function GateArtifact() {
  return (
    <div className="hiw-gate-fork" style={{ display: 'grid', gap: 16 }}>
      <div>
        <p className="hiw-eyebrow" style={{ marginBottom: 8 }}>Copilot — you approve</p>
        <CopilotGateCard />
      </div>
      <div>
        <p className="hiw-eyebrow" style={{ marginBottom: 8 }}>Autopilot — your policy approves</p>
        <AutopilotGateCard />
      </div>
    </div>
  );
}
