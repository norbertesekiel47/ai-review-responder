'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required); the
// server page additionally gates with requireAdminPage and supplies both reads
// as react-query initialData, so first paint has data (spec §4).

import Link from 'next/link';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { EmptyState, ErrorState } from '@/components/admin/ui/states';
import { ProfileEditor } from './_components/ProfileEditor';
import { TrackedKeywordsSection } from './_components/TrackedKeywordsSection';
import { ManualRankingSection } from './_components/ManualRankingSection';
import { ReviewsList } from './_components/ReviewsList';
import { ChannelsPanel } from './_components/ChannelsPanel';
import { ZernioConnectionPanel } from './_components/ZernioConnectionPanel';
import { PastDueExtensionPanel } from './_components/PastDueExtensionPanel';
import { AutoApprovalDiagnosticsPanel } from './_components/AutoApprovalDiagnosticsPanel';
import { useBusinessDetail } from './_hooks/useBusinessDetail';
import type {
  AccountAuditLogEntry,
  AccountContext,
  ApprovalAuditLogEntry,
  ChannelEnrollmentRow,
  DetailData,
} from './types';

/** Audit tables were hand-sliced to 10 rows; DataTable now pages at the same size. */
const AUDIT_PAGE_SIZE = 10;

const HEALTH_BADGE_STYLES: Record<string, string> = {
  healthy: 'bg-green-100 text-green-800',
  watch: 'bg-gray-100 text-gray-700',
  at_risk: 'bg-red-100 text-red-800',
};
const HEALTH_BADGE_LABELS: Record<string, string> = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At Risk' };

/**
 * Deliberately NOT the shared `StatusBadge` — churn health is a derived
 * engagement score (healthy/watch/at_risk), not a subscription or job status,
 * and it renders a numeric score alongside the label.
 */
