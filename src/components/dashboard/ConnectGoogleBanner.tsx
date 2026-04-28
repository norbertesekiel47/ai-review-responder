'use client';

import Link from 'next/link';
import type { DashboardDataActive } from '@/lib/dashboard/types';

interface Props {
  zernio: DashboardDataActive['zernioConnection'];
}

/**
 * Surfaces the owner's Google publishing connection state at the top of the
 * dashboard. State matrix (per spec §3.4):
 *   - active                       → render nothing (everything is fine)
 *   - finalize_unknown             → yellow "manual review" banner; ops is on it
 *   - none                         → blue "connect to start auto-posting" banner
 *   - pending + pendingFlow set    → blue "Connecting…" banner (in-flight)
 *   - pending (no marker) | disconnected → orange "reconnect" banner
 *
 * The pending+pendingFlow branch distinguishes an in-flight OAuth/finalize
 * window from a stale `pending` DB row that means "owner abandoned the
 * flow." The first should NOT show the alarming orange "Reconnect" CTA.
 */
export function ConnectGoogleBanner({ zernio }: Props) {
  if (zernio.status === 'active') return null;

  if (zernio.status === 'finalize_unknown') {
    return (
      <div className="mb-6 rounded-lg border border-yellow-300 bg-yellow-50 p-4">
        <p className="font-semibold text-yellow-900">
          Connection requires manual review
        </p>
        <p className="mt-1 text-sm text-yellow-800">
          We&apos;ve notified our support team — they&apos;ll have this
          resolved within 24 hours. You don&apos;t need to do anything.
        </p>
      </div>
    );
  }

  if (zernio.status === 'none') {
    return (
      <div className="mb-6 flex items-center justify-between rounded-lg border border-blue-300 bg-blue-50 p-4">
        <p className="text-sm text-blue-900">
          Connect Google Business to start auto-posting your approved
          responses.
        </p>
        <Link
          href="/dashboard/connect"
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Connect
        </Link>
      </div>
    );
  }

  // In-flight connect flow (Redis marker present): show neutral "Connecting…"
  // wording rather than the disconnected orange/reconnect treatment.
  if (zernio.status === 'pending' && zernio.pendingFlow) {
    return (
      <div className="mb-6 flex items-center justify-between rounded-lg border border-blue-300 bg-blue-50 p-4">
        <p className="text-sm text-blue-900">
          Connecting your Google Business…
        </p>
        <Link
          href="/dashboard/connect"
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          View progress
        </Link>
      </div>
    );
  }

  // status === 'pending' (no marker — stale row) | 'disconnected'
  const headline =
    zernio.queuedReconnectCount > 0
      ? `${zernio.queuedReconnectCount} approved ${
          zernio.queuedReconnectCount === 1
            ? 'response is'
            : 'responses are'
        } waiting to publish.`
      : 'Auto-posting is currently disconnected.';

  return (
    <div className="mb-6 flex items-center justify-between rounded-lg border border-orange-300 bg-orange-50 p-4">
      <div>
        <p className="font-semibold text-orange-900">{headline}</p>
        <p className="text-sm text-orange-800">
          Reconnect Google Business to resume publishing.
        </p>
      </div>
      <Link
        href="/dashboard/connect"
        className="rounded bg-orange-600 px-4 py-2 text-sm text-white hover:bg-orange-700"
      >
        Reconnect
      </Link>
    </div>
  );
}
