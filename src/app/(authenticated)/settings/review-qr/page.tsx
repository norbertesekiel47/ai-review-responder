// src/app/(authenticated)/settings/review-qr/page.tsx
//
// The **Review QR** surface moved under Requests (#1092, map #1084). This path
// is kept as a permanent redirect rather than deleted: an owner may have
// bookmarked it, and a 404 on a page that worked yesterday reads as data loss.
//
// NOT to be confused with the **QR redirect** `GET /q/<businessId>`, which is
// the PUBLIC hop printed codes point at. That one never moves.

import { redirect } from 'next/navigation';

export default function MovedReviewQrPage(): never {
  redirect('/dashboard/requests/qr');
}
