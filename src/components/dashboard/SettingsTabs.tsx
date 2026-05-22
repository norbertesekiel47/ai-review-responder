'use client';

import Link from 'next/link';
import { useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

// ── Tab types ──────────────────────────────────────────────────────────

export type SettingsTab = 'account' | 'locations' | 'voice' | 'channels' | 'general';

interface Tab {
  id: SettingsTab;
  label: string;
  icon: IconName;
  href: string;
}

// ── Tab arrays ──────────────────────────────────────────────────────────

/** Multi-location: 4 tabs — Account, Locations, Voice, Notifications */
const TABS_MULTI: Tab[] = [
  { id: 'account', label: 'Account', icon: 'cog', href: '/settings' },
  { id: 'locations', label: 'Locations', icon: 'location', href: '/settings/locations' },
  { id: 'voice', label: 'Voice', icon: 'sparkle', href: '/settings/voice' },
  { id: 'channels', label: 'Notifications', icon: 'inbox', href: '/settings/channels' },
];

/** Single-location (flag off): 3 tabs — General, Brand Voice, Notifications */
const TABS_SINGLE: Tab[] = [
  { id: 'general', label: 'General', icon: 'cog', href: '/settings' },
  { id: 'voice', label: 'Brand Voice', icon: 'sparkle', href: '/settings#brand-voice' },
  { id: 'channels', label: 'Notifications', icon: 'inbox', href: '/settings/channels' },
];

/** Single-location with locations settings: 4 tabs — General, Locations, Brand Voice, Notifications */
const TABS_SINGLE_WITH_LOCATIONS: Tab[] = [
  { id: 'general', label: 'General', icon: 'cog', href: '/settings' },
  { id: 'locations', label: 'Locations', icon: 'location', href: '/settings/locations' },
  { id: 'voice', label: 'Brand Voice', icon: 'sparkle', href: '/settings#brand-voice' },
  { id: 'channels', label: 'Notifications', icon: 'inbox', href: '/settings/channels' },
];

// ── Component ───────────────────────────────────────────────────────────

interface Props {
  activeTab: SettingsTab;
  /** When true, exposes the Locations tab without switching to true multi-location content mode. */
  locationsSettingsEnabled?: boolean;
  /** When true, uses the true multi-location layout (Account, Locations, Voice, Notifications). */
  multiLocationEnabled?: boolean;
}

export function SettingsTabs({ activeTab, locationsSettingsEnabled, multiLocationEnabled }: Props) {
  const tabs = multiLocationEnabled
    ? TABS_MULTI
    : locationsSettingsEnabled
      ? TABS_SINGLE_WITH_LOCATIONS
      : TABS_SINGLE;

  // Build the refs object dynamically based on which tab set is active
  const refs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const [u, setU] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const el = refs.current[activeTab];
    if (el) setU({ left: el.offsetLeft, width: el.offsetWidth });
  }, [activeTab, locationsSettingsEnabled, multiLocationEnabled]);

  return (
    <div className="settings-tabs" role="tablist">
      {tabs.map((t) => (
        <Link
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          href={t.href}
          className={`stab ${activeTab === t.id ? 'active' : ''}`}
          role="tab"
          aria-selected={activeTab === t.id}
        >
          <Icon name={t.icon} size={16} /> {t.label}
        </Link>
      ))}
      <div className="stab-underline" style={{ left: u.left, width: u.width }} />
    </div>
  );
}
