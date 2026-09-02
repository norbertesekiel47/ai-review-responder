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
  const realType = isPwd && show ? 'text' : type;
  const fallbackId = useId();
  const id = name || fallbackId;
  const errorId = `${id}-error`;
  const invalid = Boolean(error) || invalidProp;
  const describedBy = [error ? errorId : null, describedById].filter(Boolean).join(' ') || undefined;

  return (
    <div className="rw-field-row">
      <label className="rw-label" htmlFor={id}>
        {label}
      </label>
      <div className="rw-input-wrap">
        <input
          id={id}
          name={name}
          type={realType}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={`rw-input ${invalid ? 'has-error' : ''}`}
        />
        <span className="rw-input-icon">{icon}</span>
        {isPwd && (
          <button
            type="button"
            className="rw-toggle-pwd"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? 'Hide password' : 'Show password'}
            aria-pressed={show}
          >
            {show ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}
      </div>
      {error && (
        <p id={errorId} className="rw-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
