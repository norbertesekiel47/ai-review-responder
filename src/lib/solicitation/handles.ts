/**
 * Normalized handle — the canonical Contact identifier (#535 contract §1.1/§6).
 * Computed ONCE at CSV ingest and stored; every downstream join (dedupe, the
 * future suppression ledger) is a plain equality on the stored value. The
 * suppression ledger keys on the normalized handle per channel, NEVER on
 * contact_id — delete + re-upload must not un-suppress an opted-out person.
 */

const EMAIL_PLAUSIBLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercased/trimmed email, or null when syntax is implausible. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 320 || !EMAIL_PLAUSIBLE.test(email)) return null;
  return email;
}

/** E.164 phone (10-digit numbers assume US), or null when unparseable.
 *  Letters anywhere reject (codex finding 11): silently normalizing
 *  "ext. 4155552671"-style junk would mint a wrong handle; a visible
 *  invalid_phone row in the report is safer than a wrong identity. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /[a-z]/i.test(trimmed)) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
