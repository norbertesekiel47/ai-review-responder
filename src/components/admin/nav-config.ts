interface AdminNavItem {
  readonly href: string;
  readonly label: string;
}

interface AdminNavGroup {
  readonly label: string;
  readonly items: readonly AdminNavItem[];
}

/** Breadcrumb roots for the permanent support pages; each non-auth root appears once. */
export const ADMIN_NAV_GROUPS = [
  {
    label: 'Growth',
    items: [
      { href: '/admin/impersonate', label: 'Support' },
    ],
  },
] as const satisfies readonly AdminNavGroup[];

export type AdminNavGroupLabel = (typeof ADMIN_NAV_GROUPS)[number]['label'];

/** Auth pages render outside the legacy identity shell. */
export const ADMIN_AUTH_ROUTES = ['/admin/login', '/admin/forgot-password', '/admin/reset-password'];
