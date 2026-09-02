import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// UX audit S27: every settings page titles itself with its section name — the
// same word the sidebar uses — and never "Settings" with the section demoted to
// a subtitle. Server components with DB access are asserted at the source level.
const SETTINGS_PAGES: Array<{ path: string; title: string }> = [
  { path: 'src/app/(authenticated)/settings/channels/page.tsx', title: 'Notifications' },
  { path: 'src/app/(authenticated)/settings/locations/page.tsx', title: 'Locations' },
  { path: 'src/app/(authenticated)/settings/billing/page.tsx', title: 'Billing' },
  { path: 'src/app/(authenticated)/settings/security/page.tsx', title: 'Security' },
  { path: 'src/app/(authenticated)/settings/review-qr/page.tsx', title: 'Review QR' },
  { path: 'src/app/(authenticated)/settings/competitors/page.tsx', title: 'Competitors' },
];

describe('settings page titles', () => {
  for (const { path, title } of SETTINGS_PAGES) {
    it(`${path} titles its TopBar "${title}"`, async () => {
      const source = await readFile(path, 'utf8');
      expect(source).toContain(`title="${title}"`);
      expect(source).not.toContain('title="Settings"');
    });
  }

  it('the channels page title matches the sidebar label', async () => {
    const sidebar = await readFile('src/components/dashboard/settings/SettingsSidebar.tsx', 'utf8');
    expect(sidebar).toMatch(/label:\s*'Notifications',\s*href:\s*'\/settings\/channels'/);
  });
});
