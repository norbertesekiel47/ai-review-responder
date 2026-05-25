export interface PhiDetection {
  matched: boolean;
  reasons: string[];
}

const PATTERNS: Array<{ reason: string; regex: RegExp }> = [
  { reason: 'mrn', regex: /\b(MRN|medical record number)\s*[:#-]?\s*\d{4,}\b/i },
  { reason: 'patient_context', regex: /\b(patient|diagnosis|treatment|prescription|medication)\b/i },
  { reason: 'condition_context', regex: /\b(diabetes|cancer|therapy|surgery|x-ray|xray|mri|ct scan)\b/i },
  { reason: 'insurance_identifier', regex: /\b(member id|policy number|insurance id)\s*[:#-]?\s*[a-z0-9-]{4,}\b/i },
];

export function detectLikelyPhi(text: string | null | undefined): PhiDetection {
  const value = text ?? '';
  const reasons = PATTERNS
    .filter((pattern) => pattern.regex.test(value))
    .map((pattern) => pattern.reason);

  return { matched: reasons.length > 0, reasons };
}

export function redactPhiForLog(_text: string | null | undefined): string {
  return '[redacted-review-text]';
}
