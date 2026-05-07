'use client';

import Link from 'next/link';
import { useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

export type SettingsTab = 'general' | 'voice' | 'channels';

interface Tab {
  id: SettingsTab;
  label: string;
  icon: IconName;
  href: string;
}

const TABS: Tab[] = [
  { id: 'general', label: 'General', icon: 'cog', href: '/settings' },
  { id: 'voice', label: 'Brand Voice', icon: 'sparkle', href: '/settings#brand-voice' },
  { id: 'channels', label: 'Notifications', icon: 'inbox', href: '/settings/channels' },
];

interface Props {
  activeTab: SettingsTab;
}

export function SettingsTabs({ activeTab }: Props) {
  const refs = useRef<Record<SettingsTab, HTMLAnchorElement | null>>({
    general: null,
    voice: null,
    channels: null,
  });
  const [u, setU] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const el = refs.current[activeTab];
    if (el) setU({ left: el.offsetLeft, width: el.offsetWidth });
  }, [activeTab]);

  return (
    <div className="settings-tabs" role="tablist">
      {TABS.map((t) => (
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
