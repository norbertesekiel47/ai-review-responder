import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { OperatorClient } from './OperatorClient';
import { OPERATOR_TITLE, PREPARING } from './wording';

export const dynamic = 'force-dynamic';

/**
 * /dashboard/operator — the Owner Operator screen. Server component so the flag gate
 * stays server-authoritative (invariant #13, mirroring
 * `src/app/(authenticated)/dashboard/requests/page.tsx:13-16`): with the flag off this surface does not
 * exist, and the browser is told nothing.
 *
 * `notFound()` is called in the RENDER PATH, which is what makes it work — a
 * call left in an un-awaited promise throws where nothing catches it and no
 * not-found UI renders (Next 16, `04-functions/not-found.md`).
 *
 * The `<Suspense>` boundary is not decoration: `OperatorClient` calls
 * `useSearchParams`, and without a boundary the client tree up to the closest
 * one is client-rendered — for a page with no boundary at all, the whole route
 * (Next 16, `04-functions/use-search-params.md`; the same reason
 * `src/app/(authenticated)/dashboard/connect/page.tsx:37-50` has one).
 */
export default function OperatorPage() {
  if (!ownerOperatorEnabled()) notFound();
  return (
    <Suspense
      fallback={(
        <div className="content op-surface">
          <h1 className="page-title">{OPERATOR_TITLE}</h1>
          <p className="page-sub">{PREPARING}</p>
        </div>
      )}
    >
      <OperatorClient />
    </Suspense>
  );
}
