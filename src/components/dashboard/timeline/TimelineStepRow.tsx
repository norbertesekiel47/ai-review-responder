import type { AgentPersona } from '@/lib/agents/run-spine';
import type { ReviewTimelineStep } from '@/lib/agents/read';

const PERSONA_LABELS: Record<AgentPersona, string> = {
  reply: 'Reply',
  guardian: 'Guardian',
  insights: 'Insights',
  system: 'System',
};

export function PersonaMark({ persona }: { persona: AgentPersona }) {
  return (
    <span className={`timeline-persona timeline-persona--${persona}`}>
      <span className="timeline-persona__icon" aria-hidden="true">
        <PersonaIcon persona={persona} />
      </span>
      <span className="timeline-step__persona-label">{PERSONA_LABELS[persona]}</span>
    </span>
  );
}

export function TimelineStepRow({ step }: { step: ReviewTimelineStep }) {
  const facts = safeFactsForStep(step.stepKey, step.detail);

  return (
    <li className={`timeline-step timeline-step--${step.status}`}>
      <span className="timeline-step__rail-marker" aria-hidden="true" />
      <div className="timeline-step__body">
        <div className="timeline-step__header">
          <PersonaMark persona={step.attributedAgent} />
          <h3>{formatIdentifier(step.stepKey)}</h3>
          <span className="timeline-step__time">{formatTimestamp(step.createdAt)}</span>
        </div>
        {facts.length > 0 && (
          <dl className="timeline-step__facts" aria-label={`${formatIdentifier(step.stepKey)} facts`}>
            {facts.map((fact) => (
              <div key={fact.key} className="timeline-step__fact">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {step.latencyMs != null && (
          <span className="timeline-step__latency">{step.latencyMs.toLocaleString()} ms</span>
        )}
      </div>
    </li>
  );
}

export function formatIdentifier(value: string): string {
  const words = value.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type FactSpec = {
  key: string;
  label: string;
  kind: 'boolean' | 'count' | 'date' | 'identifier' | 'enum';
  allowed?: readonly string[];
};

type SafeFact = { key: string; label: string; value: string };

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

function safeFactsForStep(stepKey: string, detail: Record<string, unknown>): SafeFact[] {
  const specs = STEP_FACTS[stepKey] ?? [];
  const facts: SafeFact[] = [];
  for (const spec of specs) {
    const value = safeFactValue(spec, detail[spec.key]);
    if (value != null) facts.push({ key: spec.key, label: spec.label, value });
  }
  return facts;
}

function safeFactValue(spec: FactSpec, value: unknown): string | null {
  if (spec.kind === 'boolean') return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : null;
  if (spec.kind === 'count') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value.toLocaleString()
      : null;
  }
  if (spec.kind === 'enum') {
    return typeof value === 'string' && spec.allowed?.includes(value)
      ? formatIdentifier(value)
      : null;
  }
  if (spec.kind === 'date') {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  }
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
    ? value
    : null;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function PersonaIcon({ persona }: { persona: AgentPersona }) {
  if (persona === 'reply') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M5 6.5h14v9H9l-4 3v-12Z" />
        <path d="M8.5 10h7M8.5 13h4" />
      </svg>
    );
  }
  if (persona === 'guardian') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M12 3.5 19 6v5.2c0 4.2-2.9 7.6-7 9.3-4.1-1.7-7-5.1-7-9.3V6l7-2.5Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    );
  }
  if (persona === 'insights') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M5 19V9M10 19V5M15 19v-7M20 19V3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 8v4l2.5 2" />
    </svg>
  );
}
