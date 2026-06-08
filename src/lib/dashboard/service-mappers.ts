import { parseDbArray } from '@/lib/shared/db-array';
import { CONNECT_PENDING_STATUSES, type ConnectPendingMarker } from '@/lib/zernio/types';
import { mapRecentReviews, mapReviewVelocity } from './active-mappers';
import type { DashboardDataActive } from './types';
import { resolveZernioConnectionState } from './zernio-banner';

const MINUTES_SAVED_PER_RESPONSE = 7;

export interface DashboardBusinessRow {
  name: string;
  created_at: Date;
  initial_review_count: number | null;
  initial_responded_count: number | null;
  baseline_captured_at: Date | string | null;
  tone: string | null;
  products_services: string | null;
  avoid_facts: unknown;
  sample_responses: unknown;
  owner_phone: string | null;
  owner_email: string | null;
  weekly_summary_enabled: boolean | null;
  monthly_impact_enabled: boolean | null;
  category: string | null;
  google_place_id: string | null;
}

export interface DashboardRankingRow {
  keyword: string;
  snapshot_date: unknown;
  rank_position: number;
}

export interface DashboardBriefRow {
  summary_text?: string | null;
  month_start_date?: unknown;
  week_start_date?: unknown;
  sent_at?: unknown;
}

export interface DashboardZernioConnectionRow {
  status?: 'pending' | 'active' | 'disconnected';
  disconnect_reason?: string | null;
}

export function buildValueSummary(
  totalReviews: number,
  totalResponded: number,
  business: DashboardBusinessRow,
): DashboardDataActive['valueSummary'] {
  return {
    totalReviewsHandled: totalResponded,
    totalTimeSavedMinutes: totalResponded * MINUTES_SAVED_PER_RESPONSE,
    currentResponseRate: totalReviews > 0
      ? Math.round((totalResponded / totalReviews) * 100)
      : 0,
    baselineResponseRate: getBaselineResponseRate(business),
  };
}

function getBaselineResponseRate(
  business: DashboardBusinessRow,
): number | null {
  if (
    !business.baseline_captured_at ||
    business.initial_review_count == null ||
    business.initial_review_count <= 0
  ) {
    return null;
  }

  return Math.round(
    ((business.initial_responded_count ?? 0) / business.initial_review_count)
      * 100,
  );
}

export function buildRanking(
  rankingRows: DashboardRankingRow[],
): DashboardDataActive['ranking'] {
  const rankingMap = new Map<
    string,
    Array<{ date: string; position: number }>
  >();

  for (const row of rankingRows) {
    const snapshots = rankingMap.get(row.keyword) ?? [];
    snapshots.push({
      date: String(row.snapshot_date),
      position: row.rank_position,
    });
    rankingMap.set(row.keyword, snapshots);
  }

  return rankingMap.size > 0
    ? Array.from(rankingMap.entries()).map(([keyword, snapshots]) => ({
        keyword,
        snapshots,
      }))
    : null;
}

export function selectLatestBrief(
  monthlyBrief: DashboardBriefRow | undefined,
  weeklyBrief: DashboardBriefRow | undefined,
): DashboardDataActive['latestBrief'] {
  const monthlySentAt = sentAtMillis(monthlyBrief?.sent_at);
  const weeklySentAt = sentAtMillis(weeklyBrief?.sent_at);

  if (monthlyBrief?.summary_text && monthlySentAt >= weeklySentAt) {
    const monthlyDate = String(monthlyBrief.month_start_date);
    const d = new Date(`${monthlyDate}T00:00:00Z`);

    return {
      text: monthlyBrief.summary_text,
      type: 'monthly',
      periodLabel: d.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    };
  }

  if (weeklyBrief?.summary_text) {
    return {
      text: weeklyBrief.summary_text,
      type: 'weekly',
      periodLabel: `Week of ${String(weeklyBrief.week_start_date)}`,
    };
  }

  return null;
}

