// src/app/(authenticated)/settings/page.tsx
//
// Server component shell. Renders the tab strip and the existing
// general settings form. Auth + subscription guard runs server-side.

import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { SettingsGeneralForm } from './SettingsGeneralForm';

export default async function SettingsPage() {
  await requireOwnerAccess();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <SettingsTabs activeTab="general" />
      <SettingsGeneralForm />
    </div>
  );
}
