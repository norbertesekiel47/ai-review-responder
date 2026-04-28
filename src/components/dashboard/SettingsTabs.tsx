import Link from 'next/link';

export interface SettingsTabsProps {
  activeTab: 'general' | 'channels';
}

export function SettingsTabs({ activeTab }: SettingsTabsProps) {
  const tab = (key: 'general' | 'channels', label: string, href: string) => {
    const active = activeTab === key;
    return (
      <Link
        href={href}
        className={
          active
            ? 'inline-block border-b-2 border-cyan-400 px-4 py-2 text-sm font-medium text-cyan-400'
            : 'inline-block border-b-2 border-transparent px-4 py-2 text-sm text-slate-400 hover:text-slate-200'
        }
      >
        {label}
      </Link>
    );
  };

  return (
    <nav className="mb-6 border-b border-slate-800" aria-label="Settings sections">
      {tab('general', 'General', '/settings')}
      {tab('channels', 'Notification channels', '/settings/channels')}
    </nav>
  );
}
