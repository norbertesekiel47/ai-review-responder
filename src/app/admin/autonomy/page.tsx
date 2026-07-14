import { AutonomySuspensionsClient } from './AutonomySuspensionsClient';

export const dynamic = 'force-dynamic';

export default function AdminAutonomyPage() {
  return (
    <main className="min-h-screen bg-rw-cream text-rw-ink">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-rw-teal-strong">
          Safety operations
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Autonomy suspensions</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-rw-ink-soft">
          Review the watchdog evidence before restoring auto-posting. Unsuspending never restores
          a threshold the owner previously cleared.
        </p>
        <AutonomySuspensionsClient />
      </div>
    </main>
  );
}
