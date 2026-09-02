'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required); the
// server page additionally gates with requireAdminPage and supplies both reads
// as react-query initialData, so first paint has data (spec §4).

import { type ReactNode } from 'react';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { EmptyState, ErrorState } from '@/components/admin/ui/states';
import { formatAdminDateTime } from '@/components/admin/ui/format';
import { HealthBadge } from '@/components/admin/ui/HealthBadge';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';
import { ProfileEditor } from './_components/ProfileEditor';
import { TrackedKeywordsSection } from './_components/TrackedKeywordsSection';
import { ManualRankingSection } from './_components/ManualRankingSection';
import { ReviewsList } from './_components/ReviewsList';
import { ChannelsPanel } from './_components/ChannelsPanel';
import { ZernioConnectionPanel } from './_components/ZernioConnectionPanel';
import { PastDueExtensionPanel } from './_components/PastDueExtensionPanel';
import { OwnerEmailBounceNotice } from './_components/OwnerEmailBounceNotice';
import { AutoApprovalDiagnosticsPanel } from './_components/AutoApprovalDiagnosticsPanel';
import { SolicitationBatchPanel } from './_components/SolicitationBatchPanel';
import { useBusinessDetail } from './_hooks/useBusinessDetail';
import type { AdminBatchSummary } from '@/lib/solicitation/batch-view';
import type {
  AccountAuditLogEntry,
  AccountContext,
  ApprovalAuditLogEntry,
  ChannelEnrollmentRow,
  DetailData,
  ResendInviteState,
} from './types';

/** Audit tables were hand-sliced to 10 rows; DataTable now pages at the same size. */
const AUDIT_PAGE_SIZE = 10;

/**
 * The page's sections, in page order, as the sticky jump-link row renders them
 * (X27). Twelve stacked panels in one column had no wayfinding — the Zernio
 * panel the runbook sends an operator to sat about eight screens down. Each id
 * is the anchor on the section's wrapper; `scroll-mt-*` on the wrapper keeps
 * the heading clear of the sticky row after the jump.
 */
const SECTION_ANCHORS = [
  { id: 'profile', label: 'Profile' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'engagement', label: 'Engagement' },
  { id: 'keywords', label: 'Keywords' },
  { id: 'ranking', label: 'Ranking' },
  { id: 'channels', label: 'Channels' },
  { id: 'zernio', label: 'Zernio' },
  { id: 'audit', label: 'Audit log' },
] as const;

type SectionId = (typeof SECTION_ANCHORS)[number]['id'];

const ANCHOR_CLASS = 'scroll-mt-14';