function sentAtMillis(value: unknown): number {
  return value ? new Date(value as string).getTime() : 0;
}

export function parsePendingFlow(
  pendingRaw: string | null,
): DashboardDataActive['zernioConnection']['pendingFlow'] | undefined {
  if (!pendingRaw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(pendingRaw) as ConnectPendingMarker;
    // Validate status against the canonical list, not just `typeof string`: a
    // malformed marker must not leak an out-of-union status into pendingFlow
    // and violate the DashboardDataActive contract.
    if (
      parsed &&
      typeof parsed.status === 'string' &&
      (CONNECT_PENDING_STATUSES as readonly string[]).includes(parsed.status) &&
      typeof parsed.started_at === 'number'
    ) {
      return {
        status: parsed.status as ConnectPendingMarker['status'],
        started_at: parsed.started_at,
      };
    }
  } catch (err) {
    console.error('[dashboard/service] malformed connect_pending marker:', err);
  }

  return undefined;
}

export function buildDashboardSettings(
  business: DashboardBusinessRow,
): DashboardDataActive['settings'] {
  return {
    tone: business.tone ?? 'professional and friendly',
    productsServices: business.products_services ?? '',
    avoidFacts: parseDbArray(business.avoid_facts),
    sampleResponses: parseDbArray(business.sample_responses),
    ownerPhone: business.owner_phone ?? '',
    ownerEmail: business.owner_email ?? '',
    weeklySummaryEnabled: business.weekly_summary_enabled ?? true,
    monthlyImpactEnabled: business.monthly_impact_enabled ?? true,
    category: business.category ?? '',
    googlePlaceId: business.google_place_id ?? '',
  };
}

function buildZernioConnection(
  input: {
    hasUnresolvedIncident: boolean;
    zernioRow: DashboardZernioConnectionRow | undefined;
    queuedReconnectCount: number;
    pendingRaw: string | null;
  },
): DashboardDataActive['zernioConnection'] {
  return resolveZernioConnectionState({
    hasUnresolvedIncident: input.hasUnresolvedIncident,
    connectionStatus: input.zernioRow?.status,
    pendingFlow: parsePendingFlow(input.pendingRaw),
    queuedReconnectCount: input.queuedReconnectCount,
    lastDisconnectReason: input.zernioRow?.disconnect_reason ?? undefined,
  });
}

export function buildActiveDashboardResponse(
  input: {
    business: DashboardBusinessRow;
    totalReviews: number;
    totalResponded: number;
    velocityRows: Array<{ week_start: unknown; count: unknown }>;
    rankingRows: DashboardRankingRow[];
    recentReviewRows: Array<Record<string, unknown>>;
    monthlyBrief: DashboardBriefRow | undefined;
    weeklyBrief: DashboardBriefRow | undefined;
    zernioRow: DashboardZernioConnectionRow | undefined;
    queuedReconnectCount: number;
    hasUnresolvedIncident: boolean;
    pendingRaw: string | null;
  },
): DashboardDataActive {
  return {
    business: {
      name: input.business.name,
      createdAt: input.business.created_at.toISOString(),
    },
    valueSummary: buildValueSummary(
      input.totalReviews,
      input.totalResponded,
      input.business,
    ),
    reviewVelocity: mapReviewVelocity(input.velocityRows),
    ranking: buildRanking(input.rankingRows),
    recentReviews: mapRecentReviews(input.recentReviewRows),
    latestBrief: selectLatestBrief(input.monthlyBrief, input.weeklyBrief),
    settings: buildDashboardSettings(input.business),
    zernioConnection: buildZernioConnection({
      hasUnresolvedIncident: input.hasUnresolvedIncident,
      zernioRow: input.zernioRow,
      queuedReconnectCount: input.queuedReconnectCount,
      pendingRaw: input.pendingRaw,
    }),
  };
}
