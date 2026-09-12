'use client';

import type { AdminShellImpersonation } from '@/lib/admin/shell-context';
import { formatAdminTime } from './ui/format';
import { EndImpersonationButton } from './EndImpersonationButton';

/**
 * The persistent view-as marker (X25). While the signed `rw_impersonation`
 * cookie names a live session, every admin page carries this strip: the
 * session is read-only, but an operator who forgets it is open will read
 * customer data as themselves and lose the audit context the session exists
 * for. High contrast on purpose — red is the console's one alarm colour and
 * nothing else in the shell uses a filled red surface.
 *
 * Sticky at the viewport top inside `<main>`. The identity header scrolls
 * normally, so no mobile sidebar offset remains.
 */
export function ImpersonationBanner({ impersonation, adminAppUrl }: { impersonation: AdminShellImpersonation; adminAppUrl: string }) {
  return (
    <div
      role="status"
      aria-label="View-as session active"
      className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 bg-red-700 px-4 py-2 text-sm text-white shadow-md sm:px-6"
    >
      <span className="font-semibold uppercase tracking-wide">View-as session active</span>
      <span aria-hidden="true" className="text-red-200">·</span>
      <span className="truncate">{impersonation.accountLabel}</span>
      <span aria-hidden="true" className="text-red-200">·</span>
      <span>
        ends{' '}
        <time dateTime={impersonation.expiresAt} className="tabular-nums">
          {formatAdminTime(impersonation.expiresAt)}
        </time>
      </span>
      <span className="ml-auto">
        <EndImpersonationButton tone="inverse" compact adminAppUrl={adminAppUrl} />
      </span>
    </div>
  );
}