function HealthBadge({ level, score }: { level: string; score: number }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${HEALTH_BADGE_STYLES[level] ?? HEALTH_BADGE_STYLES.healthy}`}>
      {HEALTH_BADGE_LABELS[level] ?? level} <span className="opacity-60">{score}</span>
    </span>
  );
}

const approvalAuditColumns: DataTableColumn<ApprovalAuditLogEntry>[] = [
  {
    key: 'event',
    header: 'Event',
    render: (entry) => <span className="capitalize">{entry.action.replace(/_/g, ' ')}</span>,
    sortValue: (entry) => entry.action,
  },
  { key: 'actor', header: 'Actor', render: (entry) => entry.actorUserId ?? '—' },
  {
    key: 'date',
    header: 'Date',
    render: (entry) => (
      <span className="whitespace-nowrap">{new Date(entry.createdAt).toLocaleString()}</span>
    ),
    sortValue: (entry) => entry.createdAt,
  },
];

function accountAuditColumns(account: AccountContext): DataTableColumn<AccountAuditLogEntry>[] {
  return [
    {
      key: 'event',
      header: 'Event',
      render: (entry) => <span className="capitalize">{entry.eventType.replace(/_/g, ' ')}</span>,
      sortValue: (entry) => entry.eventType,
    },
    {
      key: 'location',
      header: 'Location',
      render: (entry) =>
        entry.locationId
          ? account.locations.find((l) => l.id === entry.locationId)?.name ?? entry.locationId
          : '—',
    },
    {
      key: 'date',
      header: 'Date',
      render: (entry) => (
        <span className="whitespace-nowrap">{new Date(entry.createdAt).toLocaleString()}</span>
      ),
      sortValue: (entry) => entry.createdAt,
    },
  ];
}

interface BusinessDetailClientProps {
  businessId: string;
  initialDetail: DetailData;
  initialChannels: ChannelEnrollmentRow[];
}

export function BusinessDetailClient({
  businessId,
  initialDetail,
  initialChannels,
}: BusinessDetailClientProps) {
  const { data, isLoading, isError, error, enrollments, invalidate, clearBounceFlag } =
    useBusinessDetail(businessId, { initialDetail, initialChannels });

  const failedRequest = `GET /api/admin/businesses/${businessId}`;

  // With initialDetail present these two branches are unreachable on first
  // paint — that is the point. They remain for the refetch-failure-after-
  // cache-eviction case (convention #1: never blank a page that has data).
  if (isLoading && !data) {
    return <div className="py-12 text-center text-sm text-gray-500">Loading…</div>;
  }
  if (isError && !data) {
    return (
      <ErrorState
        title="Couldn't load business"
        detail={
          error instanceof Error
            ? `${failedRequest} failed — ${error.message}`
            : `${failedRequest} failed`
        }
      />
    );
  }
  if (!data) return null;

  const {
    business,
    reviews,
    reviewsTotal,
    rankingSnapshots,
    zernio,
    account,
    approvalAuditLog,
    accountAuditLog,
    autoApproval,
  } = data;

  const mapsUrl = business.googlePlaceId
    ? `https://www.google.com/maps/place/?q=place_id:${business.googlePlaceId}`
    : null;

  return (
    <>
      {isError && (
        <div className="mb-4">
          <ErrorState
            title="Last refresh failed"
            detail={`${failedRequest} failed — showing the last loaded data.`}
          />
        </div>
      )}

      {/* Back link + meta row — AdminPage owns the title/eyebrow above this. */}
      <Link
        href="/admin/businesses"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
      >
        <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to Businesses
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-500">
        {business.churnScore && (
          <HealthBadge level={business.churnScore.level} score={business.churnScore.score} />
        )}
        <span className="rounded bg-gray-100 px-2 py-0.5 font-medium text-gray-700">
          {business.subscriptionStatus.replace(/_/g, ' ')}
        </span>
        <span className="rounded bg-gray-100 px-2 py-0.5 font-medium text-gray-700">
          {business.subscriptionTier}
        </span>
        {business.category && <span>{business.category}</span>}
        {mapsUrl && (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-600 underline hover:text-gray-900"
          >
            Google Maps
          </a>
        )}
      </div>

      {business.ownerEmailBounced && (
        <div className="mt-4 mb-4 rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-800">
            ⚠ Owner email is bouncing
          </p>
          <p className="mt-1 text-sm text-red-700">
            Approval emails, weekly reports, monthly impact, drip emails, and owner nudges
            are skipped for <code className="rounded bg-red-100 px-1">{business.ownerEmail}</code>.
            Partner/admin alerts still send.
          </p>
          <p className="mt-2 text-sm text-red-700">
            Verify the email address with the owner. If it changed, update it in the
            Business Profile section below (Edit → Owner Email), then clear the flag with
            the button below. See <code>docs/email-deliverability.md</code> for the full runbook.
          </p>
          <button
            type="button"
            onClick={() => { void clearBounceFlag(); }}
            className="mt-3 rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
          >
            Clear bounce flag (after verifying address)
          </button>
        </div>
      )}

      {/* Account context — multi-location info (VAL-ADMIN-001) */}
      {account.locations.length > 1 && (
        <div className="mt-4 mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-gray-900">
              Account ({account.locations.length} locations)
            </h2>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
              {account.subscriptionTier}
            </span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
              {account.subscriptionStatus.replace(/_/g, ' ')}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {account.locations.map((loc) => (
              <a
                key={loc.id}
                href={`/admin/businesses/${loc.id}`}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                  loc.id === businessId
                    ? 'bg-gray-900 text-white'
                    : loc.archivedAt
                    ? 'bg-gray-200 text-gray-500 line-through'
                    : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-100'
                }`}
              >
                {loc.displayLabel ?? loc.name}
                {loc.isPrimary && (
                  <span className="ml-1 rounded bg-yellow-200 px-1 text-[10px] text-yellow-800">primary</span>
                )}
              </a>
            ))}
          </div>
        </div>
      )}

      <PastDueExtensionPanel
        accountId={account.id}
        subscriptionStatus={account.subscriptionStatus}
        onGranted={invalidate}
      />

      <AutoApprovalDiagnosticsPanel diagnostics={autoApproval} />

      {/* Profile editor */}
      <ProfileEditor
        business={business}
        businessId={businessId}
        onSaved={invalidate}
      />

      {/* Review list */}
      <ReviewsList reviews={reviews} totalCount={reviewsTotal} />

      {/* Engagement / churn risk */}
      {business.churnScore && (
        <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Engagement</h2>
            <HealthBadge level={business.churnScore.level} score={business.churnScore.score} />
          </div>
          <div className="space-y-3">
            {business.churnScore.breakdown.map((item) => (
              <div key={item.signal} className="flex items-center justify-between text-sm">
                <div>
                  <span className="font-medium text-gray-700">{item.signal}:</span>{' '}
                  <span className="text-gray-500">{item.value}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-24 rounded bg-gray-100 overflow-hidden">
                    <div
                      className={`h-full rounded ${
                        item.contribution > 15 ? 'bg-red-400' :
                        item.contribution > 5 ? 'bg-yellow-400' : 'bg-green-400'
                      }`}
                      style={{ width: `${Math.min(item.contribution * 3, 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-400 w-8 text-right">{item.contribution}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Tracked Keywords */}
      <TrackedKeywordsSection businessId={businessId} keywords={business.trackedKeywords} />

      {/* Ranking */}
      <ManualRankingSection businessId={businessId} snapshots={rankingSnapshots ?? []} />

      {/* Channels (table + flag-gated Telegram / WhatsApp enrollment) */}
      <ChannelsPanel business={business} businessId={businessId} enrollments={enrollments} />

      {/* Zernio connection panel — auto-publishing state, queued reconnects, ops incidents */}
      <ZernioConnectionPanel
        businessId={businessId}
        zernio={zernio}
        onChanged={invalidate}
      />

      {/* Approval Audit Log (VAL-ADMIN-004) */}
      {approvalAuditLog.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold text-gray-900">Approval Audit Log</h2>
          <DataTable
            columns={approvalAuditColumns}
            rows={approvalAuditLog}
            rowKey={(entry) => entry.id}
            pageSize={AUDIT_PAGE_SIZE}
            // Unreachable behind the length guard above; passed for type completeness.
            emptyState={<EmptyState title="No approval audit entries" />}
          />
        </section>
      )}

      {/* Account Audit Log — account-level state changes */}
      {accountAuditLog.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold text-gray-900">Account Audit Log</h2>
          <DataTable
            columns={accountAuditColumns(account)}
            rows={accountAuditLog}
            rowKey={(entry) => entry.id}
            pageSize={AUDIT_PAGE_SIZE}
            // Unreachable behind the length guard above; passed for type completeness.
            emptyState={<EmptyState title="No account audit entries" />}
          />
        </section>
      )}
    </>
  );
}
