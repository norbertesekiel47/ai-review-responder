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
