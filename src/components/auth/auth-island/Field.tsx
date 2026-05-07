'use client';

import { useId, useState, type ChangeEvent, type ReactNode } from 'react';
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
  describedById?: string;
  invalid?: boolean;
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
  invalid,
}: FieldProps) {
  const [show, setShow] = useState(false);
  const isPwd = type === 'password';
  const realType = isPwd && show ? 'text' : type;
  const fallbackId = useId();
  const id = name || fallbackId;

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
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          aria-invalid={invalid || undefined}
          aria-describedby={describedById}
          className={`rw-input ${invalid ? 'has-error' : ''}`}
        />
        <span className="rw-input-icon">{icon}</span>
        {isPwd && (
          <button
            type="button"
            className="rw-toggle-pwd"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? 'Hide password' : 'Show password'}
          >
            {show ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}
      </div>
    </div>
  );
}
