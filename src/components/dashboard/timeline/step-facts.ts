import { formatIdentifier } from './format';

type FactKind = 'boolean' | 'count' | 'date' | 'identifier' | 'enum';

type FactSpec = {
  key: string;
  label: string;
  kind: FactKind;
  allowed?: readonly string[];
};

export type SafeStepFact = { key: string; label: string; value: string };

const STEP_FACTS: Readonly<Record<string, readonly FactSpec[]>> = {
  draft_generated: [
    { key: 'response_id', label: 'Response id', kind: 'identifier' },
    { key: 'version', label: 'Version', kind: 'count' },
  ],
  moderation_checked: [
    { key: 'flagged', label: 'Flagged', kind: 'boolean' },
    { key: 'severity', label: 'Severity', kind: 'enum', allowed: ['low', 'medium', 'high'] },
    { key: 'held', label: 'Held', kind: 'boolean' },
  ],
  policy_gate: [
    { key: 'decision', label: 'Decision', kind: 'enum', allowed: ['auto_approved', 'held_for_owner'] },
  ],
  triage: [
    { key: 'severity', label: 'Severity', kind: 'enum', allowed: ['low', 'medium', 'high'] },
    {
      key: 'suggested_action',
      label: 'Suggested action',
      kind: 'enum',
      allowed: ['respond', 'escalate', 'respond_and_escalate'],
    },
  ],
  escalation_raised: [
    { key: 'severity', label: 'Severity', kind: 'enum', allowed: ['low', 'medium', 'high'] },
    {
      key: 'suggested_action',
      label: 'Suggested action',
      kind: 'enum',
      allowed: ['respond', 'escalate', 'respond_and_escalate'],
    },
    { key: 'escalation_id', label: 'Escalation id', kind: 'identifier' },
  ],
  escalation_sent: [
    { key: 'escalation_id', label: 'Escalation id', kind: 'identifier' },
    { key: 'sent', label: 'Sent', kind: 'count' },
    { key: 'skipped', label: 'Skipped', kind: 'count' },
    { key: 'terminal_failed', label: 'Terminal failed', kind: 'count' },
  ],
  reply_posted: [
    { key: 'response_id', label: 'Response id', kind: 'identifier' },
    { key: 'approval_method', label: 'Approval method', kind: 'enum', allowed: ['owner', 'auto_policy'] },
  ],
  digest_sent: [
    { key: 'week_start_date', label: 'Week start date', kind: 'date' },
    { key: 'business_id', label: 'Business id', kind: 'identifier' },
  ],
};

type FactFormatter = (value: unknown, spec: FactSpec) => string | null;

const FACT_FORMATTERS: Record<FactKind, FactFormatter> = {
  boolean: (value) => typeof value === 'boolean' ? (value ? 'Yes' : 'No') : null,
  count: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString()
    : null,
  enum: (value, spec) => typeof value === 'string' && spec.allowed?.includes(value)
    ? formatIdentifier(value)
    : null,
  date: (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null,
  identifier: (value) => typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
    ? value
    : null,
};

export function safeFactsForStep(
  stepKey: string,
  detail: Record<string, unknown>,
): SafeStepFact[] {
  return (STEP_FACTS[stepKey] ?? []).flatMap((spec) => {
    const value = FACT_FORMATTERS[spec.kind](detail[spec.key], spec);
    return value === null ? [] : [{ key: spec.key, label: spec.label, value }];
  });
}
