// src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx
//
// Print view for one location's Review QR (CONTEXT.md "Review QR"). Tenant
// scope is structural: the lookup happens INSIDE the caller's account list,
// so a foreign businessId is notFound(), never data. The @media print rule
// isolates the sheet from the surrounding Console chrome (sidebar, topbar)
// and sizes the QR to fill most of a portrait A4/Letter page.

import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { getOwnerReviewQrLocations } from '@/lib/locations/review-qr';
import { PrintButton } from '@/app/(authenticated)/settings/review-qr/PrintButton';

const PRINT_CSS = `
.review-qr-sheet {
  max-width: 560px;
  margin: 40px auto;
  padding: 32px;
  background: var(--rw-white);
  border: 1px solid var(--rw-app-border);
  border-radius: 12px;
  box-shadow: var(--rw-shadow-sm);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  text-align: center;
}
.review-qr-sheet h1 {
  font: var(--rw-app-h1);
  color: var(--rw-app-text);
  margin: 0;
}
.review-qr-sheet p {
  font: var(--rw-app-body);
  color: var(--rw-app-text-muted);
  margin: 0;
}
.review-qr-sheet img {
  width: min(320px, 80vw);
  height: auto;
}
@media print {
  body * { visibility: hidden; }
  .review-qr-sheet, .review-qr-sheet * { visibility: visible; }
  .review-qr-sheet {
    position: fixed;
    inset: 0;
    margin: 0;
    padding: 0;
    max-width: none;
    border: none;
    box-shadow: none;
    justify-content: center;
  }
  .review-qr-sheet img { width: 160mm; }
  .review-qr-sheet h1 { font-size: 28pt; }
  .review-qr-sheet p { font-size: 14pt; }
  .print-hide { display: none !important; }
}
`;

export default async function ReviewQrPrintPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const access = await requireOwnerAccess(sql);
  const locations = await getOwnerReviewQrLocations(
    sql,
    access.accountId,
    process.env.NEXT_PUBLIC_APP_URL ?? '',
  );
  const location = locations.find((entry) => entry.businessId === businessId);
  if (!location || location.qrDataUrl === null) notFound();
  return (
    <section className="review-qr-sheet">
      <style>{PRINT_CSS}</style>
      <h1>{location.displayName}</h1>
      <p>Scan to leave us a review</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL QR, no next/image optimization possible */}
      <img src={location.qrDataUrl} alt={`Review QR for ${location.displayName}`} />
      <PrintButton />
    </section>
  );
}
