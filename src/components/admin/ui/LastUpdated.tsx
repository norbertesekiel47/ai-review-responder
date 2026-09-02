'use client';

import { formatAdminTime } from './format';

interface LastUpdatedProps {
  /** react-query's `dataUpdatedAt` — epoch ms, `0` before the first success. */
  updatedAt: number;
  /** react-query's `isFetching` — true during the background poll too. */
  refreshing: boolean;
  /** Calls the query's `refetch`. */
  onRefresh: () => void;
}

/**
 * Live-data provenance for every polling admin page (X6).
 *
 * The pages poll every 30 s and keep the last good payload on screen when a
 * refetch fails, which is the right posture — but it means the operator can
 * be looking at stale numbers with nothing on screen saying so. This line makes
 * the age of the data a fact on the page rather than an assumption, and gives
 * the operator a refresh that does not depend on the next tick.
 *
 * Seconds are deliberate: consecutive refreshes differ only in seconds, so a
 * stalled poll is invisible at minute precision. `formatAdminTime` pins UTC and
 * `en-US` so the server and client renders match byte-for-byte (CF-1).
 *
 * A `0` `updatedAt` means "no successful load yet" — react-query's sentinel,
 * not the Unix epoch — and renders as such rather than as `00:00:00 UTC`.
 */
export function LastUpdated({ updatedAt, refreshing, onRefresh }: LastUpdatedProps) {
  const loaded = updatedAt > 0;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
      {loaded ? (
        <span>
          Updated{' '}
          <time dateTime={new Date(updatedAt).toISOString()} className="tabular-nums text-gray-700">
            {formatAdminTime(updatedAt)}
          </time>
        </span>
      ) : (
        <span>Not loaded yet</span>
      )}
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-busy={refreshing || undefined}
        className="rounded font-medium text-gray-700 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-1 disabled:cursor-progress disabled:no-underline disabled:opacity-60"
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}
