import Link from 'next/link';
import type { ReactNode } from 'react';

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Red-border variant for breached thresholds (spec §3). */
  alert?: boolean;
  /**
   * Makes the whole tile a link to the page that resolves it. Replaced the
   * Overview "Needs attention" strip (X13): the tile that goes red IS the alert,
   * so it is also the way to the work — no second list restating it.
   */
  href?: string;
}

export function StatTile({ label, value, sub, alert = false, href }: StatTileProps) {
  const frame = `block rounded-md border bg-white px-3 py-2 ${
    alert ? 'border-red-300 bg-red-50' : 'border-gray-200'
  }`;
  const body = (
    <>
      <div
        // 11px / gray-600 (not 10px / gray-500) — the same contrast fix as the
        // DataTable header (X31).
        className={`text-[11px] font-medium uppercase tracking-wide ${alert ? 'text-red-700' : 'text-gray-600'}`}
      >
        {label}
      </div>
      <div className={`text-lg font-bold ${alert ? 'text-red-700' : 'text-gray-900'}`}>
        {value}
      </div>
      {sub != null && (
        <div className={`text-xs ${alert ? 'text-red-600' : 'text-gray-500'}`}>{sub}</div>
      )}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={`${frame} transition-colors hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-1 ${
          alert ? 'hover:bg-red-100' : 'hover:bg-gray-50'
        }`}
      >
        {body}
      </Link>
    );
  }
  return <div className={frame}>{body}</div>;
}
