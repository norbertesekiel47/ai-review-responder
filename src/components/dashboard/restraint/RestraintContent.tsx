'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { AnalyticsTabs } from '@/components/dashboard/analytics/AnalyticsTabs';
import { PeriodToolbar } from '@/components/dashboard/analytics/PeriodToolbar';
import { SubscriptionUnavailableCard } from '@/components/dashboard/shell/SubscriptionUnavailableCard';
import { RestraintReport } from '@/components/dashboard/restraint/RestraintReport';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocationScope, type LocationScope } from '@/contexts/LocationContext';
import { isAggregate, perLocationActive } from '@/lib/dashboard/scope';
import {
  REFUSAL_CATEGORY_META,
  REFUSAL_SOURCES,
} from '@/lib/refusals/vocabulary';
import type { RefusalCategoryGroup, RefusalEntry, RefusalLog } from '@/lib/refusals/read';
import {
  type DashboardWindow,
  DEFAULT_DASHBOARD_WINDOW,
} from '@/lib/kpi/types';

/**
 * `/dashboard/analytics/restraint` — the **Restraint tab**'s orchestrator.
 *
 * THIS IS `AnalyticsContent` WITH ONE PAYLOAD SWAPPED. Same `useLocationScope`,
 * same lifted `period` (so the selection survives the loading/error/data branch
 * swap and the control stays usable mid-refetch, #403), same `PeriodToolbar` in
 * the `TopBar` action slot, same `SubscriptionUnavailableCard` branch. Fetching,
 * the window control and the scope live HERE; the screen below is pure
 * presentation over one object.
 *
 * TWO READS, ON PURPOSE. `/api/dashboard/refusals` answers "what did we hold
 * back" and nothing else — it carries no subscription field, and widening it to
 * carry one would put an entitlement decision in a log endpoint. The
 * subscription gate therefore comes from the shared `/api/dashboard` payload,
 * exactly as it does on Analytics and Reviews, and `perLocationActive` stays its
 * single owner. See deviations D16.
 *
 * IT RENDERS ITS OWN LOADING AND ERROR SCAFFOLD rather than calling
 * `renderDashboardStatePanel`: that helper emits a `TopBar` immediately followed
 * by the content box, leaving nowhere between the two for the routed tab bar,
 * and `DashboardSurface` has no `'restraint'` member (its file is outside this
 * feature's edit surface). Same classes, same shape — see deviations D10.
 */
export function RestraintContent() {
  const { currentScope } = useLocationScope();
  const [period, setPeriod] = useState<DashboardWindow>(DEFAULT_DASHBOARD_WINDOW);
  const { data, error, loading } = useDashboardData(currentScope, { window: period });
  const refusals = useRefusalLog(currentScope, period);

  const periodToolbar = <PeriodToolbar value={period} onChange={setPeriod} />;

  // Loading takes precedence over a stale error while data is absent — the same
  // precedence `renderDashboardStatePanel` applies.
  if (loading || error !== null || data === null) {
    const showError = !loading && data !== null && error !== null;
    return (
      <RestraintShell periodToolbar={periodToolbar}>
        {showError ? <RestraintError message={error} /> : <RestraintLoading />}
      </RestraintShell>
    );
  }

  // Invariant #11: entitlement is `perLocationActive`'s call, never a raw status
  // comparison here. The aggregate payload carries no per-location subscription,
  // so it passes through — as it does on every other dashboard read surface.
  if (!isAggregate(data) && perLocationActive(data) === null) {
    return (
      <SubscriptionUnavailableCard
        topBarTitle="Restraint"
        heading="Your restraint log isn't available right now"
        body="Your account needs an active subscription to see what we held back."
      />
    );
  }

  return (
    <RestraintShell periodToolbar={periodToolbar}>
      {refusals.loading && <RestraintLoading />}
      {!refusals.loading && refusals.error !== null && (
        <RestraintError message={refusals.error} />
      )}
      {!refusals.loading && refusals.log !== null && (
        <>
          <LiveRegion message="Restraint log ready." />
          <RestraintReport log={refusals.log} period={period} />
        </>
      )}
    </RestraintShell>
  );
}

/** TopBar + routed tab bar + the body column, shared by every branch so the
 *  tabs and the period control never disappear mid-load. */
function RestraintShell({
  periodToolbar,
  children,
}: {
  periodToolbar: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <TopBar
        title="Restraint"
        subtitle="What we chose not to do for you, and why."
      >
        {periodToolbar}
      </TopBar>
      <div className="content content--analytics">
        {/* First child of the content box, not a capped subnav row: the
            analytics canvas is full-bleed, so a capped row would leave the tabs
            inset from every card below them. */}
        <AnalyticsTabs active="restraint" />
        <div className="rst-stack">{children}</div>
      </div>
    </>
  );
}

