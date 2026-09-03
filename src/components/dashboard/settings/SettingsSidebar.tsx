'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type MouseEvent } from 'react';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';
import { SETTINGS_DEFAULT_HREF } from '@/components/dashboard/shell/active-nav';
import { ConfirmDialog } from '@/components/dashboard/settings/ConfirmDialog';
import { useHasUnsavedChanges } from '@/hooks/useUnsavedChangesGuard';

/**
 * The QR glyph is rendered locally: the shared `Icon` set has no QR mark and
 * that file belongs to the dashboard shell, so the sidebar carries its own
 * (same 24-box, stroke and `ni-icon` class, so it sits in the rail like the
 * rest). Promote it to `IconName` when a second surface needs it.
 */
// #1092: the Review QR row left this nav, so the `| 'qr'` widening and the
// inline glyph it carried are gone. The glyph itself moved to the shell `Icon`,
// which the main sidebar's standalone Review QR entry now uses.
type NavIcon = IconName;

interface NavItem {
  label: string;
  href: string;
  icon: NavIcon;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const LOCATIONS_HREF = '/settings/locations';

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
      { label: 'Locations', href: LOCATIONS_HREF, icon: 'location' },
      // These three are also the account menu's destinations. One destination,
      // one icon: `user` / `card` / `shield` in both places, or the same page
      // wears two marks depending on how the owner reached it.
      { label: 'Profile', href: '/settings/profile', icon: 'user' },
      { label: 'Billing', href: '/settings/billing', icon: 'card' },
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

/**
 * The Locations tab exists only while the multi-location feature is on
 * (`settings/locations/page.tsx` 404s otherwise). The layout resolves
 * `shouldShowLocationsSettings` on the server and passes the answer down —
 * the browser never reads the flag (invariant #13).
 */
function visibleGroups(showLocations: boolean): NavGroup[] {
  if (showLocations) return NAV_GROUPS;
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.href !== LOCATIONS_HREF),
  }));
}

function NavGlyph({ icon }: { icon: NavIcon }) {
  return <Icon name={icon} size={16} />;
}

interface Props {
  /** Server-resolved `shouldShowLocationsSettings(multiLocationEnabled())`. */
  showLocations: boolean;
}

export function SettingsSidebar({ showLocations }: Props) {
  const pathname = usePathname() ?? SETTINGS_DEFAULT_HREF;
  const router = useRouter();
  const activeHref = resolveActiveHref(pathname);
  const groups = visibleGroups(showLocations);
  const hasUnsavedChanges = useHasUnsavedChanges();
  // The destination the owner asked for while a form was dirty; non-null =
  // the leave-confirmation dialog is open.
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  function navigate(href: string) {
    if (href === activeHref) return;
    if (hasUnsavedChanges) {
      setPendingHref(href);
      return;
    }
    router.push(href);
  }

  function onLinkClick(event: MouseEvent<HTMLAnchorElement>, href: string) {
    // Modifier clicks open a new tab — the current page and its edits stay put.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!hasUnsavedChanges || href === activeHref) return;
    event.preventDefault();
    setPendingHref(href);
  }

  function leaveAnyway() {
    const href = pendingHref;
    setPendingHref(null);
    if (href) router.push(href);
  }

  return (
    <nav className="settings-sidebar" aria-label="Settings">
      {/* Mobile: native grouped select */}
      <div className="settings-mobile-select-wrap">
        <select
          className="input settings-mobile-select"
          aria-label="Settings section"
          value={activeHref}
          onChange={(event) => navigate(event.target.value)}
        >
          {groups.map((group) => (
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

      {/* Desktop: grouped vertical list, led by the rail's own heading so the
          column reads as an intentional pane beside the page TopBar. */}
      <div className="settings-sidebar-groups">
        <div className="settings-sidebar-title">Settings</div>
        {groups.map((group) => (
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
                  onClick={(event) => onLinkClick(event, item.href)}
                >
                  <NavGlyph icon={item.icon} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      {pendingHref !== null && (
        <ConfirmDialog
          title="Leave without saving?"
          closeLabel="Stay on this page"
          heading="Leave without saving?"
          body="You have unsaved changes on this page. If you leave now they are lost."
          cancelLabel="Keep editing"
          confirmLabel="Leave without saving"
          confirmTone="primary"
          onCancel={() => setPendingHref(null)}
          onConfirm={leaveAnyway}
        />
      )}
    </nav>
  );
}
