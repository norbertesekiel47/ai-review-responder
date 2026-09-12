'use client';

import { CANNOT_DO_YET } from './wording';
import './operator.css';

export interface RequestedCapabilityCardProps {
  request: string;
}

/**
 * T4 owns the body. No button, ever — a **Requested capability** is not a Proposal.
 *
 * The refusal sentence ships with the placeholder rather than waiting for T4:
 * T3's own R7 case asserts it, because a card that names what the owner asked
 * for without saying it cannot be done reads as a pending action.
 */
export function RequestedCapabilityCard({ request }: RequestedCapabilityCardProps) {
  return (
    <section className="card op-card">
      <h2 className="card-h2">{request}</h2>
      <p className="op-body">{CANNOT_DO_YET}</p>
    </section>
  );
}
