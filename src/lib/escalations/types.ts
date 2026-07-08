// src/lib/escalations/types.ts
//
// Single owner of the review_escalations status vocabulary (WS3 spec §2.3).
// Forward-only: escalated → acknowledged → resolved; direct escalated →
// resolved is legal and stamps both timestamps (resolve implies acknowledge).

export const ESCALATION_STATUS = {
  ESCALATED: 'escalated',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
} as const;

export type EscalationStatus = (typeof ESCALATION_STATUS)[keyof typeof ESCALATION_STATUS];

/** The statuses that surface to the owner UI — resolved escalations never leave the server. */
export type OpenEscalationStatus = Exclude<EscalationStatus, 'resolved'>;
