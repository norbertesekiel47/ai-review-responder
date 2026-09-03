'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import {
  passwordRequirements,
  strengthOf,
  STRENGTH_LABELS,
} from '@/components/auth/shared/strength';
import { MIN_PASSWORD_LENGTH } from '@/lib/shared/password-rules';
import { Field } from './Field';
import { LockIcon } from './Icons';

/**
 * The signup island's password control: the input, the ENFORCED requirements
 * list, the strength meter, and the debounced screen-reader announcement.
 *
 * Extracted from `SignupForm` to bring it back under the complexity gate after
 * #1090 added the submit-time rule check — the same remedy, for the same
 * reason, as `OfferPrompt`/`useNoticePhase` in `ImportOfferBanner`. It takes
 * two `useMemo`s, a `useState`, a `useEffect`, two `useId`s and the deepest JSX
 * in the form with it.
 *
 * It is presentation only. The form still owns the value, the submit gate and
 * the error surface, so nothing about WHEN a password is accepted lives here.
 *
 * Requirements vs strength is the distinction the whole file turns on:
 * `passwordRequirements` lists what the SERVER ENFORCES, and `strengthOf`
 * scores advice that never rejects anything. #1090 exists because the two were
 * conflated.
 */
export function PasswordFieldGroup({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const reqListId = useId();
  const strengthMsgId = useId();

  const strength = useMemo(() => strengthOf(value), [value]);
  const requirements = useMemo(() => passwordRequirements(value), [value]);

  // De-noise the screen-reader strength announcement: instead of firing on every
  // keystroke, settle on the latest label after the owner pauses typing. The
  // setState lives inside the (async) timeout callback, never the effect body.
  const [announcedStrength, setAnnouncedStrength] = useState('');
  useEffect(() => {
    const id = setTimeout(() => {
      setAnnouncedStrength(value ? STRENGTH_LABELS[Math.min(strength, 4)] ?? '' : '');
    }, 600);
    return () => clearTimeout(id);
  }, [value, strength]);

  return (
    <>
      <Field
        label="Create a password"
        name="password"
        type="password"
        autoComplete="new-password"
        placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
        icon={<LockIcon />}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        minLength={MIN_PASSWORD_LENGTH}
        describedById={`${reqListId} ${strengthMsgId}`}
      />

      <ul className="rw-req-list" id={reqListId} aria-label="Password requirements">
        {requirements.map((req) => (
          <li key={req.label} className={req.met ? 'met' : ''}>
            {req.label}
            <span className="rw-sr-only">{req.met ? ' (met)' : ' (not yet met)'}</span>
          </li>
        ))}
      </ul>

      <div className="rw-strength" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`rw-strength-bar ${strength >= i ? `lit-${Math.min(strength, 4)}` : ''}`}
          />
        ))}
      </div>
      <div className="rw-strength-label" aria-hidden="true">
        {value ? STRENGTH_LABELS[Math.min(strength, 4)] : 'Pick something memorable but tough.'}
      </div>
      {/* Single debounced live region so SRs hear strength once typing settles,
          not on every keystroke. The visible label above is decorative. */}
      <div id={strengthMsgId} className="rw-sr-only" aria-live="polite">
        {announcedStrength ? `Password strength: ${announcedStrength}` : ''}
      </div>
    </>
  );
}
