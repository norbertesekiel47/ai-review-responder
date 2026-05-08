'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon } from './Icon';

interface Props {
  title: string;
  subtitle?: string;
  /** When true, render the live-pill + auto-refresh + manual refresh button. */
  showLive?: boolean;
  /** Provided when showLive is true. Called every 60s and on manual click. */
  refresh?: () => void | Promise<void>;
  /** Right-side link instead of refresh (used on /past-replies and /settings). */
  rightLink?: { href: string; label: string };
}

export function TopBar({ title, subtitle, showLive, refresh, rightLink }: Props) {
  const [secondsToRefresh, setSecondsToRefresh] = useState(60);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const inflightRef = useRef(false);
  const spinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doRefresh = useCallback(async (silent = false) => {
    // In-flight guard: ignore overlapping requests so a slow /api/dashboard
    // can't double-fire when the 60s tick lands during a manual click.
    if (inflightRef.current) return;
    if (!refreshRef.current) return;
    inflightRef.current = true;
    setRefreshing(true);
    try {
      await refreshRef.current();
    } finally {
      inflightRef.current = false;
      // Match the design's spin duration regardless of API speed. Track the
      // timeout id so we can clear it on unmount and avoid setState-after-
      // unmount warnings.
      if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
      spinTimeoutRef.current = setTimeout(() => setRefreshing(false), 800);
      if (!silent) setSecondsToRefresh(60);
    }
  }, []);

  useEffect(() => {
    if (!showLive) return;
    const interval = setInterval(() => {
      setSecondsToRefresh((s) => {
        if (s <= 1) {
          void doRefresh(true);
          return 60;
        }
        return s - 1;
      });
    }, 1000);
    return () => {
      clearInterval(interval);
      if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
    };
  }, [showLive, doRefresh]);

  return (
    <div className="topbar">
      <div>
        <div className="page-title">{title}</div>
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </div>
      <div className="topbar-spacer" />
      {showLive && (
        <>
          <span className="live-pill">
            <span className="live-dot" />
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
  );
}
