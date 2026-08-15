import type {
  AccountAuditLogEntry,
  AccountContext,
  ApprovalAuditLogEntry,
  AutoApprovalDiagnostics,
  BusinessDetailResponse,
  ZernioPanelData,
} from '@/lib/admin/business-detail-types';
import type { ChurnScore } from '@/lib/shared/churn-score';

export type BusinessDetail = Omit<
  BusinessDetailResponse['business'],
  'tone' | 'ownerName' | 'ownerEmail' | 'churnScore'
> & {
  tone: string;
  ownerName: string;
  ownerEmail: string;
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
