import type { ReactNode } from 'react';

export interface ComingSoonChannelRowProps {
  icon: ReactNode;
  name: string;
  reason: string;
}

export function ComingSoonChannelRow({ icon, name, reason }: ComingSoonChannelRowProps) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 opacity-60">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="text-2xl" aria-hidden>{icon}</div>
          <div>
            <div className="font-medium text-slate-100">{name}</div>
            <p className="text-sm text-slate-400">{reason}</p>
          </div>
        </div>
        <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-400">Coming soon</span>
      </div>
    </div>
  );
}
