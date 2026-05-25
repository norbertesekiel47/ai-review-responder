export interface TenantScopeAllowlistEntry {
  file: string;
  table: string;
  reason: string;
}

export const tenantScopeAllowlist: TenantScopeAllowlistEntry[] = [
  {
    file: 'src/app/api/admin/businesses/route.ts',
    table: 'businesses',
    reason: 'Admin-only business list and total count intentionally span all accounts after requireRole(admin).',
  },
  {
    file: 'src/app/api/admin/overview/route.ts',
    table: 'api_costs',
    reason: 'Admin-only system overview intentionally reports platform-wide cost totals after requireRole(admin).',
  },
  {
    file: 'src/app/api/admin/overview/route.ts',
    table: 'businesses',
    reason: 'Admin-only system overview intentionally lists and counts all businesses after requireRole(admin).',
  },
  {
    file: 'src/app/api/admin/overview/route.ts',
    table: 'notification_deliveries',
    reason: 'Admin-only system overview intentionally reports platform-wide delivery health after requireRole(admin).',
  },
  {
    file: 'src/lib/admin/business-detail/queries.ts',
    table: 'approval_audit_log',
    reason: 'Admin business detail is scoped by account_id in adjacent query predicates and covered by denorm query tests.',
  },
  {
    file: 'src/lib/admin/cost-report-service.ts',
    table: 'api_costs',
    reason: 'Admin cost report supports platform-wide aggregation when no account_id filter is requested by an admin route.',
  },
  {
    file: 'worker/background/pollers/CleanupAbandonedSignupsPoller.ts',
    table: 'accounts',
    reason: 'Lifecycle cleanup intentionally finds owner users without any account before deleting abandoned self-serve signups.',
  },
];
