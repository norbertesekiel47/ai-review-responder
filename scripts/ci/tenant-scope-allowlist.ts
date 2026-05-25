export interface TenantScopeAllowlistEntry {
  file: string;
  table: string;
  reason: string;
}

export const tenantScopeAllowlist: TenantScopeAllowlistEntry[] = [
  {
    file: 'src/app/(authenticated)/layout.tsx',
    table: 'businesses',
    reason: 'Authenticated shell resolves currentLocationId through getRequestScope before reading the selected location display name by businesses.id.',
  },
  {
    file: 'src/app/(authenticated)/settings/locations/page.tsx',
    table: 'accounts',
    reason: 'Owner settings page reads the authenticated billing parent by accounts.id from requireOwnerAccess scope.',
  },
  {
    file: 'src/app/api/account/settings/route.ts',
    table: 'accounts',
    reason: 'Owner account settings route mutates the authenticated billing parent by accounts.id from requireOwnerAccess scope.',
  },
  {
    file: 'src/app/api/admin/businesses/route.ts',
    table: 'businesses',
    reason: 'Admin-only business list and total count intentionally span all accounts after requireRole(admin).',
  },
  {
    file: 'src/app/api/admin/businesses/[id]/keywords/route.ts',
    table: 'businesses',
    reason: 'Admin-only keyword recompute route looks up one location by businesses.id after requireRole(admin).',
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
    file: 'src/app/api/billing/checkout/route.ts',
    table: 'accounts',
    reason: 'Billing checkout uses the authenticated owner account id as the accounts.id lookup key before creating Stripe Checkout.',
  },
  {
    file: 'src/app/api/billing/portal/route.ts',
    table: 'accounts',
    reason: 'Billing portal uses the authenticated owner account id as the accounts.id lookup key before creating a Stripe portal session.',
  },
  {
    file: 'src/app/api/billing/tier-change/route.ts',
    table: 'accounts',
    reason: 'Billing tier-change route locks and updates the authenticated billing parent by accounts.id from owner scope.',
  },
  {
    file: 'src/app/api/dashboard/route.ts',
    table: 'accounts',
    reason: 'Dashboard billing metadata queries read the authenticated billing parent by accounts.id from owner scope.',
  },
  {
    file: 'src/app/api/settings/voice/route.ts',
    table: 'businesses',
    reason: 'Voice settings route reads the selected location by businesses.id after resolveOwnerScope has established account/location scope.',
  },
  {
    file: 'src/lib/accounts/quota.ts',
    table: 'accounts',
    reason: 'Account quota helpers read billing parent snapshots by accounts.id; accounts.id is the tenant root identifier.',
  },
  {
    file: 'src/lib/accounts/repo.ts',
    table: 'accounts',
    reason: 'Account repository helpers operate on the billing parent by accounts.id; callers pass the authenticated account id.',
  },
  {
    file: 'src/lib/accounts/tier-change.ts',
    table: 'accounts',
    reason: 'Tier-change helper locks the billing parent by accounts.id supplied by authenticated billing routes.',
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
    file: 'src/lib/auth/resolve-owner-scope.ts',
    table: 'accounts',
    reason: 'Owner-scope resolver validates the signed-in user account by accounts.id from users.account_id before returning request scope.',
  },
  {
    file: 'src/lib/dashboard/aggregate-service.ts',
    table: 'accounts',
    reason: 'Dashboard aggregate service reads account lifecycle fields by authenticated accounts.id.',
  },
  {
    file: 'src/lib/dashboard/service.ts',
    table: 'businesses',
    reason: 'Legacy dashboard service is called with one business id and reads that location by businesses.id.',
  },
  {
    file: 'src/lib/db/account-guard.ts',
    table: 'accounts',
    reason: 'Account guard validates the authenticated billing parent by accounts.id before returning app-enforced account scope.',
  },
  {
    file: 'src/lib/locations/add-location-tx.ts',
    table: 'accounts',
    reason: 'Add-location transaction locks the authenticated billing parent by accounts.id before adding a location.',
  },
  {
    file: 'worker/background/pollers/ArchivalPoller.ts',
    table: 'notification_deliveries',
    reason: 'Archival poller performs global retention cleanup for old notification delivery rows independent of tenant access.',
  },
  {
    file: 'worker/background/pollers/CleanupAbandonedSignupsPoller.ts',
    table: 'accounts',
    reason: 'Lifecycle cleanup intentionally finds owner users without any account before deleting abandoned self-serve signups.',
  },
  {
    file: 'worker/background/pollers/NotificationFailoverPoller.ts',
    table: 'responses',
    reason: 'Failover poller scans globally for stale notification candidates and records tenant identifiers before enqueueing scoped notification jobs.',
  },
  {
    file: 'worker/background/pollers/ZernioRecentReviewPoller.ts',
    table: 'reviews',
    reason: 'Zernio poller tombstones source-deleted reviews for each active connection after loading connection.business_id.',
  },
  {
    file: 'worker/background/pollers/ZernioRecentReviewPoller.ts',
    table: 'responses',
    reason: 'Zernio poller tombstones pending responses for deleted source reviews under each active connection.',
  },
  {
    file: 'worker/ingress/resend.ts',
    table: 'notification_deliveries',
    reason: 'Resend webhook resolves provider events by external_message_id because inbound provider payloads do not include tenant ids.',
  },
  {
    file: 'worker/ingress/stripe/checkout-completed.ts',
    table: 'accounts',
    reason: 'Stripe checkout webhook resolves the account from signed Stripe metadata or customer id before updating billing state.',
  },
  {
    file: 'worker/ingress/twilio/twilio-delivery-status.ts',
    table: 'notification_deliveries',
    reason: 'Twilio webhook resolves provider events by external_message_id because inbound provider payloads do not include tenant ids.',
  },
  {
    file: 'worker/jobs/OnboardingDripWorker.ts',
    table: 'businesses',
    reason: 'Onboarding drip worker operates on scheduler-selected business ids and loads a single location by businesses.id.',
  },
  {
    file: 'worker/jobs/OwnerEmailWorker.ts',
    table: 'reviews',
    reason: 'Owner email worker follows response/review ids from durable notification job payloads to build an approval email.',
  },
  {
    file: 'worker/jobs/OwnerEmailWorker.ts',
    table: 'notification_deliveries',
    reason: 'Owner email worker checks and updates delivery rows by provider/job response identifiers while sending approval notifications.',
  },
  {
    file: 'worker/jobs/PlaceIdValidationWorker.ts',
    table: 'businesses',
    reason: 'Place validation worker operates on queued business ids and updates one location by businesses.id.',
  },
  {
    file: 'worker/jobs/RankingTrackingWorker.ts',
    table: 'businesses',
    reason: 'Ranking worker operates on scheduler-selected business ids and loads one active location by businesses.id.',
  },
  {
    file: 'worker/jobs/ResponseGeneratorWorker.ts',
    table: 'reviews',
    reason: 'Response generator follows a durable generate_response job payload and later loads the job business id before generating.',
  },
  {
    file: 'worker/jobs/ResponseGeneratorWorker.ts',
    table: 'responses',
    reason: 'Response generator idempotency check looks for an existing response by the durable job review_id/version pair.',
  },
  {
    file: 'worker/jobs/notification/dispatch.ts',
    table: 'notification_deliveries',
    reason: 'Notification dispatcher dedupes delivery rows by response/channel/template for an already-scoped notification job context.',
  },
];
