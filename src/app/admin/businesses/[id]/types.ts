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

export type ZernioConnectionSummary = NonNullable<ZernioPanelData['connection']>;
export type AwaitingOwnerConnectResponse = ZernioPanelData['awaitingOwnerConnect'][number];
export type ZernioFinalizeIncident = ZernioPanelData['unresolvedIncidents'][number];

/**
 * Single owner is `business-channels-service.ts` — the same module the channels
 * route and the detail server page both call, so the page's `initialChannels`
 * and the client's react-query refetch cannot drift apart.
 */
export type { AdminChannelEnrollment as ChannelEnrollmentRow } from '@/lib/admin/business-channels-service';
