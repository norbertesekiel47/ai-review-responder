import { PASSWORD_RULES } from '@/lib/shared/password-rules';

export const STRENGTH_LABELS = [
  'Too short',
  'Getting there',
  'Decent',
  'Strong',
  'Excellent',
] as const;

export function strengthOf(pwd: string): number {
  if (!pwd) return 0;
  let s = 0;
  if (pwd.length >= 8) s++;
  if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) s++;
  if (/\d/.test(pwd)) s++;
  if (/[^A-Za-z0-9]/.test(pwd) && pwd.length >= 10) s++;
  return s;
}

export interface PasswordRequirement {
  label: string;
  met: boolean;
}

/**
 * The ENFORCED rules, surfaced to the user BEFORE submit — derived from
 * `PASSWORD_RULES` rather than re-spelled (#1090).
 *
 * The old hand-written list carried "Upper & lowercase letters" and "A number"
 * as requirements while `passwordSchema` enforced neither. It has one job now:
 * show the rules the server will apply. Mixed case and symbols stay in
 * `strengthOf` above, where they are advice that never rejects anything.
 */
export function passwordRequirements(pwd: string): PasswordRequirement[] {
  return PASSWORD_RULES.map((rule) => ({ label: rule.label, met: rule.test(pwd) }));
}