function JumpLinks({ available }: { available: ReadonlySet<SectionId> }) {
  return (
    <nav
      aria-label="Sections"
      className="sticky top-0 z-20 -mx-4 mt-4 flex gap-1 overflow-x-auto border-b border-gray-200 bg-gray-50/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6"
    >
      {SECTION_ANCHORS.filter((section) => available.has(section.id)).map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          onClick={() => {
            // A jump into a collapsed section opens it first; a browser scrolls
            // to a closed <details> but does not expand it.
            const target = document.getElementById(section.id);
            if (target instanceof HTMLDetailsElement) target.open = true;
          }}
          className="whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * A default-collapsed card (X27) for the sections an operator opens on purpose
 * rather than on every visit — Engagement, Keywords, Ranking. A native
 * <details>, so the state needs no JS and the jump row can open it by setting
 * `.open`. The <summary> carries the section's h2 so the heading outline is
 * unchanged whether the card is open or closed.
 */
function CollapsibleSection({
  id,
  title,
  aside,
  children,
}: {
  id: SectionId;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details id={id} className={`group mt-8 rounded-lg border border-gray-200 bg-white ${ANCHOR_CLASS}`}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-6 py-4 [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-gray-400 transition-transform group-open:rotate-90">
          ›
        </span>
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {aside}
        <span className="ml-auto text-xs text-gray-500 group-open:hidden">Show</span>
        <span className="ml-auto hidden text-xs text-gray-500 group-open:inline">Hide</span>
      </summary>
      <div className="px-6 pb-6">{children}</div>
    </details>
  );
}

/**
 * "Resend invite" (plan step 9 / T7). Visible only while the Account is
 * `pending_payment` — past that, the invite stage is over and the server
 * rejects the action anyway; showing a button whose only outcome is a 409 is
 * worse than showing none.
 *
 * Visibility is NOT the eligibility check: the authoritative "has this owner
 * ever signed in" signal lives with Supabase (`last_sign_in_at`), because
 * `users.auth_id` is patched at creation time and is true for every
 * never-accepted invite. The server owns that decision; this panel renders its
 * verdict.
 *
 * No confirm()/alert() — the button disables while in flight and the outcome
 * lands inline.
 */
function ResendInvitePanel({
  subscriptionStatus,
  state,
  onResend,
}: {
  subscriptionStatus: string;
  state: ResendInviteState;
  onResend: () => void;
}) {
  if (subscriptionStatus !== SubscriptionStatus.PENDING_PAYMENT) {
    return null;
  }

  return (
    <section className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <h2 className="text-sm font-semibold text-gray-900">Owner invite</h2>
      <p className="mt-1 text-sm text-gray-700">
        This owner has been invited but has not paid yet. Re-send the invite email if
        they never received it — the link lands them on the same password-setup flow
        as the original. Requires AAL2; capped at 3 sends per hour for this business.
      </p>
      <p className="mt-1 text-sm text-gray-700">
        If the owner has already signed in, the resend is refused — send them a
        password reset instead.
      </p>
      <button
        type="button"
        onClick={onResend}
        disabled={state.submitting}
        className="mt-3 rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state.submitting ? 'Sending…' : 'Resend invite'}
      </button>
      {state.message && (
        <p className="mt-3 text-sm font-medium text-emerald-700">{state.message}</p>
      )}
      {state.error && (
        <p className="mt-3 text-sm font-medium text-red-700">{state.error}</p>
      )}
    </section>
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
      <span className="whitespace-nowrap">{formatAdminDateTime(entry.createdAt)}</span>
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
        <span className="whitespace-nowrap">{formatAdminDateTime(entry.createdAt)}</span>
      ),
      sortValue: (entry) => entry.createdAt,
    },
  ];
}

interface BusinessDetailClientProps {
  businessId: string;
  initialDetail: DetailData;
  initialChannels: ChannelEnrollmentRow[];
  /**
   * The admin Halt latch projection (#865), read once on the server. It is NOT
   * a react-query resource: `invalidate()` already calls `router.refresh()`, so
   * a halt re-runs the server page and this prop arrives fresh — one read,
   * one owner, and no second client fetch of a support-only surface.
   */
  initialBatchSummary: AdminBatchSummary | null;
}

export function BusinessDetailClient({
  businessId,
  initialDetail,
  initialChannels,
  initialBatchSummary,
}: BusinessDetailClientProps) {
  const {
    data,
    isLoading,
    isError,
    error,
    enrollments,
    channelsLoading,
    channelsError,
    invalidate,
    clearBounceFlag,
    bounceFlagState,
    resendInvite,
    resendInviteState,
  } = useBusinessDetail(businessId, { initialDetail, initialChannels });

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

  // Only sections that render get a jump link — a link to nothing is worse
  // than no link.
  const availableSections = new Set<SectionId>(['profile', 'reviews', 'keywords', 'ranking', 'channels', 'zernio']);
  if (business.churnScore) availableSections.add('engagement');
  if (approvalAuditLog.length > 0 || accountAuditLog.length > 0) availableSections.add('audit');

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

      {/* Meta row — AdminPage owns the title, eyebrow and the breadcrumb back to
          the list (X28), so nothing here repeats the wayfinding. */}
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
        {business.churnScore && (
          <HealthBadge level={business.churnScore.level} score={business.churnScore.score} />
        )}
        <StatusBadge vocab="subscription" value={business.subscriptionStatus} />
        <StatusBadge vocab="tier" value={business.subscriptionTier} />
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
        <OwnerEmailBounceNotice
          ownerEmail={business.ownerEmail}
          state={bounceFlagState}
          onClear={() => {
            void clearBounceFlag();
          }}
        />
      )}

      {/* Account context — multi-location info (VAL-ADMIN-001) */}
      {account.locations.length > 1 && (
        <div className="mt-4 mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-gray-900">
              Account ({account.locations.length} locations)
            </h2>
            <StatusBadge vocab="tier" value={account.subscriptionTier} />
            <StatusBadge vocab="subscription" value={account.subscriptionStatus} />
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

      <ResendInvitePanel
        subscriptionStatus={account.subscriptionStatus}
        state={resendInviteState}
        onResend={() => {
          void resendInvite();
        }}
      />

      <PastDueExtensionPanel
        accountId={account.id}
        subscriptionStatus={account.subscriptionStatus}
        onGranted={invalidate}
      />

      <AutoApprovalDiagnosticsPanel diagnostics={autoApproval} />

      <SolicitationBatchPanel
        accountId={account.id}
        businessId={businessId}
        summary={initialBatchSummary}
        onHalted={invalidate}
      />

      <JumpLinks available={availableSections} />

      {/* Profile editor */}
      <div id="profile" className={ANCHOR_CLASS}>
        <ProfileEditor
          business={business}
          businessId={businessId}
          onSaved={invalidate}
        />
      </div>

      {/* Review list */}
      <div id="reviews" className={ANCHOR_CLASS}>
        <ReviewsList reviews={reviews} totalCount={reviewsTotal} />
      </div>

      {/* Engagement / churn risk — collapsed by default (X27): the badge in the
          meta row already carries the verdict; the breakdown is for a deep look. */}
      {business.churnScore && (
        <CollapsibleSection
          id="engagement"
          title="Engagement"
          aside={<HealthBadge level={business.churnScore.level} score={business.churnScore.score} />}
        >
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
        </CollapsibleSection>
      )}

      {/* Tracked Keywords — collapsed by default (X27) */}
      <CollapsibleSection
        id="keywords"
        title="Tracked Keywords"
        aside={<span className="text-xs text-gray-500">{business.trackedKeywords.length} of 5</span>}
      >
        <TrackedKeywordsSection businessId={businessId} keywords={business.trackedKeywords} />
      </CollapsibleSection>

      {/* Ranking — collapsed by default (X27) */}
      <CollapsibleSection id="ranking" title="Ranking">
        <ManualRankingSection businessId={businessId} snapshots={rankingSnapshots ?? []} />
      </CollapsibleSection>

      {/* Channels (table + flag-gated Telegram / WhatsApp enrollment) */}
      <div id="channels" className={ANCHOR_CLASS}>
        <ChannelsPanel
          business={business}
          businessId={businessId}
          enrollments={enrollments}
          channelsLoading={channelsLoading}
          channelsError={channelsError}
        />
      </div>

      {/* Zernio connection panel — auto-publishing state, queued reconnects, ops incidents */}
      <div id="zernio" className={ANCHOR_CLASS}>
        <ZernioConnectionPanel
          businessId={businessId}
          zernio={zernio}
          onChanged={invalidate}
        />
      </div>

      {/* Approval Audit Log (VAL-ADMIN-004) */}
      {approvalAuditLog.length > 0 && (
        <section id="audit" className={`mt-8 ${ANCHOR_CLASS}`}>
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
        <section id={approvalAuditLog.length > 0 ? undefined : 'audit'} className={`mt-8 ${ANCHOR_CLASS}`}>
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
