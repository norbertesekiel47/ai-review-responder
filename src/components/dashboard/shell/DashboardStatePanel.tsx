'use client';

import type { ReactNode } from 'react';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';

/** Dashboard read surfaces that share the loading/error scaffold. */
export type DashboardSurface = 'analytics' | 'reviews' | 'restraint';

interface SurfaceCopy {
  title: string;
  /** Content wrapper class (e.g. "content" or "content content--analytics"). */
  contentClassName: string;
  loadingMessage: string;
  errorHeading: string;
  /** Number of large skeleton cards shown while loading. */
  skeletonCount: number;
}

// Single owner of the per-surface loading/error copy (one table instead of a
// config object duplicated at each call site).
const SURFACE_STATE_COPY: Record<DashboardSurface, SurfaceCopy> = {
  analytics: {
    title: 'Analytics',
    contentClassName: 'content content--analytics',
    loadingMessage: 'Loading your analytics…',
    errorHeading: 'Unable to load analytics',
    skeletonCount: 2,
  },
  reviews: {
    title: 'Reviews',
    contentClassName: 'content',
    loadingMessage: 'Loading your reviews…',
    errorHeading: 'Unable to load reviews',
    skeletonCount: 1,
  },
  // The title is 'Analytics', not 'Restraint'. The tab bar names the sub-route;
  // the TopBar names the surface. Two headings competing for the same fact is
  // the inconsistency this slot exists to remove.
  restraint: {
    title: 'Analytics',
    contentClassName: 'content content--analytics',
    loadingMessage: 'Loading what we held back…',
    errorHeading: 'Unable to load your restraint record',
    skeletonCount: 2,
  },
};

interface FetchState {
  loading: boolean;
  hasData: boolean;
  error: string | null;
}

/**
 * Render the shared loading/error scaffold for a dashboard read surface, or null
 * when data is ready (the caller then renders its own data UI). One owner of the
 * TopBar + content wrapper + LiveRegion + error-card markup the analytics and
 * reviews orchestrators previously duplicated. `topBarActions` keeps a surface's
 * controls (e.g. the analytics period toolbar, #403) visible through every branch.
 */
export function renderDashboardStatePanel(
  surface: DashboardSurface,
  state: FetchState,
  topBarActions?: ReactNode,
  /**
   * Rendered inside the content wrapper, ABOVE the skeleton or error card.
   * The Analytics routes pass their tab bar here so it survives every branch —
   * without it the bar vanishes during load on one route and persists on the
   * other, which is exactly the inconsistency #1000 ST-2 reported.
   */
  beforeContent?: ReactNode,
): ReactNode | null {
  if (!state.loading && state.hasData && !state.error) return null;

  const copy = SURFACE_STATE_COPY[surface];
  // Loading takes precedence while a request is in flight. Once it is NOT, an
  // error is the whole truth — including on a first load, where `hasData` is
  // false precisely BECAUSE the fetch failed. Gating on `hasData` here left the
  // owner watching a skeleton that would never resolve.
  const showError = !state.loading && state.error != null;

  return (
    <>
      <TopBar title={copy.title}>{topBarActions}</TopBar>
      <div className={copy.contentClassName}>
        {beforeContent}
        {showError ? (
          <>
            <LiveRegion message={state.error ?? ''} level="assertive" />
            <div className="card">
              <h2 className="card-h2">{copy.errorHeading}</h2>
              <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 4 }}>{state.error}</p>
            </div>
          </>
        ) : (
          <>
            <LiveRegion message={copy.loadingMessage} />
            <div className="dashboard-skeleton">
              {Array.from({ length: copy.skeletonCount }, (_, index) => (
                <div key={index} className="skeleton-card-lg" />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
