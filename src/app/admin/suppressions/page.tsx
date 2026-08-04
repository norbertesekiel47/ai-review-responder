import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { SuppressionsClient } from './SuppressionsClient';

export const dynamic = 'force-dynamic';

/**
 * The §7.2 daily mailbox-servicing entry point (#645; locked spec
 * docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §7.2,
 * §7.3, §8.2).
 *
 * Lookup-first by design: there is no "all suppressions" list and this page
 * fetches nothing. The ritual starts from an address in a forwarded mailbox
 * reply, so an address is always in hand — and a browsable dump of every
 * opted-out recipient is a liability with no use, cross-tenant by construction.
 */
export default async function AdminSuppressionsPage() {
  // The rows name recipients and the accounts that mailed them across every
  // tenant — same sensitivity as /admin/flagged, same unconditional AAL2 gate,
  // matching the requireAdminWithAal2 on the routes this page calls.
  await requireAdminPage(sql, { from: '/admin/suppressions', aal2: true });

  return <SuppressionsClient />;
}
