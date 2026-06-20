import type {
  LeadIntakeField,
  LeadIntakeFieldErrors,
  LeadIntakePayload,
} from './LeadIntakeForm';
import { LEAD_INTAKE_HONEYPOT_FIELD } from '@/lib/shared/schemas';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function submitLeadIntake({ honeypot, ...payload }: LeadIntakePayload): Promise<Response> {
  return fetch('/api/lead-intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Re-key the honeypot to the canonical server field name so the server-side
    // bot check (data[LEAD_INTAKE_HONEYPOT_FIELD]) actually receives it.
    body: JSON.stringify({ ...payload, [LEAD_INTAKE_HONEYPOT_FIELD]: honeypot }),
  });
}

/**
 * Validates every field at once and returns a per-field error map. An empty map
 * means the form is valid. The Maps URL is optional, but when present it must be
 * a syntactically valid https URL — mirroring the server's https-only check so
 * the user gets inline feedback before submitting.
 */
export function validateLeadIntakeFields({
  name,
  email,
  businessName,
  googleMapsUrl,
}: Pick<
  LeadIntakePayload,
  'name' | 'email' | 'businessName' | 'googleMapsUrl'
>): LeadIntakeFieldErrors {
  const errors: LeadIntakeFieldErrors = {};

  if (!name.trim()) {
    errors.name = 'Please enter your name.';
  }

  if (!EMAIL_RE.test(email.trim())) {
    errors.email = 'Please enter a valid email address.';
  }

  if (!businessName.trim()) {
    errors.businessName = 'Please enter your business name.';
  }

  const url = googleMapsUrl.trim();
  if (url && !isHttpsUrl(url)) {
    errors.googleMapsUrl = 'Please enter a valid https link.';
  }

  return errors;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function hasFieldErrors(errors: LeadIntakeFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

const FIELD_ORDER: readonly LeadIntakeField[] = [
  'name',
  'email',
  'businessName',
  'googleMapsUrl',
];

/** First invalid field in DOM order, so submit-failure focus is predictable. */
export function firstInvalidField(
  errors: LeadIntakeFieldErrors,
): LeadIntakeField | null {
  return FIELD_ORDER.find((field) => errors[field]) ?? null;
}

export function getLeadIntakeFieldErrorProps(
  field: LeadIntakeField,
  errors: LeadIntakeFieldErrors,
  errorId: string,
) {
  if (!errors[field]) return {};

  return {
    'aria-invalid': true as const,
    'aria-describedby': errorId,
  };
}
