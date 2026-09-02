'use client';

// Internal primitives shared across the admin "Onboard New Business" form
// section components. Underscore-prefixed filename signals "not a section
// component, just shared building blocks."

import { useId, type ReactNode } from 'react';

export const inputClass =
  'rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900';

// `textareaClass` and Field's `hint` slot went with the Voice & Context
// section and the SerpAPI prefill respectively — the three-field invite form
// has no multi-line input and nothing async to narrate.

/** The ids `Field` hands its control: `id` for the input, `describedBy` for its error line. */
interface FieldIds {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

interface FieldProps {
  label: string;
  error?: string;
  /**
   * The control, given the ids to wire (X12). A render function rather than a
   * bare child so the label's `htmlFor` and the input's `id` are the SAME
   * generated value by construction — a label that only sits above its input
   * is not associated with it for a screen reader or a click.
   */
  children: (ids: FieldIds) => ReactNode;
}

export function Field({ label, error, children }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">
        {label}
      </label>
      {children({ id, describedBy: error ? errorId : undefined, invalid: Boolean(error) })}
      {error && (
        <p id={errorId} className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function SectionCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-base font-semibold text-gray-900">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}
