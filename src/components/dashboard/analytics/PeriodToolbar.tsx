'use client';

import {
  type DashboardWindow,
  DASHBOARD_WINDOWS,
} from '@/lib/kpi/types';

interface Props {
  /** The currently selected analytics time-range window. */
  value: DashboardWindow;
  /** Fired with the new window when the owner picks a different range. */
  onChange: (window: DashboardWindow) => void;
}

/** Human labels for the canonical window set (#403). */
const WINDOW_LABELS: Record<DashboardWindow, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '12w': '12 weeks',
};

/**
 * Console segmented control for the analytics time-range (#403). Reuses the
 * Console `.tabs`/`.tab` pill styling via the `.period-*` classes. Selecting a
 * range calls `onChange`; the parent owns the state and refetch.
 */
export function PeriodToolbar({ value, onChange }: Props) {
  return (
    <div className="period-toolbar" role="group" aria-label="Analytics time range">
      {DASHBOARD_WINDOWS.map((window) => {
        const active = window === value;
        return (
          <button
            key={window}
            type="button"
            className={`period-tab${active ? ' active' : ''}`}
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(window);
            }}
          >
            {WINDOW_LABELS[window]}
          </button>
        );
      })}
    </div>
  );
}
