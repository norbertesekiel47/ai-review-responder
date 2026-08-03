import type { ReactNode } from 'react';
import type { AdminNavGroupLabel } from '../nav-config';

interface AdminPageProps {
  /** Sidebar group name, shown as breadcrumb (Operate · Businesses · Safety · Growth). */
  group: AdminNavGroupLabel;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function AdminPage({ group, title, description, actions, children }: AdminPageProps) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-gray-500">{group}</div>
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
