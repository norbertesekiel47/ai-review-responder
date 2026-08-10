'use client';

import { useSettingsForm } from '@/hooks/useSettingsForm';
import { ProfilePanel } from '@/components/dashboard/settings/ProfilePanel';
import { SettingsSkeleton } from '@/components/dashboard/settings/SettingsSkeleton';
import { SolicitationAddressPanel } from '@/components/dashboard/settings/SolicitationAddressPanel';
import type { PostalAddressState } from '@/lib/solicitation/postal-address';

interface Props {
  /**
   * Server-fetched by page.tsx for the cookie-resolved active location
   * (deviations D3 — a prop, not a widening of the shared /api/settings
   * payload). `null` only when that location is not readable under the
   * account, in which case there is nothing to attest and the panel is absent.
   */
  postalAddress: PostalAddressState | null;
}

export function ProfileClient({ postalAddress }: Props) {
  const f = useSettingsForm();

  if (f.fetchError) {
    return (
      <div className="set-section set-section--error">
        <div className="set-section-title settings-error-title">Error</div>
        <p className="settings-error-copy">{f.fetchError}</p>
      </div>
    );
  }
  if (!f.data) {
    return <SettingsSkeleton />;
  }
  // The postal panel leads because it is the only actionable section here:
  // ProfilePanel's fields are locked, and it ends with the delete-data danger
  // zone, which stays terminal. ProfilePanel itself is untouched (D3).
  return (
    <>
      {postalAddress !== null && <SolicitationAddressPanel state={postalAddress} />}
      <ProfilePanel data={f.data} />
    </>
  );
}
