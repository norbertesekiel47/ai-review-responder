'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AnalyticsTabs } from '@/components/dashboard/analytics/AnalyticsTabs';
import { PeriodToolbar } from '@/components/dashboard/analytics/PeriodToolbar';
import {
  RestraintReport,
  type RestraintPayload,
} from '@/components/dashboard/restraint/RestraintReport';
import { renderDashboardStatePanel } from '@/components/dashboard/shell/DashboardStatePanel';
import { useLocationScope, type LocationScope } from '@/contexts/LocationContext';
import { REFUSAL_CATEGORIES, type RefusalCategory } from '@/lib/refusals/vocabulary';
import { type DashboardWindow, DEFAULT_DASHBOARD_WINDOW } from '@/lib/kpi/types';

const FETCH_FAILED_MESSAGE = 'Unable to load your restraint record';

/**
 * `/dashboard/analytics/restraint` — the **Restraint tab**'s orchestrator.
 *
 * Fetches through `useQuery` (#1000 ST-1). `AgentTeamStrip` is the precedent for
 * the sibling endpoint; keying, staleness, abort and derived loading all come
 * free, and the hand-rolled versions the parked branch carried across ~50 lines
 * are deleted rather than ported.
 *
 * Every owner-facing sentence lives in `RestraintReport`, never here. This file
 * resolves scope and window, hands off, and does nothing else.
 */
export function RestraintContent() {
  const { currentScope } = useLocationScope();
  const [period, setPeriod] = useState<DashboardWindow>(DEFAULT_DASHBOARD_WINDOW);

  const query = useQuery({
    queryKey: ['dashboard-refusals', currentScope, period],
    queryFn: ({ signal }) => fetchRefusalLog(currentScope, period, signal),
  });

  const periodToolbar = <PeriodToolbar value={period} onChange={setPeriod} />;
  const tabs = <AnalyticsTabs active="restraint" />;

  const panel = renderDashboardStatePanel(
    'restraint',
    {
      loading: query.isPending,
      hasData: query.data != null,
      error: query.isError
        ? (query.error instanceof Error ? query.error.message : FETCH_FAILED_MESSAGE)
        : null,
    },
    periodToolbar,
    // The tab bar goes into the scaffold's own slot, so it survives loading and
    // error rather than appearing only once data lands (#1000 ST-2).
    tabs,
  );
  if (panel) return panel;

  return (
    <RestraintReport
      log={query.data as RestraintPayload}
      // 'all' IS the account view. Passed explicitly rather than derived from a
      // nullable field of the payload — see `RestraintReport`'s `scope` prop.
      scope={currentScope === 'all' ? 'account' : 'location'}
      tabs={tabs}
      periodToolbar={periodToolbar}
    />
  );
}

async function fetchRefusalLog(
  scope: LocationScope,
  window: DashboardWindow,
  signal: AbortSignal,
): Promise<RestraintPayload> {
  const params = new URLSearchParams();
  params.set('scope', scope);
  params.set('window', window);
  const response = await fetch(`/api/dashboard/refusals?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessageOf(body));
  if (!isRestraintPayload(body)) {
    throw new Error('Your restraint record came back incomplete');
  }
  return body;
}

// ── Validation ──────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessageOf(body: unknown): string {
  return isObject(body) && typeof body.error === 'string'
    ? body.error
    : FETCH_FAILED_MESSAGE;
}

/** The vocabulary's own closed set — never a re-spelled literal. */
const REFUSAL_CATEGORY_NAMES: ReadonlySet<string> = new Set(REFUSAL_CATEGORIES);

/**
 * A TYPE GUARD, not a `boolean` (#1000 ST-8).
 *
 * The parked version returned `boolean`, so the two object guards that called it
 * narrowed nothing for that field — `category` stayed `unknown` and the
 * surrounding `value is RefusalEntry` cast was doing the work unaided. One token
 * fixes it, and the fix is what makes the cast honest.
 */
function isRefusalCategory(value: unknown): value is RefusalCategory {
  return typeof value === 'string' && REFUSAL_CATEGORY_NAMES.has(value);
}

function isLinkKind(value: unknown): value is 'review' | 'auto-approval' | 'contacts' | null {
  return value === null || value === 'review' || value === 'auto-approval' || value === 'contacts';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRefusalEntry(value: unknown): boolean {
  return isObject(value)
    && typeof value.id === 'string'
    && isRefusalCategory(value.category)
    && typeof value.occurredAt === 'string'
    && isNullableString(value.subjectType)
    && isNullableString(value.subjectId)
    && isLinkKind(value.linkKind);
}

function isArchivedPeriod(value: unknown): boolean {
  return isObject(value)
    && typeof value.archivedAt === 'string'
    && isNullableString(value.reactivatedAt);
}

function isArchivedLocations(value: unknown): boolean {
  return value === null
    || (isObject(value)
      && typeof value.refusalCount === 'number'
      && typeof value.locationCount === 'number');
}

function isRestraintPayload(value: unknown): value is RestraintPayload {
  return isObject(value)
    && typeof value.total === 'number'
    && Array.isArray(value.entries)
    && value.entries.every(isRefusalEntry)
    && typeof value.windowStart === 'string'
    && typeof value.windowEnd === 'string'
    && isNullableString(value.coverageStart)
    && isArchivedLocations(value.archivedLocations)
    && Array.isArray(value.archivedPeriods)
    && value.archivedPeriods.every(isArchivedPeriod)
    && typeof value.window === 'string'
    && typeof value.autoApprovalEnabled === 'boolean';
}
