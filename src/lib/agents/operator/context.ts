// The **Context snapshot** type seam. T3 declares the types only; T5 adds
// `buildSnapshot` (the reads) to this same file. Splitting it this way is what
// lets the catalog/validator task run in parallel with the route task: both
// agree on the shape without either waiting on the other's queries.
//
// Nothing here touches the database — these are declarations.
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import type { AutoApprovalThreshold, VetoWindowMinutes } from '@/lib/auto-approval/types';
import type { ModelVisibleOperation } from './catalog';

export type StarBandKey = '1' | '2' | '3' | '4' | '5';

export interface StarBands {
  /** null on the account aggregate. */
  locationId: string | null;
  /** Includes rows with a NULL star_rating; those are in no band. */
  total: number;
  byStar: Record<StarBandKey, number>;
}

export interface SnapshotMetrics {
  pendingCount: number;
  draftsWaiting: number;
  posted7d: number;
  starBands: StarBands;
  accountStarBands: StarBands;
  reportingPeriodDays: number;
  asOf: string;
}

/**
 * One scope's **Operating rules**: effective, not stored — a location with no
 * override row still has them, inherited from the account default.
 */
export interface RuleSummary {
  /** `AutoApprovalThreshold | null` — null means no threshold is set. */
  threshold: AutoApprovalThreshold | null;
  vetoWindowMinutes: VetoWindowMinutes;
  /** The ENFORCED cap (`effectiveDailyCap`), never the nullable stored value. */
  dailyCap: number;
}

/** The voice facts the model may see. NO `sampleResponses` — that is response text. */
export interface SnapshotFacts {
  tone: string | null;
  productsServices: string | null;
  avoidFacts: string[];
  highlightFacts: string[];
}

/** One earlier turn, reduced to what the model may see. */
export interface SnapshotTurn {
  sequence: number;
  /**
   * Already scrubbed at write time; re-scrubbed here is a belt-and-braces
   * no-op. The **Pasted-review scrub** is a read-path transform — the stored
   * `owner_text` is never modified.
   */
  ownerText: string;
  replyText: string[];
  proposalSummaries: string[];
}

/** A pending **Proposal**, reduced to what the model may see. */
export interface SnapshotProposal {
  id: string;
  operation: string;
  labelKind: string;
  status: string;
  describe: string;
}

/**
 * Everything the model is allowed to see, and NOTHING ELSE.
 *
 * There is deliberately no field on this type that could hold review text,
 * response text or a reviewer name — that is the type-level form of the
 * invariant, and it is what the red-team fixture in T7 asserts against.
 */
export interface Snapshot {
  accountId: string;
  locationId: string;
  locationName: string;
  subscriptionTier: SubscriptionTierValue;
  turns: SnapshotTurn[];
  pendingProposals: SnapshotProposal[];
  operatingRules: { account: RuleSummary; location: RuleSummary; locationOverrideExists: boolean };
  /**
   * The four voice FACTS, and deliberately not `VoiceConfig`:
   * `sampleResponses` is stored RESPONSE TEXT, which the snapshot may never
   * carry (invariant 5). Spelling the projection as its own type is what makes
   * that a compile error rather than a review note.
   */
  facts: SnapshotFacts;
  allowedOperations: readonly ModelVisibleOperation[];
  locations: { id: string; name: string }[];
  metrics: SnapshotMetrics;
}
