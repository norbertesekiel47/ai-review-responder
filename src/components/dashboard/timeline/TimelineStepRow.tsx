import type { AgentPersona } from '@/lib/agents/run-spine';
import type { ReviewTimelineStep } from '@/lib/agents/read';
import { describeStep, safeFactsForStep, stepStatusLabel } from './step-facts';

const STEP_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

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

/**
 * One step of a run, in the owner's words (UX audit D19/D20): a plain label
 * and a one-sentence explanation from `describeStep`, a TEXT chip for a step
 * that failed or was skipped (the rail dot alone only differed by colour), and
 * the allowlisted facts. No identifiers and no latency — those read as a debug
 * trace and say nothing about the decision.
 */
export function TimelineStepRow({ step }: { step: ReviewTimelineStep }) {
  const copy = describeStep(step.stepKey);
  const facts = safeFactsForStep(step.stepKey, step.detail);
  const statusLabel = stepStatusLabel(step);

  return (
    <li className={`timeline-step timeline-step--${step.status}`}>
      <span className="timeline-step__rail-marker" aria-hidden="true" />
      <div className="timeline-step__body">
        <div className="timeline-step__header">
          <PersonaMark persona={step.attributedAgent} />
          <h3>{copy.label}</h3>
          {statusLabel !== null && (
            <span
              className={`timeline-run-state timeline-step__status timeline-run-state--${
                step.status === 'failed' ? 'failed' : 'cancelled'
              }`}
            >
              {statusLabel}
            </span>
          )}
          <span className="timeline-step__time">{formatTimestamp(step.createdAt)}</span>
        </div>
        {copy.explain !== null && <p className="timeline-step__explain">{copy.explain}</p>}
        {facts.length > 0 && (
          <dl className="timeline-step__facts" aria-label={`${copy.label} details`}>
            {facts.map((fact) => (
              <div key={fact.key} className="timeline-step__fact">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

function formatTimestamp(value: string): string {
  return STEP_TIMESTAMP_FORMATTER.format(new Date(value));
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
