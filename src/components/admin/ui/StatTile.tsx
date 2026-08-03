import type { ReactNode } from 'react';

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Red-border variant for breached thresholds (spec §3). */
  alert?: boolean;
}

export function StatTile({ label, value, sub, alert = false }: StatTileProps) {
  return (
    <div
      className={`rounded-md border bg-white px-3 py-2 ${
        alert ? 'border-red-300 bg-red-50' : 'border-gray-200'
      }`}
    >
      <div
        className={`text-[10px] font-medium uppercase tracking-wide ${alert ? 'text-red-700' : 'text-gray-500'}`}
      >
        {label}
      </div>
      <div className={`text-lg font-bold ${alert ? 'text-red-700' : 'text-gray-900'}`}>
        {value}
      </div>
      {sub != null && (
        <div className={`text-xs ${alert ? 'text-red-600' : 'text-gray-500'}`}>{sub}</div>
      )}
    </div>
  );
}
