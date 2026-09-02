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
import type {
  ArchivedLocationSummary,
  ArchivedPeriod,
  RefusalLogEntry,
} from '@/lib/refusals/read';
import { type DashboardWindow, DEFAULT_DASHBOARD_WINDOW } from '@/lib/kpi/types';

/**
 * DELIBERATELY NOT the state panel's `errorHeading`, which is the byte-identical
 * "Unable to load your restraint record". When the two matched, a network
 * failure rendered the same sentence twice — once as the card's h2 and once as
 * its body — which reads as a rendering bug rather than an explanation.
 */
const FETCH_FAILED_MESSAGE = 'We could not reach your restraint record just now. Try again in a moment.';

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

  // `scope` comes from the PAYLOAD, not from `currentScope`. The server decides
  // aggregate-vs-location (`resolveDashboardRequest`, itself gated on
  // `MULTI_LOCATION_ENABLED`), so a client that answered that question from its
  // own location context could render "this is your whole account" over a
  // single-location payload. `AnalyticsContent` takes the server's word the same
  // way, via `isAggregate(data)`.
  return (
    <RestraintReport
      log={query.data as RestraintPayload}
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
 * The parked version returned `boolean`, so the object guards that called it
 * narrowed nothing for that field — `category` stayed `unknown` and the
 * surrounding cast was doing the work unaided.
 *
 * FIXING ONLY THIS ONE WAS NOT ENOUGH, and a branch review caught it: the three
 * composite guards below were written returning `boolean` too, so
 * `.every(isRefusalEntry)` narrowed nothing and reintroduced the same defect one
 * level down. Every guard in this file now states what it proves.
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

function isRefusalEntry(value: unknown): value is RefusalLogEntry {
  return isObject(value)
    && typeof value.id === 'string'
    && isRefusalCategory(value.category)
    && typeof value.occurredAt === 'string'
    && isNullableString(value.subjectType)
    && isNullableString(value.subjectId)
    && isNullableString(value.reviewId)
    && isLinkKind(value.linkKind);
}

function isArchivedPeriod(value: unknown): value is ArchivedPeriod {
  return isObject(value)
    && typeof value.archivedAt === 'string'
    && isNullableString(value.reactivatedAt);
}

function isArchivedLocations(value: unknown): value is ArchivedLocationSummary | null {
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
    && typeof value.truncated === 'boolean'
    && typeof value.window === 'string'
    && (value.scope === 'account' || value.scope === 'location')
    && typeof value.autoApprovalEnabled === 'boolean'
    && typeof value.ledgerRecording === 'boolean';
}
