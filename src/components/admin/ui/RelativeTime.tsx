'use client';

import { useSyncExternalStore } from 'react';
import { ADMIN_TIME_ZONE_LABEL, formatAdminDate, formatAdminDateTime } from './format';

/**
 * Relative timestamps ("3h ago") for admin lists — the "Last activity" column
 * on /admin/businesses and the At-risk rows on /admin/overview.
 *
 * WHY A STORE, NOT `Date.now()` IN RENDER (X29). These pages render on Vercel
 * and again in the browser. A relative label derived from `Date.now()` during
 * render is computed at two different instants, so the two renders can
 * disagree ("2m ago" vs "3m ago") and React logs a hydration mismatch. The
 * server has no "now" worth rendering — so `getServerSnapshot` returns `null`,
 * the server (and the hydrating client render, which React pins to the server
 * snapshot) prints the absolute UTC date instead, and the first client-owned
 * render swaps in the relative label. Deterministic by construction, the same
 * way `format.ts` pins zone and locale.
 *
 * The store also ticks once a minute so a page left open does not say "just
 * now" for an hour. `nowSnapshot` is refreshed on subscribe (React re-checks
 * the snapshot right after subscribing), so a component mounted long after
 * this module loaded starts from the current minute, not from module load.
 */
const TICK_MS = 60_000;

let nowSnapshot = Date.now();

function subscribe(onChange: () => void): () => void {
  nowSnapshot = Date.now();
  const id = setInterval(() => {
    nowSnapshot = Date.now();
    onChange();
  }, TICK_MS);
  return () => clearInterval(id);
}

const getSnapshot = (): number | null => nowSnapshot;
const getServerSnapshot = (): number | null => null;

/** Epoch ms captured after mount; `null` on the server and during hydration. */
function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Coarse "how long ago". Zone-free on purpose — a relative age needs no zone
 * label — and pure: `now` is a parameter, never read from the clock here.
 */
export function formatRelative(iso: string, now: number): string {
  const diffMs = now - new Date(iso).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

interface RelativeTimeProps {
  value: string | null | undefined;
  fallback?: string;
  className?: string;
}

export function RelativeTime({ value, fallback = '—', className }: RelativeTimeProps) {
  const now = useNow();
  if (!value || Number.isNaN(new Date(value).getTime())) {
    return <span className={className}>{fallback}</span>;
  }
  return (
    <time dateTime={new Date(value).toISOString()} title={formatAdminDateTime(value)} className={className}>
      {now === null ? `${formatAdminDate(value)} ${ADMIN_TIME_ZONE_LABEL}` : formatRelative(value, now)}
    </time>
  );
}
