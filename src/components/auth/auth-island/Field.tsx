'use client';

import { useId, useState, type ChangeEvent, type FocusEvent, type ReactNode } from 'react';
import { EyeIcon, EyeOffIcon } from './Icons';

export interface FieldProps {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  icon: ReactNode;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  /** Extra element id(s) to associate via aria-describedby (e.g. a requirements list). */
  describedById?: string;
  /** Visible validation error. When set, marks the input invalid and links it via aria-describedby. */
  error?: string;
  /**
   * Marks the input invalid WITHOUT rendering Field's own error line — for a
   * caller that owns its feedback element (linked via `describedById`) and
   * its own live region, so the error is announced exactly once.
   */
  invalid?: boolean;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
}

export interface FieldInputAttrs {
  /** `text` while a password is revealed; the caller's `type` otherwise. */
  type: string;
  invalid: boolean;
  /** `true` or absent — React drops the attribute for `undefined`, never renders "false". */
  ariaInvalid: true | undefined;
  /**
   * Field's own error line first (when shown), then whatever the caller linked.
   * `undefined` (not `""`) when there is nothing to point at, so React omits
   * the attribute.
   */
  describedBy: string | undefined;
  className: string;
}

/** Pure derivation of the <input>'s type + validity attributes from Field's props. */
export function resolveFieldInput(input: {
  type: string;
  showPassword: boolean;
  error?: string;
  invalid: boolean;
  errorId: string;
  describedById?: string;
}): FieldInputAttrs {
  const invalid = Boolean(input.error) || input.invalid;
  const ownErrorId = input.error ? input.errorId : null;
  return {
    type: input.type === 'password' && input.showPassword ? 'text' : input.type,
    invalid,
    ariaInvalid: invalid || undefined,
    describedBy: [ownErrorId, input.describedById].filter(Boolean).join(' ') || undefined,
    className: `rw-input ${invalid ? 'has-error' : ''}`,
  };
}

// The show/hide affordance on a password field. Pressed state and label track
// the visibility so a screen reader hears "Hide password, pressed" after a toggle.
function PasswordToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="rw-toggle-pwd"
      onClick={onToggle}
      aria-label={show ? 'Hide password' : 'Show password'}
      aria-pressed={show}
    >
      {show ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}

export function Field({
  label,
  name,
  type = 'text',
  value,
  onChange,
  icon,
  placeholder,
  autoComplete,
  required,
  minLength,
  describedById,
  error,
  invalid: invalidProp = false,
  onBlur,
}: FieldProps) {
  const [show, setShow] = useState(false);
  const isPwd = type === 'password';
  const fallbackId = useId();
  const id = name || fallbackId;
  const errorId = `${id}-error`;
  const input = resolveFieldInput({
    type,
    showPassword: show,
    error,
    invalid: invalidProp,
    errorId,
    describedById,
  });

  return (
    <div className="rw-field-row">
      <label className="rw-label" htmlFor={id}>
        {label}
      </label>
      <div className="rw-input-wrap">
        <input
          id={id}
          name={name}
          type={input.type}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          aria-invalid={input.ariaInvalid}
          aria-describedby={input.describedBy}
          className={input.className}
        />
        <span className="rw-input-icon">{icon}</span>
        {isPwd && <PasswordToggle show={show} onToggle={() => setShow((s) => !s)} />}
      </div>
      {error && (
        <p id={errorId} className="rw-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
