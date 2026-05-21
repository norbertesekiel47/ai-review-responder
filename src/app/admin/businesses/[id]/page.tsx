'use client';

// Auth: Supabase session checked by src/middleware.ts (admin role required)

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ProfileEditor } from './components/ProfileEditor';
import { TrackedKeywordsSection } from './components/TrackedKeywordsSection';
import { ManualRankingSection } from './components/ManualRankingSection';
import { ReviewsList } from './components/ReviewsList';
import { ChannelsPanel } from './components/ChannelsPanel';
import { ZernioConnectionPanel } from './components/ZernioConnectionPanel';
import { useBusinessDetail } from './hooks/useBusinessDetail';

function HealthBadge({ level, score }: { level: string; score: number }) {
  const styles: Record<string, string> = {
    healthy: 'bg-green-100 text-green-800',
    watch: 'bg-amber-100 text-amber-800',
    at_risk: 'bg-red-100 text-red-800',
  };
  const labels: Record<string, string> = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At Risk' };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${styles[level] ?? styles.healthy}`}>
      {labels[level] ?? level} <span className="opacity-60">{score}</span>
    </span>
  );
}

export default function BusinessDetailPage() {
  const { id: businessId } = useParams<{ id: string }>();
  const { data, isLoading, isError, error, enrollments, invalidate, clearBounceFlag } = useBusinessDetail(businessId);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-red-600 text-sm">
        {error instanceof Error ? error.message : 'Failed to load business'}
      </div>
    );
  }

  const { business, reviews, rankingSnapshots, zernio, account, approvalAuditLog, accountAuditLog } = data;

  const mapsUrl = business.googlePlaceId
    ? `https://www.google.com/maps/place/?q=place_id:${business.googlePlaceId}`
    : null;

  // Other locations under the same account (excluding current one)
  const otherLocations = account.locations.filter(
    (loc) => loc.id !== businessId && !loc.archivedAt,
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-8">

        {/* Back + Header */}
        <Link
          href="/admin/overview"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Back to Overview
        </Link>
        <div className="mt-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{business.name}</h1>
            {business.churnScore && (
              <HealthBadge level={business.churnScore.level} score={business.churnScore.score} />
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-sm text-gray-500 items-center">
            <span className="rounded bg-gray-100 px-2 py-0.5 font-medium text-gray-700">
              {business.subscriptionStatus.replace(/_/g, ' ')}
            </span>
            <span className="rounded bg-indigo-100 px-2 py-0.5 font-medium text-indigo-700">
              {business.subscriptionTier}
            </span>
            {business.category && <span>{business.category}</span>}
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                Google Maps
              </a>
            )}
          </div>
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
          <div className="mt-4 mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-sm font-semibold text-blue-900">
                Account ({account.locations.length} locations)
              </h2>
              <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                {account.subscriptionTier}
              </span>
              <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
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
                      ? 'bg-blue-600 text-white'
                      : loc.archivedAt
                      ? 'bg-gray-200 text-gray-500 line-through'
                      : 'bg-white text-blue-700 border border-blue-300 hover:bg-blue-100'
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

        {/* Profile editor */}
        <ProfileEditor
          business={business}
          businessId={businessId}
          onSaved={invalidate}
        />

        {/* Review list */}
        <ReviewsList reviews={reviews} />

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
                          item.contribution > 5 ? 'bg-amber-400' : 'bg-green-400'
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

        {/* Channels (table + flag-gated SMS / Telegram / WhatsApp enrollment) */}
        <ChannelsPanel business={business} businessId={businessId} enrollments={enrollments} />

        {/* Zernio connection panel — auto-publishing state, queued reconnects, ops incidents */}
        <ZernioConnectionPanel
          businessId={businessId}
          zernio={zernio}
          onChanged={invalidate}
        />

        {/* Approval Audit Log (VAL-ADMIN-004) */}
        {approvalAuditLog.length > 0 && (
          <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Approval Audit Log</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Event</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Actor</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {approvalAuditLog.slice(0, 10).map((entry) => (
                    <tr key={entry.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-700 capitalize">{entry.action.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-2 text-gray-500">{entry.actorUserId ?? '—'}</td>
                      <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{new Date(entry.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Account Audit Log — account-level state changes */}
        {accountAuditLog.length > 0 && (
          <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Account Audit Log</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Event</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Location</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {accountAuditLog.slice(0, 10).map((entry) => {
                    const locName = entry.locationId
                      ? account.locations.find((l) => l.id === entry.locationId)?.name ?? entry.locationId
                      : '—';
                    return (
                      <tr key={entry.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-700 capitalize">{entry.eventType.replace(/_/g, ' ')}</td>
                        <td className="px-4 py-2 text-gray-500">{locName}</td>
                        <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{new Date(entry.createdAt).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

      </div>
    </div>
  );
}
