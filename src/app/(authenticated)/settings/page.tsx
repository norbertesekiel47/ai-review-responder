import { redirect } from 'next/navigation';
import { SETTINGS_DEFAULT_HREF } from '@/components/dashboard/shell/active-nav';

// The default tab has ONE owner — SettingsSidebar highlights the same constant
// for a bare `/settings`, so the redirect and the highlighted row agree.
export default function SettingsIndexPage() {
  redirect(SETTINGS_DEFAULT_HREF);
}
