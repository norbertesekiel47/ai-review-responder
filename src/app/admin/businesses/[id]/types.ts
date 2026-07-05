import type {
  AccountAuditLogEntry,
  AccountContext,
  ApprovalAuditLogEntry,
  AutoApprovalDiagnostics,
  BusinessDetailResponse,
  ZernioPanelData,
} from '@/lib/admin/business-detail-types';
import type { ChurnScore } from '@/lib/shared/churn-score';
import type { ChannelId } from '@/lib/notifications/channels/types';

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
  rankingSnapshots: RankingSnapshot[];
  zernio: ZernioPanelData;
  approvalAuditLog: ApprovalAuditLogEntry[];
  accountAuditLog: AccountAuditLogEntry[];
  autoApproval: AutoApprovalDiagnostics;
}

export type ZernioConnectionSummary = NonNullable<ZernioPanelData['connection']>;
export type AwaitingOwnerConnectResponse = ZernioPanelData['awaitingOwnerConnect'][number];
export type ZernioFinalizeIncident = ZernioPanelData['unresolvedIncidents'][number];

export interface ChannelEnrollmentRow {
  channel: ChannelId;
  handle: string;
  status: 'pending_verification' | 'verified' | 'disabled' | 'unsubscribed';
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  last_activity_at: string | null;
}
