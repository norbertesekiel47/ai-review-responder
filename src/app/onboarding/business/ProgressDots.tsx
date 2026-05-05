'use client';

interface ProgressDotsProps {
  current: number;
  /** Total step count. Defaults to 3. */
  total?: number;
  /**
   * When true, render the post-pay (demo-flow) labels: Profile, Voice, Connect.
   * When false (default), render the legacy labels: Location, Profile, Voice.
   */
  demoFlow?: boolean;
}

const LEGACY_STEPS = [
  { n: 1, label: 'Location' },
  { n: 2, label: 'Profile' },
  { n: 3, label: 'Voice' },
];

const DEMO_STEPS = [
  { n: 1, label: 'Profile' },
  { n: 2, label: 'Voice' },
  { n: 3, label: 'Connect' },
];

export function ProgressDots({ current, total = 3, demoFlow = false }: ProgressDotsProps) {
  const steps = demoFlow ? DEMO_STEPS : LEGACY_STEPS;
  // Trim if caller passed a smaller `total` than the label set (defensive —
  // current callers pass total=3).
  const visible = steps.slice(0, total);

  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {visible.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium ${
              s.n < current
                ? 'bg-blue-600 text-white'
                : s.n === current
                  ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                  : 'bg-gray-200 text-gray-500'
            }`}
            aria-current={s.n === current ? 'step' : undefined}
          >
            {s.n < current ? '✓' : s.n}
          </div>
          <span
            className={`text-sm ${
              s.n === current ? 'font-medium text-gray-900' : 'text-gray-500'
            }`}
          >
            {s.label}
          </span>
          {i < visible.length - 1 && (
            <div
              className={`mx-2 h-px w-8 ${
                s.n < current ? 'bg-blue-600' : 'bg-gray-200'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
