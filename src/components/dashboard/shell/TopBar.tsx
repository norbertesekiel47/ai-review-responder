'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/dashboard/shell/Icon';
import { LocationPicker } from '@/components/dashboard/location/LocationPicker';
import { useLocationScope } from '@/contexts/LocationContext';

interface Props {
  title: string;
  subtitle?: string;
  /** When true, render the live-pill + auto-refresh + manual refresh button. */
  showLive?: boolean;
  /** Provided when showLive is true. Called every 60s and on manual click. */
  refresh?: () => void | Promise<void>;
  /** Right-side link instead of refresh (used on /past-replies and /settings). */
  rightLink?: { href: string; label: string };
  /** Business name fallback for single-location (from server). */
  businessName?: string;
  /** Right-aligned action slot (e.g. the analytics period toolbar, #403).
   *  Rendered left of the live-pill / refresh controls. */
  children?: ReactNode;
}

export function TopBar({
  title,
  subtitle,
  showLive,
  refresh,
  rightLink,
  businessName,
  children,
}: Props) {
  const [secondsToRefresh, setSecondsToRefresh] = useState(60);
  const [refreshing, setRefreshing] = useState(false);
  const secondsToRefreshRef = useRef(60);
  const refreshRef = useRef(refresh);
  const inflightRef = useRef(false);
  const spinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep refreshRef current so the stable doRefresh (deps []) calls the latest
  // refresh prop. Assigned in an effect, not during render, per react-hooks/refs.
  useEffect(() => {
    refreshRef.current = refresh;
  });

  // Read from LocationContext — on mobile, TopBar shows the LocationPicker
  const { isMultiLocation } = useLocationScope();

  const doRefresh = useCallback(async (silent = false) => {
    if (inflightRef.current) return;
    if (!refreshRef.current) return;
    inflightRef.current = true;
    setRefreshing(true);
    try {
      await refreshRef.current();
    } finally {
      inflightRef.current = false;
      if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
      spinTimeoutRef.current = setTimeout(() => setRefreshing(false), 800);
      if (!silent) {
        secondsToRefreshRef.current = 60;
        setSecondsToRefresh(60);
      }
    }
  }, []);

  const onTick = useEffectEvent(() => {
    const shouldRefresh = secondsToRefreshRef.current <= 1;
    const nextSeconds = shouldRefresh ? 60 : secondsToRefreshRef.current - 1;
    secondsToRefreshRef.current = nextSeconds;
    setSecondsToRefresh(nextSeconds);
    if (shouldRefresh) void doRefresh(true);
  });

  useEffect(() => {
    if (!showLive) return;
    const interval = setInterval(() => onTick(), 1000);
    return () => {
      clearInterval(interval);
      if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
    };
  }, [showLive]);

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
      {(children || showLive || rightLink) && (
        <div className="topbar-controls">
          {children && <div className="topbar-actions">{children}</div>}
          {showLive && (
            <>
              <span className="live-pill">
                <span className="live-dot" aria-hidden="true" />
                Live · syncs in {secondsToRefresh}s
              </span>
              <button
                type="button"
                className={`refresh-btn ${refreshing ? 'spinning' : ''}`}
                onClick={() => void doRefresh(false)}
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
              <Icon name="home" size={14} /> {rightLink.label}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
