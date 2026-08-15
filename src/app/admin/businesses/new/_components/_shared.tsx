'use client';

// Internal primitives shared across the admin "Onboard New Business" form
// section components. Underscore-prefixed filename signals "not a section
// component, just shared building blocks."

export const inputClass =
  'rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900';

// `textareaClass` and Field's `hint` slot went with the Voice & Context
// section and the SerpAPI prefill respectively — the three-field invite form
// has no multi-line input and nothing async to narrate.

interface FieldProps {
  label: string;
  error?: string;
  children: React.ReactNode;
}

export function Field({ label, error, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-gray-700">{label}</label>
      {children}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-base font-semibold text-gray-900">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}