function RestraintLoading() {
  return (
    <>
      <LiveRegion message="Loading your restraint log…" />
      <div className="dashboard-skeleton">
        <div className="skeleton-card-lg" />
      </div>
    </>
  );
}

function RestraintError({ message }: { message: string }) {
  return (
    <>
      <LiveRegion message={message} level="assertive" />
      <div className="card">
        <h2 className="card-h2">Unable to load your restraint log</h2>
        <p className="rst-error-body">{message}</p>
      </div>
    </>
  );
}

// ── The read ────────────────────────────────────────────────────────────────

const FETCH_FAILED_MESSAGE = 'Unable to load your restraint log';
const INCOMPLETE_MESSAGE = 'Your restraint log came back incomplete';

interface RefusalLogState {
  log: RefusalLog | null;
  error: string | null;
  loading: boolean;
}

/** What one settled fetch produced, stamped with the (scope, window) it was
 *  fetched FOR. The stamp is what makes the reset below a derivation. */
interface SettledRefusalLog {
  scope: LocationScope;
  period: DashboardWindow;
  log: RefusalLog | null;
  error: string | null;
}

/**
 * One `RefusalLog` for one scope and one window.
 *
 * `period` rather than `window`, deliberately: a parameter named `window` in a
 * browser module shadows the global for the whole function body.
 *
 * THE RESULT IS KEYED BY WHAT IT WAS FETCHED FOR, and "loading" is DERIVED from
 * that key rather than written by the effect — the rule `useDashboardData`
 * already follows. Clearing the state at the top of the effect would be a
 * synchronous `setState` inside an effect body: a cascading render, and a lint
 * error (`react-hooks/set-state-in-effect`). Comparing the stamp instead means
 * a scope or window change reads as loading in the SAME render that changed it,
 * with no stale log ever visible under a new heading.
 */
function useRefusalLog(
  scope: LocationScope,
  period: DashboardWindow,
): RefusalLogState {
  const [settled, setSettled] = useState<SettledRefusalLog | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const params = new URLSearchParams({ scope, window: period });
        const response = await fetch(
          `/api/dashboard/refusals?${params.toString()}`,
          { headers: { Accept: 'application/json' }, signal: controller.signal },
        );
        const body: unknown = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(errorMessageOf(body));
        // A body this guard rejects is a FAULT, not an empty log: the same rule
        // the vocabulary applies to an unrecognised code. Rendering a
        // half-understood payload would show the owner a total it cannot back.
        if (!isRefusalLog(body)) throw new Error(INCOMPLETE_MESSAGE);
        setSettled({
          scope,
          period,
          // Only the two fields the screen reads. The route replies
          // `{ window, ...log }`, and carrying its `window` into the view would
          // give the period two owners.
          log: { total: body.total, categories: body.categories },
          error: null,
        });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setSettled({
          scope,
          period,
          log: null,
          error: cause instanceof Error ? cause.message : FETCH_FAILED_MESSAGE,
        });
      }
    })();

    return () => controller.abort();
  }, [scope, period]);

  const fresh = settled !== null && settled.scope === scope && settled.period === period
    ? settled
    : null;

  return {
    log: fresh?.log ?? null,
    error: fresh?.error ?? null,
    loading: fresh === null,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessageOf(body: unknown): string {
  return isObject(body) && typeof body.error === 'string'
    ? body.error
    : FETCH_FAILED_MESSAGE;
}

/** Membership tests against the vocabulary's own closed sets — never a
 *  re-spelled literal, and never a widening cast. */
const REFUSAL_SOURCE_NAMES: ReadonlySet<string> = new Set(REFUSAL_SOURCES);

function isRefusalCategory(value: unknown): boolean {
  return typeof value === 'string'
    && Object.hasOwn(REFUSAL_CATEGORY_META, value);
}

function isRefusalEntry(value: unknown): value is RefusalEntry {
  return isObject(value)
    && typeof value.id === 'string'
    && typeof value.source === 'string'
    && REFUSAL_SOURCE_NAMES.has(value.source)
    && isRefusalCategory(value.category)
    && typeof value.occurredAt === 'string'
    && (value.reviewId === null || typeof value.reviewId === 'string');
}

function isRefusalCategoryGroup(value: unknown): value is RefusalCategoryGroup {
  return isObject(value)
    && isRefusalCategory(value.category)
    && typeof value.count === 'number'
    && Array.isArray(value.entries)
    && value.entries.every(isRefusalEntry);
}

function isRefusalLog(value: unknown): value is RefusalLog {
  return isObject(value)
    && typeof value.total === 'number'
    && Array.isArray(value.categories)
    && value.categories.every(isRefusalCategoryGroup);
}
