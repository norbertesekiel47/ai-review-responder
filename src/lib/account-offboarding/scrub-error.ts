/**
 * Single owner for offboarding error-string redaction before persistence
 * (`last_error`, Sentry `extra`, rethrown messages). Object-shaped payloads use
 * the Sentry scrubber (`src/lib/shared/sentry-scrub.ts`); this is the string path.
 *
 * The pattern set is the union of every redaction that previously lived inline
 * in the purge / teardown / billing / email workers, so it is at least as strong
 * as each former copy. Keep this the only definition — drift between copies is
 * how a secret leaks into stored error text.
 */
const SECRET_KEY_GROUP =
  'access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|token|secret';

export function scrubOffboardingErrorForStorage(message: string): string {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\+?[0-9][0-9().\-\s]{7,}[0-9]/g, '[REDACTED_PHONE]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, 'Basic [REDACTED]')
    .replace(new RegExp(`((?:${SECRET_KEY_GROUP}))=([^&\\s"']+)`, 'gi'), '$1=[REDACTED]')
    .replace(new RegExp(`("?(?:${SECRET_KEY_GROUP})"?\\s*:\\s*)"[^"]*"`, 'gi'), '$1"[REDACTED]"')
    .replace(new RegExp(`('(?:${SECRET_KEY_GROUP})'\\s*:\\s*)'[^']*'`, 'gi'), "$1'[REDACTED]'")
    .slice(0, 500);
}
