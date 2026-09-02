'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';
import { LocationPicker } from '@/components/dashboard/location/LocationPicker';
import { AccountMenu } from '@/components/dashboard/shell/AccountMenu';
import { useRefreshHeld } from '@/components/dashboard/shell/refresh-hold';
import { useLocationScope } from '@/contexts/LocationContext';

/** Background refresh cadence for every live list surface. */
const AUTO_REFRESH_INTERVAL_MS = 60_000;

interface Props {
  title: string;
  subtitle?: string;
  /** When true, render the live pill + auto-refresh + manual refresh button. */
  showLive?: boolean;
  /** Provided when showLive is true. Called every 60 s and on manual click. */
  refresh?: () => void | Promise<void>;
  /** True while the surface's data hook reports a background refresh in flight. */
  refreshing?: boolean;
  /** Right-side link instead of refresh (used on /past-replies and /settings). */
  rightLink?: { href: string; label: string; icon?: IconName };
  /** Business name fallback for single-location (from server). */
  businessName?: string;
  /** Right-aligned action slot (e.g. the analytics period toolbar, #403).
   *  Rendered left of the live-pill / refresh controls. */
  children?: ReactNode;
}

/**
 * The live pill's text. Static by design (UX audit D31): it changes on a
 * refresh, a hold, or a skipped tick — never once a second.
 */
export function liveStatusLabel(input: {
  held: boolean;
  refreshing: boolean;
  minutesSinceRefresh: number;
}): string {
  if (input.held) return 'Live · paused while you edit';
  if (input.refreshing) return 'Live · updating…';
  if (input.minutesSinceRefresh <= 0) return 'Live · updated just now';
  return `Live · updated ${input.minutesSinceRefresh} min ago`;
}

export function TopBar({
  title,
  subtitle,
  showLive,
  refresh,
  refreshing = false,
  rightLink,
  businessName,
  children,
}: Props) {
  const [spinning, setSpinning] = useState(false);
  // Whole minutes since the last refresh THIS bar drove. Only grows while a
  // hold skips ticks; the next refresh resets it.
  const [minutesSinceRefresh, setMinutesSinceRefresh] = useState(0);
  const refreshRef = useRef(refresh);
  const inflightRef = useRef(false);
  const spinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRefreshHeld();
  // Keep refreshRef current so the stable doRefresh (deps []) calls the latest
  // refresh prop. Assigned in an effect, not during render, per react-hooks/refs.
  useEffect(() => {
    refreshRef.current = refresh;
  });

  // Read from LocationContext — on mobile, TopBar shows the LocationPicker
  const { isMultiLocation } = useLocationScope();

  const doRefresh = useCallback(async () => {
    if (inflightRef.current) return;
    if (!refreshRef.current) return;
    inflightRef.current = true;
    setSpinning(true);
    try {
      await refreshRef.current();
      setMinutesSinceRefresh(0);
    } finally {
      inflightRef.current = false;
      if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
      spinTimeoutRef.current = setTimeout(() => setSpinning(false), 800);
    }
  }, []);

  // One tick a minute. While a row holds the refresh (an owner mid-edit, a
  // draft regenerating) the tick only ages the label; the data stays put.
  const onTick = useEffectEvent(() => {
    if (held) {
      setMinutesSinceRefresh((minutes) => minutes + 1);
      return;
    }
    void doRefresh();
  });

  useEffect(() => {
    if (!showLive) return;
    const interval = setInterval(() => onTick(), AUTO_REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
    };
  }, [showLive]);

  const isRefreshing = refreshing || spinning;

  return (
    <div className="topbar">
      <div className="topbar-heading">
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </div>
      {/* Mobile LocationPicker — rendered between title and spacer on mobile.
          On desktop (sidebar visible), this is hidden by CSS. */}
      {isMultiLocation && (
        <div className="topbar-loc-picker">
          <LocationPicker compact singleLocationLabel={businessName} />
        </div>
      )}
      {/* Below the shell breakpoint the sidebar is hidden, so this is the only
          reachable account control — and the only route to sign out. A direct
          child of `.topbar`, like the picker above it, so the mobile grid can
          place it on the heading row. Hidden by CSS on desktop, where the
          sidebar owns it. */}
      <div className="topbar-acct">
        <AccountMenu compact />
      </div>
      {(children || showLive || rightLink) && (
        <div className="topbar-controls">
          {children && <div className="topbar-actions">{children}</div>}
          {showLive && (
            <>
              <span className="live-pill" role="status">
                <span className="live-dot" aria-hidden="true" />
                {liveStatusLabel({ held, refreshing: isRefreshing, minutesSinceRefresh })}
              </span>
              <button
                type="button"
                className={`refresh-btn ${spinning ? 'spinning' : ''}`}
                onClick={() => void doRefresh()}
              >
                <span className="refresh-icon" style={{ display: 'inline-flex' }}>
                  <Icon name="refresh" size={14} />
                </span>
                Refresh
              </button>
            </>
          )}
          {rightLink && (
            <Link href={rightLink.href} className="refresh-btn">
              <Icon name={rightLink.icon ?? 'home'} size={14} /> {rightLink.label}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
