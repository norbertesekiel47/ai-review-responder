import type {
  InvalidLeadIntakeField,
  LeadIntakeField,
  LeadIntakePayload,
  LeadIntakeValidationResult,
} from './LeadIntakeForm';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function submitLeadIntake(payload: LeadIntakePayload): Promise<Response> {
  return fetch('/api/lead-intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function validateLeadIntakeFields({
  name,
  email,
  businessName,
}: Pick<LeadIntakePayload, 'name' | 'email' | 'businessName'>): LeadIntakeValidationResult {
  if (!name.trim()) {
    return { message: 'Please enter your name.', invalidField: 'name' };
  }

  if (!EMAIL_RE.test(email.trim())) {
    return {
      message: 'Please enter a valid email address.',
      invalidField: 'email',
    };
  }

  if (!businessName.trim()) {
    return { message: 'Please enter your business name.', invalidField: 'businessName' };
  }

  return null;
}

export function getLeadIntakeFieldErrorProps(
  field: LeadIntakeField,
  invalidField: InvalidLeadIntakeField | null,
  errorId: string,
) {
  if (field !== invalidField) return {};

  return {
    'aria-invalid': true,
    'aria-describedby': errorId,
  };
}
