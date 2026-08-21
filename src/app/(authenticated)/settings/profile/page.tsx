import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { readPostalAddressState } from '@/lib/solicitation/postal-address';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { ProfileClient } from './ProfileClient';

export default async function ProfilePage() {
  // Composition root: this page owns the `sql` singleton and hands it to the
  // domain module, which never imports it (invariant #15).
  //
  // `currentLocationId`, NEVER the account's primary location. The guard
  // resolves it from the `rw_location_scope` cookie via getRequestScope, and
  // PUT /api/settings/postal-address resolves the same cookie — so in a
  // multi-location account the panel shows the address the route would write.
  // Reading the primary here would show one location's address while writing
  // another's (#656 review round 1).
  const { accountId, currentLocationId } = await requireOwnerAccess(sql);

  // The Attested postal address exists only to footer a Solicitation ask, so
  // the panel belongs to the Solicitation surface and rides its master switch —
  // the same gate `/dashboard/requests` and the contacts routes already run.
  // Without this the panel rendered for EVERY owner while watch-mode was off:
  // `readPostalAddressState` returns null only for a MISSING business row, never
  // for a disabled feature, so "no row" was doing duty it cannot do. The read is
  // skipped rather than discarded, so a disabled feature costs no query.
  // Server-authoritative, invariant #13: with the flag off the browser is told
  // nothing. PUT /api/settings/postal-address runs the same gate.
  const postalAddress = solicitationWatchEnabled()
    ? await readPostalAddressState(sql, {
        accountId,
        businessId: currentLocationId,
      })
    : null;

  return (
    <>
      <TopBar
        title="Profile"
        subtitle="Your business identity and account."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <ProfileClient postalAddress={postalAddress} />
    </>
  );
}
