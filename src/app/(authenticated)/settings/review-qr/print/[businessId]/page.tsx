// src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx
//
// The printable **Review QR** view moved under Requests with its parent
// (#1092). This path redirects for the same reason the parent does — an owner
// may have bookmarked or printed from it — and it is a SEPARATE file because
// Next.js has no catch-all under `settings/` to inherit the parent's redirect.
//
// NOT the **QR redirect**: that is the public `GET /q/<businessId>` hop printed
// codes point at, and it never moves.

import { redirect } from 'next/navigation';

export default async function MovedReviewQrPrintPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}): Promise<never> {
  const { businessId } = await params;
  redirect(`/dashboard/requests/qr/print/${businessId}`);
}
