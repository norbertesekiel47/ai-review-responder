import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { asLocationId } from '@/lib/shared/ids';
import { getBusinessDetail } from '@/lib/admin/business-detail-service';
import { getBusinessChannelEnrollments } from '@/lib/admin/business-channels-service';
import { readAdminBatchSummary } from '@/lib/solicitation/batch-view';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { BusinessDetailClient } from './BusinessDetailClient';

export const dynamic = 'force-dynamic';

/**
 * `?invited=1` is set by NewBusinessClient's redirect after a successful
 * onboarding (X11). A flag, not the address: the owner email is already in the
 * detail read, and an admin URL should not carry a customer's address into
 * browser history and access logs.
 */
const INVITED_FLAG = '1';

export default async function AdminBusinessDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const businessId = asLocationId(id);
  const invited = (await searchParams).invited === INVITED_FLAG;

  // Gate parity with GET /api/admin/businesses/[id], which uses
  // requireAdminWithAal2 — this page was deliberately plain admin until #1184
  // folded that GET onto the step-up gate, so the AAL2 here is the parity
  // following its anchor, not drift.
  // `from` is the static route shape, not raw input (page-gate contract).
  await requireAdminPage(sql, { from: '/admin/businesses', aal2: true });

  // SEQUENTIAL — do NOT re-introduce a Promise.all here. `getBusinessDetail` is
  // itself a 13-query chain that sequences deliberately (see
  // business-detail/queries.ts, which says so twice in the imperative), and
  // racing it against the channel read put two chains in flight against a
  // 3-connection pool — the fan-out width #773 measured wedging a pool of 3.
  // Mirrors admin/costs/page.tsx and admin/overview/page.tsx.
  const detail = await getBusinessDetail(sql, businessId);
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the awaits ARE independent; that is the point. Parallelising them is the #773 fan-out this change removes, not an optimisation.
  const channels = await getBusinessChannelEnrollments(sql, businessId);

  // A missing business now renders the Next.js 404 instead of a full-screen
  // "Failed to load business" — intended (spec §6).
  if (!detail) notFound();

  // The THIRD sql-backed read on this page (#865) — and the one most tempting to
  // race, because it is genuinely independent of the other two. It stays
  // SEQUENTIAL for the reason above: independence is what makes it a fan-out,
  // not what makes it safe. It is placed after the notFound() because it needs
  // the account id the detail read resolved.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- same #773 reasoning as the channel read above; do NOT fold these into a Promise.all.
  const batchSummary = await readAdminBatchSummary(sql, detail.account.id, businessId);

  return (
    <AdminPage
      group="Businesses"
      parent={{ href: '/admin/businesses', label: 'All businesses' }}
      title={detail.business.name}
      description={detail.business.category ?? undefined}
    >
      {invited && (
        <p
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
        >
          <span>
            Business created. Invite email sent to{' '}
            <strong className="font-semibold">{detail.business.ownerEmail}</strong> — the owner sets a
            password, captures their location and picks a plan from there.
          </span>
          <Link href={`/admin/businesses/${id}`} className="font-medium underline hover:text-green-900">
            Dismiss
          </Link>
        </p>
      )}
      <BusinessDetailClient
        businessId={id}
        // No cast. `DetailData` is now DERIVED from the API contract and widens
        // only `churnScore` to optional, so `BusinessDetailResponse` is
        // assignable to it and every field — including `churnScore.level`,
        // which the shared HealthBadge keys on — is CHECKED at this seam. The
        // former `as unknown as DetailData` narrowed three nullable columns to
        // `string` and, in erasing the check, let the detail page carry its own
        // loosely-typed health badge (Pathfinder §A1). Don't put it back.
        initialDetail={detail}
        initialChannels={channels.enrollments}
        initialBatchSummary={batchSummary}
      />
    </AdminPage>
  );
}
