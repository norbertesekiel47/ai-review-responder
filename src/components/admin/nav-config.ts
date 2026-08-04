export interface AdminNavItem {
  href: string;
  label: string;
  /** Which nav-counts field renders as a badge on this item. */
  badge?: 'flaggedOpen' | 'failedJobs';
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

/** Grouped admin IA (spec §2). Every admin page must appear exactly once. */
export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    label: 'Operate',
    items: [
      { href: '/admin/overview', label: 'Overview' },
      { href: '/admin/jobs', label: 'Jobs', badge: 'failedJobs' },
      { href: '/admin/costs', label: 'Costs' },
      { href: '/admin/notifications', label: 'Notifications' },
      { href: '/admin/runbook', label: 'Runbook' },
    ],
  },
  {
    label: 'Businesses',
    items: [
      { href: '/admin/businesses', label: 'All businesses' },
      { href: '/admin/locations/csv-import', label: 'Locations import' },
      { href: '/admin/offboardings', label: 'Offboardings' },
    ],
  },
  {
    label: 'Safety',
    items: [
      { href: '/admin/flagged', label: 'Flagged', badge: 'flaggedOpen' },
      { href: '/admin/autonomy', label: 'Autonomy' },
      { href: '/admin/security', label: 'Security' },
    ],
  },
  {
    label: 'Growth',
    items: [
      { href: '/admin/demos', label: 'Demos' },
      { href: '/admin/impersonate', label: 'Support' },
    ],
  },
];

/** Auth pages render outside the shell — the sidebar hides itself here. */
export const ADMIN_AUTH_ROUTES = ['/admin/login', '/admin/forgot-password', '/admin/reset-password'];
