import { notFound } from 'next/navigation';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { RequestsClient } from './RequestsClient';

export const dynamic = 'force-dynamic';

/**
 * /dashboard/requests — the latest Solicitation batch for the selected
 * location (#544). Server component so the flag gate stays server-authoritative
 * (invariant #13, mirrors contacts/page.tsx and the batch API route): with
 * watch-mode off this surface does not exist, and the browser is told nothing.
 */
export default function RequestsPage() {
  if (!solicitationWatchEnabled()) notFound();
  return <RequestsClient />;
}
