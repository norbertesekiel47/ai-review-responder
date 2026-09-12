'use client';

import type { ProposalView } from '@/lib/agents/operator/proposals';
import './operator.css';

export interface ProposalCardProps {
  proposal: ProposalView;
  /** The turn's STORED location — the card's target, never the selector (§3.3). */
  turnLocationId: string;
  /** How to name a location on screen. Supplied by the client, which owns the roster. */
  locationLabel: (locationId: string) => string;
  /** True when the browser's current scope is not the turn's location (D4). */
  scopeMoved: boolean;
  onApply: (proposal: ProposalView) => void;
  onDecline: (proposal: ProposalView) => void;
  onRefreshPlan: (proposal: ProposalView) => void;
  busy: boolean;
  error: string | null;
}

/** T4 owns the body. This placeholder renders the card's identity only. */
export function ProposalCard({ proposal }: ProposalCardProps) {
  return (
    <section className="card op-card">
      <h2 className="card-h2">{proposal.describe}</h2>
    </section>
  );
}
