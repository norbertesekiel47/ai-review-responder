'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';
import { deriveNavSection, type NavSection } from '@/components/dashboard/shell/active-nav';
import { usePendingCount } from '@/contexts/PendingCountContext';

interface Props {
  /** Server-authoritative SOLICITATION_WATCH_ENABLED, passed down from
   *  (authenticated)/layout.tsx. Invariant #13: the browser learns flag state
   *  only through this prop — there is no NEXT_PUBLIC companion. */
  solicitationEnabled: boolean;
}

/**
 * One tab. Extracted so the bar is a LIST rather than five near-identical
 * blocks, each repeating the same `.active` / `aria-current` pairing — the
 * repetition pushed the component past the complexity gate once #1092 added a
 * conditional row, and pairing the two states here is what stops the visual
 * and assistive-tech current-page markers drifting apart.
 */
function MobileTab({
  href,
  label,
  icon,
  section,
  activeNav,
  badge,
}: {
  href: string;
  label: string;
  icon: IconName;
  section: NavSection;
  activeNav: NavSection | null;
  badge?: number;
}) {
  const active = activeNav === section;
  return (
    <Link
      href={href}
      className={`mtab ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <Icon name={icon} size={22} /> {label}
      {badge !== undefined && badge > 0 && <span className="nav-badge">{badge}</span>}
    </Link>
  );
}

export function MobileTabBar({ solicitationEnabled }: Props) {
  const pathname = usePathname() ?? '';
  const pendingCount = usePendingCount();

  // Home follows the same rule as the sidebar's Dashboard row: the catch-all
  // for any /dashboard/* route no other tab owns (connect, add-location). The
  // two navs used to disagree there — the sidebar lit Dashboard, this bar lit
  // nothing (UX audit D30).
  const activeNav = deriveNavSection(pathname);

  /**
   * The third slot. With watch-mode ON it is Requests. With it OFF that section
   * does not exist, and **Review QR** takes the slot rather than the bar
   * shrinking — the surface is visible to EVERY owner (docs/context/review-qr.md), the sidebar
   * is hidden at this width, and #1092 removed its Settings entry, so without
   * this row it has no entry point on a phone at all (owner decision
   * 2026-09-03). Either way the bar stays five wide.
   */
  const thirdSlot = solicitationEnabled
    ? { href: '/dashboard/requests', label: 'Requests', icon: 'trend' as const }
    : { href: '/dashboard/requests/qr', label: 'Review QR', icon: 'qr' as const };

  return (
    <nav className="mobile-tabbar" aria-label="Dashboard">
      <MobileTab
        href="/dashboard"
        label="Home"
        icon="home"
        section="dashboard"
        activeNav={activeNav}
      />
      <MobileTab
        href="/dashboard/reviews"
        label="Reviews"
        icon="inbox"
        section="reviews"
        activeNav={activeNav}
        badge={pendingCount}
      />
      {/* Both variants highlight on `requests`: `deriveNavSection` folds the
          moved QR route into that section, so the slot lights up either way. */}
      <MobileTab {...thirdSlot} section="requests" activeNav={activeNav} />
      <MobileTab
        href="/dashboard/analytics"
        label="Analytics"
        icon="chart"
        section="analytics"
        activeNav={activeNav}
      />
      <MobileTab
        href="/settings"
        label="Settings"
        icon="cog"
        section="settings"
        activeNav={activeNav}
      />
    </nav>
  );
}
