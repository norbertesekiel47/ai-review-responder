import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
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
  const postalAddress = await readPostalAddressState(sql, {
    accountId,
    businessId: currentLocationId,
  });

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
