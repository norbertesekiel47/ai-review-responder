'use client';

import { CANNOT_DO_YET } from './wording';
import './operator.css';

export interface RequestedCapabilityCardProps {
  request: string;
}

/**
 * A **Requested capability** (spec §3.3). A SEPARATE KIND, not a Proposal with
 * no button: the two travel under separate response keys (`proposals`,
 * `unsupported`) so a renderer can never grow an Apply affordance onto one.
 * There is no interactive element in this component at all, which is what the
 * test asserts.
 *
 * The card is the server's NORMALIZED request text plus the fixed refusal
 * sentence, and nothing else — naming what the owner asked for without saying
 * it cannot be done reads as a pending action.
 */
export function RequestedCapabilityCard({ request }: RequestedCapabilityCardProps) {
  return (
    <section className="card op-card">
      <h2 className="card-h2">{request}</h2>
      <p className="op-state-line">{CANNOT_DO_YET}</p>
    </section>
  );
}
