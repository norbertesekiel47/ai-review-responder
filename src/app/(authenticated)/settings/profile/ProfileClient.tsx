'use client';

import { useSettingsForm } from '@/hooks/useSettingsForm';
import { ProfilePanel } from '@/components/dashboard/settings/ProfilePanel';
import { DeleteDataPanel } from '@/components/dashboard/settings/DeleteDataPanel';
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
  // Order: the page is named Profile, so the business profile leads. The
  // sender address is a review-request setting that happens to live here
  // (its route and state are per-location, D3) and follows. The Danger zone
  // stays terminal — nothing sits below "Delete data".
  return (
    <>
      <ProfilePanel data={f.data} />
      {postalAddress !== null && <SolicitationAddressPanel state={postalAddress} />}
      <DeleteDataPanel />
    </>
  );
}
