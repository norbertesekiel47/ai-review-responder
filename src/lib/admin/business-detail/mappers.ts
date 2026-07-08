// src/lib/admin/business-detail/mappers.ts
//
// Pure mapping functions: DB rows → BusinessDetailResponse DTO.
// Extracted verbatim from business-detail-service.ts; only
// export/import wiring changed. No edits to computation or mapping logic.

import { computeChurnRiskScore } from '@/lib/shared/churn-score';
import { parseDbArray } from '@/lib/shared/db-array';
import { isPreviewEnvironment } from '@/lib/config/flags';
import { channelsTelegramEnabled, channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import {
  autoApprovalRuntimeEnabled,
  providerModerationEnabled,
  providerModerationValidated,
} from '@/lib/auto-approval/flags';
import { resolveEffectivePolicy } from '@/lib/auto-approval/policy';
import { buildAutoApprovalReadiness } from '@/lib/auto-approval/readiness';
import { assertWritableSubscriptionStatus } from '@/lib/shared/writable-subscription';
import type {
  AccountContext,
  AccountAuditLogEntry,
  AccountLocationSummary,
  ApprovalAuditLogEntry,
  AwaitingOwnerConnectRow,
  AutoApprovalDiagnostics,
  AutoApprovalPolicyDiagnostic,
  BusinessDetailResponse,
  BusinessRow,
  RankingSnapshotRow,
  ReviewRow,
  ZernioConnectionRow,
  ZernioFinalizeIncidentRow,
  ZernioPanelData,
} from '../business-detail-types';
import type {
  AccountAuditRow,
  AccountLocationRow,
  ApprovalAuditRow,
  AutoApprovalAccountRow,
  AutoApprovalPolicyRow,
  BusinessMetricsRow,
} from './queries';
import type { PolicyRowState } from '@/lib/auto-approval/types';

const AUTO_APPROVAL_AUDIT_ACTIONS = new Set([
  'auto_approved_by_policy',
  'auto_policy_revoked_by_kill_switch',
]);

/**
 * Convert raw DB rows for the Zernio admin panel into the wire shape. The
 * connection lookup returns the most recently created row regardless of
 * status — the surface differentiates `null` (no connection ever attempted)
 * from `disconnected` (connection existed and is now broken) so the UI can
 * show the correct CTA.
 */
function buildZernioPanel(
  connection: ZernioConnectionRow | null,
  awaitingOwnerConnect: AwaitingOwnerConnectRow[],
  unresolvedIncidents: ZernioFinalizeIncidentRow[],
): ZernioPanelData {
  return {
    connection: connection
      ? {
          status: connection.status,
          connectedAt: connection.connected_at
            ? connection.connected_at.toISOString()
            : null,
          disconnectedAt: connection.disconnected_at
            ? connection.disconnected_at.toISOString()
            : null,
          disconnectReason: connection.disconnect_reason,
          lastError: connection.last_error,
          lastErrorAt: connection.last_error_at
            ? connection.last_error_at.toISOString()
            : null,
          zernioAccountId: connection.zernio_account_id,
          zernioLocationId: connection.zernio_location_id,
        }
      : null,
    awaitingOwnerConnect: awaitingOwnerConnect.map((r) => ({
      responseId: r.id,
      createdAt: r.created_at.toISOString(),
      draftText: r.draft_text,
      reviewerName: r.reviewer_name,
      reviewText: r.review_text,
      starRating: r.star_rating,
    })),
    unresolvedIncidents: unresolvedIncidents.map((i) => ({
      id: i.id,
      finalizeUnknownAt: i.finalize_unknown_at.toISOString(),
      flowId: i.flow_id,
      zernioProfileId: i.zernio_profile_id,
    })),
  };
}

function mapApprovalAuditRow(row: ApprovalAuditRow): ApprovalAuditLogEntry {
  return {
    id: row.id,
    responseId: row.response_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

function mapAccountAuditRow(row: AccountAuditRow): AccountAuditLogEntry {
  return {
    id: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    locationId: row.location_id,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

function toPolicyState(row: AutoApprovalPolicyRow | undefined): PolicyRowState | null {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    locationId: row.location_id,
    autoApproveMinStar: row.auto_approve_min_star,
    vetoWindowMinutes: row.veto_window_minutes,
    dailyAutoPostCap: row.daily_auto_post_cap,
    suspendedAt: row.suspended_at,
  };
}

function toPolicyDiagnostic(row: AutoApprovalPolicyRow | undefined): AutoApprovalPolicyDiagnostic {
  return {
    policyId: row?.id ?? null,
    threshold: row?.auto_approve_min_star ?? null,
    exists: !!row,
  };
}

function buildAutoApprovalDiagnostics({
  accountLocationRows,
  approvalAuditRows,
  accountAuditRows,
  autoApprovalPolicyRows,
  autoApprovalAccountRows,
}: {
  accountLocationRows: AccountLocationRow[];
  approvalAuditRows: ApprovalAuditRow[];
  accountAuditRows: AccountAuditRow[];
  autoApprovalPolicyRows: AutoApprovalPolicyRow[];
  autoApprovalAccountRows: AutoApprovalAccountRow[];
}): AutoApprovalDiagnostics {
  const accountDefault = autoApprovalPolicyRows.find((row) => row.location_id === null);
  const accountDefaultState = toPolicyState(accountDefault);
  const overridesByLocation = new Map(
    autoApprovalPolicyRows
      .filter((row) => row.location_id !== null)
      .map((row) => [row.location_id!, row]),
  );
  const runtimeEnabled = autoApprovalRuntimeEnabled();
  const moderationEnabled = providerModerationEnabled();
  const moderationValidated = providerModerationValidated();
  const previewEnvironment = isPreviewEnvironment();
  const accountRow = autoApprovalAccountRows[0];
  const writable = accountRow
    ? assertWritableSubscriptionStatus({
        subscriptionStatus: accountRow.subscription_status,
        pastDueAt: accountRow.past_due_at,
        accountFlags: accountRow.flags,
      })
    : { ok: false as const, status: 403 as const, error: 'no_business' };

  // Admin diagnostics are observational, not a settings gate, so readiness is derived
  // without an `impersonated` input — it reflects environment/account state, not the
  // admin's view-as session (which is always blocked from expanding by the owner route).
  const readiness = buildAutoApprovalReadiness({
    runtimeEnabled,
    providerModerationEnabled: moderationEnabled,
    providerModerationValidated: moderationValidated,
    accountWritable: writable.ok,
    previewEnvironment,
  });

  return {
    accountDefault: toPolicyDiagnostic(accountDefault),
    locations: accountLocationRows.map((location) => {
      const override = overridesByLocation.get(location.id);
      const effective = resolveEffectivePolicy(accountDefaultState, toPolicyState(override));
      return {
        locationId: location.id,
        displayName: location.display_label ?? location.name,
        isPrimary: location.is_primary,
        archivedAt: location.archived_at ? location.archived_at.toISOString() : null,
        override: toPolicyDiagnostic(override),
        effective: {
          threshold: effective.threshold,
          source: effective.source,
          policyId: effective.policyId,
        },
      };
    }),
    readiness,
    recentApprovalAudit: approvalAuditRows.flatMap((row) =>
      AUTO_APPROVAL_AUDIT_ACTIONS.has(row.action) ? [mapApprovalAuditRow(row)] : [],
    ),
    recentPolicyChanges: accountAuditRows.flatMap((row) =>
      row.event_type === 'auto_approval_policy_changed' ? [mapAccountAuditRow(row)] : [],
    ),
  };
}

export interface MapBusinessDetailResponseArgs {
  business: BusinessRow;
  reviewRows: ReviewRow[];
  rankingSnapshots: RankingSnapshotRow[];
  zernioConnectionRows: ZernioConnectionRow[];
  awaitingOwnerConnectRows: AwaitingOwnerConnectRow[];
  finalizeIncidentRows: ZernioFinalizeIncidentRow[];
  metrics: BusinessMetricsRow | undefined;
  accountLocationRows: AccountLocationRow[];
  approvalAuditRows: ApprovalAuditRow[];
  accountAuditRows: AccountAuditRow[];
  autoApprovalPolicyRows: AutoApprovalPolicyRow[];
  autoApprovalAccountRows: AutoApprovalAccountRow[];
}

/**
 * Assemble the full BusinessDetailResponse DTO from batch-1 and batch-2
 * query results. Contains responseTimeTrend derivation, computeChurnRiskScore
 * call, accountLocations/accountContext construction, and final assembly.
 */
export function mapBusinessDetailResponse({
  business,
  reviewRows,
  rankingSnapshots,
  zernioConnectionRows,
  awaitingOwnerConnectRows,
  finalizeIncidentRows,
  metrics,
  accountLocationRows,
  approvalAuditRows,
  accountAuditRows,
  autoApprovalPolicyRows,
  autoApprovalAccountRows,
}: MapBusinessDetailResponseArgs): BusinessDetailResponse {
  let responseTimeTrend: 'faster_or_stable' | 'slower' | 'stopped' | null = null;
  if (metrics?.avg_hours_current != null && metrics?.avg_hours_prev != null) {
    responseTimeTrend = metrics.avg_hours_current > metrics.avg_hours_prev * 1.5 ? 'slower' : 'faster_or_stable';
  } else if (metrics && metrics.pending_count > 0 && metrics.days_since_approval != null && metrics.days_since_approval > 7) {
    responseTimeTrend = 'stopped';
  }

  const churnScore = computeChurnRiskScore({
    approvalRate: metrics?.approval_rate ?? null,
    notifiedResponseCount30d: metrics?.notified_count ?? 0,
    pendingResponseCount: metrics?.pending_count ?? 0,
    daysSinceLastApproval: metrics?.days_since_approval ?? null,
    satisfactionResponses: null,
    responseTimeTrend,
    accountAgeDays: metrics?.account_age_days ?? 0,
  });

  const accountLocations: AccountLocationSummary[] = accountLocationRows.map((row) => ({
    id: row.id,
    name: row.name,
    displayLabel: row.display_label,
    isPrimary: row.is_primary,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
  }));

  const accountContext: AccountContext = {
    id: business.account_id,
    displayName: business.name, // Use the primary business name or account display_name
    subscriptionTier: business.subscription_tier,
    subscriptionStatus: business.subscription_status,
    locations: accountLocations,
  };

  return {
    business: {
      id: business.id,
      name: business.name,
      category: business.category ?? null,
      website: business.website ?? null,
      googlePlaceId: business.google_place_id ?? null,
      tone: business.tone ?? null,
      productsServices: business.products_services ?? null,
      staffNames: parseDbArray(business.staff_names),
      highlightFacts: parseDbArray(business.highlight_facts),
      avoidFacts: parseDbArray(business.avoid_facts),
      sampleResponses: parseDbArray(business.sample_responses),
      subscriptionStatus: business.subscription_status,
      subscriptionTier: business.subscription_tier,
      ownerName: business.owner_name ?? null,
      ownerEmail: business.owner_email ?? null,
      lastSyncAt: business.last_sync_at ? business.last_sync_at.toISOString() : null,
      trackedKeywords: parseDbArray(business.tracked_keywords),
      googlePlaceLat: business.google_place_lat,
      googlePlaceLng: business.google_place_lng,
      rankingSearchLocation: business.ranking_search_location,
      googlePlaceAddress: business.google_place_address,
      ownerEmailBounced: business.owner_email_bounced ?? false,
      telegramEnabled: channelsTelegramEnabled(),
      whatsappEnabled: channelsWhatsappEnabled(),
      churnScore,
    },
    account: accountContext,
    rankingSnapshots: rankingSnapshots.map((s) => ({
      keyword: s.keyword,
      rankPosition: s.rank_position,
      snapshotDate: s.snapshot_date,
      source: s.source,
    })),
    reviews: reviewRows.map((row) => ({
      id: row.id,
      reviewerName: row.reviewer_name,
      starRating: row.star_rating,
      reviewText: row.review_text ?? null,
      reviewDate: row.review_date ?? null,
      detectedLanguage: row.detected_language ?? null,
      detectedAt: row.detected_at ? row.detected_at.toISOString() : null,
      responseId: row.response_id ?? null,
      responseStatus: row.response_status ?? null,
      responseText: row.response_text ?? null,
      approvedText: row.approved_text ?? null,
      approvalMethod: row.approval_method ?? null,
      responseVersion: row.version ?? null,
    })),
    zernio: buildZernioPanel(
      zernioConnectionRows[0] ?? null,
      awaitingOwnerConnectRows,
      finalizeIncidentRows,
    ),
    approvalAuditLog: approvalAuditRows.map(mapApprovalAuditRow),
    accountAuditLog: accountAuditRows.map(mapAccountAuditRow),
    autoApproval: buildAutoApprovalDiagnostics({
      accountLocationRows,
      approvalAuditRows,
      accountAuditRows,
      autoApprovalPolicyRows,
      autoApprovalAccountRows,
    }),
  };
}
