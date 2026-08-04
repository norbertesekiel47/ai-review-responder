import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { asLocationId } from '@/lib/shared/ids';
import { getBusinessDetail } from '@/lib/admin/business-detail-service';
import { getBusinessChannelEnrollments } from '@/lib/admin/business-channels-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { BusinessDetailClient } from './BusinessDetailClient';
import type { DetailData } from './types';

export const dynamic = 'force-dynamic';

export default async function AdminBusinessDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const businessId = asLocationId(id);

  // Gate parity with GET /api/admin/businesses/[id] — plain admin role, no AAL2.
  // `from` is the static route shape, not raw input (page-gate contract).
  await requireAdminPage(sql, { from: '/admin/businesses' });

  // Concurrent, not serialized — these are the same two reads the client used to
  // fire as parallel react-query calls after hydration.
  const [detail, channels] = await Promise.all([
    getBusinessDetail(sql, businessId),
    getBusinessChannelEnrollments(sql, businessId),
  ]);

  // A missing business now renders the Next.js 404 instead of a full-screen
  // "Failed to load business" — intended (spec §6).
  if (!detail) notFound();

  return (
    <AdminPage
      group="Businesses"
      title={detail.business.name}
      description={detail.business.category ?? undefined}
    >
      <BusinessDetailClient
        businessId={id}
        // `DetailData` is the page-level UI shape: structurally the API response,
        // but with tone/ownerName/ownerEmail declared non-nullable and churnScore
        // optional. The client has always asserted exactly this on the fetch
        // (`res.json() as Promise<DetailData>`); asserting it once here at the
        // server seam keeps the rendered object byte-identical to the fetched one.
        initialDetail={detail as unknown as DetailData}
        initialChannels={channels.enrollments}
      />
    </AdminPage>
  );
}
