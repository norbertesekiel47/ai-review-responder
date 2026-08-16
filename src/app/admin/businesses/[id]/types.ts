import type {
  AccountAuditLogEntry,
  AccountContext,
  ApprovalAuditLogEntry,
  AutoApprovalDiagnostics,
  BusinessDetailResponse,
  ZernioPanelData,
} from '@/lib/admin/business-detail-types';
import type { ChurnScore } from '@/lib/shared/churn-score';

/**
 * The page-level shape of the business object.
 *
 * DERIVED from the API contract, never re-declared: every field but
 * `churnScore` is exactly `BusinessDetailResponse['business']`'s, so a change
 * on the server side is a compile error here rather than a silent divergence.
 * `churnScore` is WIDENED to optional — the client guards on it and react-query
 * may hold a payload from an older render — which is a safe direction: the
 * server's non-optional value is assignable to it, so
 * `BusinessDetailResponse` flows into `DetailData` with NO cast at the server
 * page seam.
 *
 * It previously also NARROWED `tone`/`ownerName`/`ownerEmail` from
 * `string | null` to `string`. Those columns are genuinely nullable, so that
 * was a lie, and the `as unknown as DetailData` cast in page.tsx existed to
 * hide it. That cast was the only seam where a drift in the server's DTO —
 * `churnScore.level` included — would have been caught, which is the context in
 * which BusinessDetailClient kept its own `Record<string, string>`-keyed
 * HealthBadge copy for as long as it did (Pathfinder §A1). Do not reintroduce
 * either the narrowing or the cast.
 */
export type BusinessDetail = Omit<BusinessDetailResponse['business'], 'churnScore'> & {
  churnScore?: ChurnScore;
};

export type ReviewRow = BusinessDetailResponse['reviews'][number];
export type RankingSnapshot = BusinessDetailResponse['rankingSnapshots'][number];
export type {
  AccountAuditLogEntry,
  AccountContext,
  ApprovalAuditLogEntry,
  AutoApprovalDiagnostics,
  ZernioPanelData,
};

export interface DetailData {
  business: BusinessDetail;
  account: AccountContext;
  reviews: ReviewRow[];
  reviewsTotal: BusinessDetailResponse['reviewsTotal'];
  rankingSnapshots: RankingSnapshot[];
  zernio: ZernioPanelData;
  approvalAuditLog: ApprovalAuditLogEntry[];
  accountAuditLog: AccountAuditLogEntry[];
  autoApproval: AutoApprovalDiagnostics;
}

/**
 * UI state for the admin "Resend invite" action (plan step 9 / T7). Owned by
 * `useBusinessDetail` and rendered by `BusinessDetailClient` — deliberately not
 * a react-query mutation: nothing in the detail payload changes when an invite
 * is re-sent, so there is no cache to invalidate, only a message to show.
 */
export interface ResendInviteState {
  submitting: boolean;
  /** Success copy, cleared on the next attempt. */
  message: string | null;
  /** The server's mapped error message, cleared on the next attempt. */
  error: string | null;
}

export type ZernioConnectionSummary = NonNullable<ZernioPanelData['connection']>;
export type AwaitingOwnerConnectResponse = ZernioPanelData['awaitingOwnerConnect'][number];
export type ZernioFinalizeIncident = ZernioPanelData['unresolvedIncidents'][number];

/**
 * Single owner is `business-channels-service.ts` — the same module the channels
 * route and the detail server page both call, so the page's `initialChannels`
 * and the client's react-query refetch cannot drift apart.
 */
export type { AdminChannelEnrollment as ChannelEnrollmentRow } from '@/lib/admin/business-channels-service';
