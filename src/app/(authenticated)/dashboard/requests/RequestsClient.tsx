'use client';

import { useEffect, useState } from 'react';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { useLocationScope } from '@/contexts/LocationContext';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type { BatchView } from '@/lib/solicitation/batch-view';
import { BatchReport } from './BatchReport';

/**
 * Client island for /dashboard/requests (#544): reads the latest Solicitation
 * batch for the selected location and hands the built one to BatchReport.
 *
 * Scope: this island currently renders the `built` state only. Every other
 * outcome — loading, error + retry, aggregate ("all locations"), `no_batch`,
 * `building` + bounded polling — plus the `reviewed_at` ping is Task 3 of the
 * #544 plan and lands next; the single seam is `view.state`.
 */
export function RequestsClient() {
  const { currentScope } = useLocationScope();
  const view = useLatestBatch(currentScope);

  return (
    <>
      <TopBar
        title="Requests"
        subtitle="What RepWorth would ask for — and everyone it held back, with the reason."
      />
      <div className="content">
        {view?.state === 'built' ? <BatchReport view={view} /> : null}
      </div>
    </>
  );
}

/** One fetch per location scope. A response for a superseded scope is dropped,
 *  never rendered against the location the owner switched to. */
function useLatestBatch(currentScope: string): BatchView | null {
  const [result, setResult] = useState<{ scope: string; view: BatchView } | null>(null);

  useEffect(() => {
    // Aggregate scope has no batch — the API rejects it with a 400, so it is
    // never fetched. Task 3 renders the "choose a location" copy.
    if (currentScope === 'all') return;

    let cancelled = false;
    void fetchLatestBatch(currentScope).then((view) => {
      if (!cancelled && view !== null) setResult({ scope: currentScope, view });
    });
    return () => {
      cancelled = true;
    };
  }, [currentScope]);

  return result?.scope === currentScope ? result.view : null;
}

/** Returns null on any failure. Reported, not swallowed — Task 3 replaces the
 *  console report with the owner-facing error state and its retry. */
async function fetchLatestBatch(scope: string): Promise<BatchView | null> {
  try {
    const response = await fetch(
      withSolicitationScope('/api/dashboard/solicitation/batch', scope),
    );
    if (!response.ok) {
      console.error(`[requests] batch fetch failed with ${response.status}`);
      return null;
    }
    return (await response.json()) as BatchView;
  } catch (error) {
    console.error('[requests] batch fetch could not reach the server', error);
    return null;
  }
}
