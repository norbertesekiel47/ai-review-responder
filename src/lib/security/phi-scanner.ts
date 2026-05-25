export interface PhiDetection {
  matched: boolean;
  reasons: string[];
}

const IDENTIFIER_PATTERNS: Array<{ reason: string; regex: RegExp }> = [
  { reason: 'mrn', regex: /\b(MRN|medical record number)\s*[:#-]?\s*\d{4,}\b/i },
  { reason: 'insurance_identifier', regex: /\b(member id|policy number|insurance id)\s*[:#-]?\s*[a-z0-9-]{4,}\b/i },
];

const SELF_REFERENCE = /\b(i|me|my|mine|we|us|our|ours)\b/i;
const MEDICAL_CONTEXT =
  /\b(diagnosis|prescription|medication|diabetes|cancer|surgery|x-ray|xray|mri|ct scan)\b/i;

export function detectLikelyPhi(text: string | null | undefined): PhiDetection {
  const value = text ?? '';
  const reasons = IDENTIFIER_PATTERNS
    .filter((pattern) => pattern.regex.test(value))
    .map((pattern) => pattern.reason);

  if (SELF_REFERENCE.test(value) && MEDICAL_CONTEXT.test(value)) {
    reasons.push('self_referenced_medical_context');
  }

  return { matched: reasons.length > 0, reasons };
}

export function redactPhiForLog(_text: string | null | undefined): string {
  return '[redacted-review-text]';
}
