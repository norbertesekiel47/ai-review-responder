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

/** The minimum + scoring criteria, surfaced to the user BEFORE submit. */
export function passwordRequirements(pwd: string): PasswordRequirement[] {
  return [
    { label: 'At least 8 characters', met: pwd.length >= 8 },
    { label: 'Upper & lowercase letters', met: /[A-Z]/.test(pwd) && /[a-z]/.test(pwd) },
    { label: 'A number', met: /\d/.test(pwd) },
  ];
}
