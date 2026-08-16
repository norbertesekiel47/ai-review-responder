'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';
import { SETTINGS_DEFAULT_HREF } from '@/components/dashboard/shell/active-nav';

interface NavItem {
  label: string;
  href: string;
  icon: IconName;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Responses',
    items: [
      { label: 'Brand Voice', href: '/settings/voice', icon: 'sparkle' },
      { label: 'Auto-approval', href: '/settings/auto-approval', icon: 'shield' },
      { label: 'Notifications', href: '/settings/channels', icon: 'inbox' },
      { label: 'Competitors', href: '/settings/competitors', icon: 'chart' },
    ],
  },
  {
    label: 'Account',
    items: [
      { label: 'Locations', href: '/settings/locations', icon: 'location' },
      { label: 'Profile', href: '/settings/profile', icon: 'home' },
      { label: 'Billing', href: '/settings/billing', icon: 'chart' },
      { label: 'Security', href: '/settings/security', icon: 'shield' },
    ],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

/**
 * Treat the bare `/settings` index as the default tab — `settings/page.tsx`
 * redirects there, and both read SETTINGS_DEFAULT_HREF so they cannot disagree
 * about which tab that is.
 */
function resolveActiveHref(pathname: string): string {
  if (pathname === '/settings' || pathname === SETTINGS_DEFAULT_HREF) return SETTINGS_DEFAULT_HREF;
  const match = ALL_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  return match?.href ?? SETTINGS_DEFAULT_HREF;
}

export function SettingsSidebar() {
  const pathname = usePathname() ?? SETTINGS_DEFAULT_HREF;
  const router = useRouter();
  const activeHref = resolveActiveHref(pathname);

  return (
    <nav className="settings-sidebar" aria-label="Settings">
      {/* Mobile: native grouped select */}
      <div className="settings-mobile-select-wrap">
        <select
          className="input settings-mobile-select"
          aria-label="Settings section"
          value={activeHref}
          onChange={(event) => router.push(event.target.value)}
        >
          {NAV_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <option key={item.href} value={item.href}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Desktop: grouped vertical list */}
      <div className="settings-sidebar-groups">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="settings-nav-group">
            <div className="settings-nav-group-label">{group.label}</div>
            {group.items.map((item) => {
              const active = item.href === activeHref;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`settings-nav-item ${active ? 'active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
