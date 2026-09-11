export interface AdminNavItem {
  readonly href: string;
  readonly label: string;
  /** Which nav-counts field renders as a badge on this item. */
  readonly badge?: 'flaggedOpen' | 'failedJobs';
}

interface AdminNavGroup {
  readonly label: string;
  readonly items: readonly AdminNavItem[];
}

/** Grouped admin IA (spec §2). Every admin page must appear exactly once. */
export const ADMIN_NAV_GROUPS = [
  {
    label: 'Businesses',
    items: [
      { href: '/admin/locations/csv-import', label: 'Locations import' },
      { href: '/admin/offboardings', label: 'Offboardings' },
    ],
  },
  {
    label: 'Safety',
    items: [
      { href: '/admin/flagged', label: 'Flagged', badge: 'flaggedOpen' },
      { href: '/admin/suppressions', label: 'Suppressions' },
      { href: '/admin/solicitation', label: 'Send breaker' },
    ],
  },
  {
    label: 'Growth',
    items: [
      { href: '/admin/demos', label: 'Demos' },
      { href: '/admin/impersonate', label: 'Support' },
    ],
  },
] as const satisfies readonly AdminNavGroup[];

export type AdminNavGroupLabel = (typeof ADMIN_NAV_GROUPS)[number]['label'];

/** Auth pages render outside the shell — the sidebar hides itself here. */
export const ADMIN_AUTH_ROUTES = ['/admin/login', '/admin/forgot-password', '/admin/reset-password'];
