'use client';

interface ProgressDotsProps {
  current: 1 | 2 | 3;
}

export function ProgressDots({ current }: ProgressDotsProps) {
  const steps = [
    { n: 1 as const, label: 'Location' },
    { n: 2 as const, label: 'Profile' },
    { n: 3 as const, label: 'Voice' },
  ];

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
