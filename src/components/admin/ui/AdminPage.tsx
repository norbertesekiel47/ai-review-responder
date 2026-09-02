import Link from 'next/link';
import type { ReactNode } from 'react';
import { ADMIN_NAV_GROUPS, type AdminNavGroupLabel } from '../nav-config';

/** One intermediate breadcrumb between the group and this page's title. */
export interface AdminCrumb {
  href: string;
  label: string;
}

interface AdminPageProps {
  /** Sidebar group name, rendered as the breadcrumb root (Operate · Businesses · Safety · Growth). */
  group: AdminNavGroupLabel;
  /**
   * Optional parent crumb for a nested page (a detail page under a list). The
   * crumb replaces any ad-hoc "← Back to …" link the page used to render below
   * its title — there is ONE wayfinding element, and it is this breadcrumb (X28).
   */
  parent?: AdminCrumb;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * The group eyebrow links to the group's landing page — its first sidebar item,
 * derived from `ADMIN_NAV_GROUPS` (single owner of the IA) rather than a second
 * href table that could drift from the sidebar.
 */
function groupHref(group: AdminNavGroupLabel): string {
  const match = ADMIN_NAV_GROUPS.find((candidate) => candidate.label === group);
  // Every AdminNavGroupLabel is a member of ADMIN_NAV_GROUPS by construction
  // (the type is derived from it), so this branch is unreachable; the fallback
  // keeps the render total without a non-null assertion.
  return match?.items[0]?.href ?? '/admin/overview';
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
export function AdminPage({ group, parent, title, description, actions, children }: AdminPageProps) {
  const crumbClass = 'rounded hover:text-gray-900 hover:underline focus:outline-none focus:ring-2 focus:ring-gray-900';
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <nav aria-label="Breadcrumb" className="text-xs text-gray-500">
            <ol className="flex flex-wrap items-center gap-1">
              <li>
                <Link href={groupHref(group)} className={crumbClass}>
                  {group}
                </Link>
              </li>
              {parent && (
                <>
                  <li aria-hidden="true">›</li>
                  <li>
                    <Link href={parent.href} className={crumbClass}>
                      {parent.label}
                    </Link>
                  </li>
                </>
              )}
            </ol>
          </nav>
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
