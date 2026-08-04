import type { ReactNode } from 'react';
import type { AdminNavGroupLabel } from '../nav-config';

interface AdminPageProps {
  /** Sidebar group name, shown as breadcrumb (Operate · Businesses · Safety · Growth). */
  group: AdminNavGroupLabel;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * CONTENT MEASURES (CF-5) — the rule, so it stops being decided per file.
 *
 * `AdminPage` owns the PAGE measure (`max-w-7xl`) and nothing else. What sits
 * inside picks its own reading measure by kind:
 *
 *   - **form pages** → `max-w-2xl` on the form. Inputs stretched to 1280px are
 *     unreadable and unfillable. (`businesses/new`, `impersonate`)
 *   - **upload / report pages** → `max-w-3xl`. Wider than a form because the
 *     validation preview and result summary are tabular, still bounded because
 *     they are prose-and-list, not a data grid. (`locations/csv-import`)
 *   - **data pages** → no inner measure; a table or card list uses the full
 *     `AdminPage` width. (`overview`, `jobs`, `costs`, `notifications`,
 *     `flagged`, `businesses`, `businesses/[id]`, `offboardings`, `autonomy`,
 *     the impersonation view)
 *   - **mixed form + list on one page** → measure the FORM (`max-w-2xl`), let
 *     the list run full width. The two blocks are independent surfaces; pinning
 *     the whole page to the form's measure would waste the grid the list needs.
 *     (`demos`)
 *
 * Known side effect, accepted: an `actions`-slot button sits at the `max-w-7xl`
 * right edge even when the content below it is pinned left, so on a wide
 * monitor it floats away from what it acts on. Fixing that means moving the
 * measure into `AdminPage` and having every page declare its kind — a bigger
 * change than this sweep, and one that would have to re-home the actions slot.
 */
export function AdminPage({ group, title, description, actions, children }: AdminPageProps) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-gray-500">{group}</div>
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
