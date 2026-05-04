'use client';

interface ProgressDotsProps {
  current: number;
  /** Total step count. Defaults to 3 (legacy Location-Profile-Voice). */
  total?: number;
}

const ALL_STEPS = [
  { n: 1, label: 'Location' },
  { n: 2, label: 'Profile' },
  { n: 3, label: 'Voice' },
];

export function ProgressDots({ current, total = 3 }: ProgressDotsProps) {
  // For the 2-step post-pay wizard, drop "Location" and renumber:
  // step 1 = Profile, step 2 = Voice.
  const steps =
    total === 2
      ? [
          { n: 1, label: 'Profile' },
          { n: 2, label: 'Voice' },
        ]
      : ALL_STEPS;

  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((s, i) => (
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
          {i < steps.length - 1 && (
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
