'use client';

import type { ReactNode } from 'react';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';

/** Dashboard read surfaces that share the loading/error scaffold. */
export type DashboardSurface = 'analytics' | 'reviews';

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
): ReactNode | null {
  if (!state.loading && state.hasData && !state.error) return null;

  const copy = SURFACE_STATE_COPY[surface];
  // Loading takes precedence over a stale error while data is absent.
  const showError = !state.loading && state.hasData && state.error != null;

  return (
    <>
      <TopBar title={copy.title}>{topBarActions}</TopBar>
      <div className={copy.contentClassName}>
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
