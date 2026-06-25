'use client';

export type FunnelStep = 'find' | 'preview' | 'plan' | 'setup';

const MILESTONES: { key: FunnelStep; label: string }[] = [
  { key: 'find', label: 'Find business' },
  { key: 'preview', label: 'Preview' },
  { key: 'plan', label: 'Plan' },
  { key: 'setup', label: 'Set up' },
];

export function FunnelStepThread({ step }: { step: FunnelStep }) {
  const currentIndex = MILESTONES.findIndex((m) => m.key === step);

  return (
    <ol
      className="flex items-start justify-center gap-1 mb-2"
      aria-label="Onboarding progress"
    >
      {MILESTONES.map((m, i) => {
        const state =
          i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo';
        return (
          <li key={m.key} className="flex items-start gap-1">
            <div className="flex flex-col items-center gap-1.5 min-w-[58px]">
              <span
                aria-current={state === 'current' ? 'step' : undefined}
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${
                  state === 'todo'
                    ? 'bg-[#e3ddd3] text-[#9a948a]'
                    : state === 'current'
                      ? 'bg-rw-teal text-white ring-4 ring-rw-teal/25'
                      : 'bg-rw-teal text-white'
                }`}
              >
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span
                className={`text-[11px] text-center leading-tight ${
                  state === 'current'
                    ? 'font-medium text-rw-ink'
                    : 'text-rw-ink-soft'
                }`}
              >
                {m.label}
              </span>
            </div>
            {i < MILESTONES.length - 1 && (
              <span
                className={`h-px w-5 sm:w-8 mt-3.5 ${
                  i < currentIndex ? 'bg-rw-teal' : 'bg-[#cdd9ce]'
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
