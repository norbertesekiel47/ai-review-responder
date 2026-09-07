import type { AgentStepKey } from '@/lib/agents/run-spine';
import type { ReviewTimelineStep } from '@/lib/agents/read';
import { formatIdentifier } from './format';

// ── Owner-facing step vocabulary (UX audit D19) ─────────────────────────────
//
// The timeline is the page that answers "why was this held?", so every step
// carries a plain-language label and a one-sentence explanation. Total over
// `AgentStepKey` (`satisfies`) so a new step key fails typecheck here instead
// of rendering as a de-snake-cased database word. The wire still carries
// `stepKey: string`; `describeStep` falls back to `formatIdentifier` for a key
// this build does not know.

export interface StepCopy {
  label: string;
  explain: string;
  /** What a `failed` status means for THIS step, when "Failed" would mislead —
   *  a safety check that held the draft did its job. */
  failedLabel?: string;
}

const STEP_COPY = {
  review_ingested: {
    label: 'Review received',
    explain: 'We picked up this review from Google.',
  },
  review_updated: {
    label: 'Review changed',
    explain: 'The customer edited their review, so earlier work on it was set aside.',
  },
  triage: {
    label: 'Guardian check',
    explain: 'Guardian read the review and judged how urgent it is.',
    failedLabel: 'Used a fallback',
  },
  escalation_raised: {
    label: 'Flagged for you',
    explain: 'Guardian decided this review needs your attention.',
  },
  escalation_sent: {
    label: 'You were notified',
    explain: 'We sent the flag to your notification channels.',
  },
  draft_generated: {
    // Not "Reply drafted": that is the OUTCOME chip's wording on the same card.
    label: 'Draft written',
    explain: 'Reply wrote a draft in your voice.',
  },
  moderation_checked: {
    label: 'Safety check',
    explain: 'The draft was checked for anything unsafe before it could go anywhere.',
    failedLabel: 'Did not pass',
  },
  policy_gate: {
    label: 'Approval decision',
    explain: 'Whether the draft could post on its own under your Autopilot policy, or needed you.',
  },
  owner_notified: {
    label: 'Sent to you',
    explain: 'We asked you to approve the draft.',
  },
  reply_posted: {
    label: 'Reply posted',
    explain: 'The reply went live on Google.',
  },
  digest_sent: {
    label: 'Weekly digest sent',
    explain: 'Insights sent your weekly summary.',
  },
  ask_evaluated: {
    label: 'Request considered',
    explain: 'We checked whether this customer should be asked for a review.',
  },
  batch_built: {
    label: 'Batch built',
    explain: 'The set of review requests for this round was assembled.',
  },
  ask_generated: {
    label: 'Request written',
    explain: 'The review request message was written.',
  },
  send_batch_closed: {
    label: 'Batch closed',
    explain: 'This round of review requests finished.',
  },
  batch_approved: {
    label: 'Batch approved',
    explain: 'The review requests were cleared to send.',
  },
  batch_halted: {
    label: 'Batch stopped',
    explain: 'The review requests were stopped before sending.',
  },
  ask_regeneration_requested: {
    label: 'New version requested',
    explain: 'A fresh version of the request message was asked for.',
  },
  ask_withdrawn: {
    label: 'Request withdrawn',
    explain: 'This review request was taken out of the batch.',
  },
  dispatch_gate_evaluated: {
    label: 'Send check',
    explain: 'A final check before a review request went out.',
  },
  ask_sent: {
    label: 'Request sent',
    explain: 'The review request was sent to the customer.',
  },
  approval_downgraded: {
    label: 'Approval paused',
    explain: 'Automatic approval was paused, so this went to you instead.',
  },
  veto_window_granted: {
    label: 'Stop window opened',
    explain: 'You were given a window to stop this before it sent.',
  },
} as const satisfies Record<AgentStepKey, StepCopy>;

export function describeStep(stepKey: string): StepCopy | { label: string; explain: null } {
  const copy = (STEP_COPY as Record<string, StepCopy | undefined>)[stepKey];
  return copy ?? { label: formatIdentifier(stepKey), explain: null };
}

/** The text chip beside a step that did not complete (UX audit D20) — a word,
 *  not an 11px dot colour. */
export function stepStatusLabel(step: Pick<ReviewTimelineStep, 'stepKey' | 'status'>): string | null {
  if (step.status === 'completed') return null;
  if (step.status === 'skipped') return 'Skipped';
  const copy = (STEP_COPY as Record<string, StepCopy | undefined>)[step.stepKey];
  return copy?.failedLabel ?? 'Failed';
}

// ── The run's decision headline ─────────────────────────────────────────────

const DECISION_HEADLINES = {
  held_by_safety_check: 'Held back by the safety check. Nothing was posted.',
  held_for_owner: 'Sent to you for approval. Nothing posts until you say so.',
  auto_approved:
    'Approved automatically under your Autopilot policy, with a window for you to stop it.',
  review_changed: 'The customer changed their review, so the earlier draft was set aside.',
  approval_paused: 'Automatic approval was paused, so this went to you instead.',
} as const;

/**
 * The one sentence a run owes the owner before its step list: the held or
 * veto decision it reached (D19). Read from the SAME stored step details the
 * facts render — never re-derived from statuses — and the LAST decision in
 * step order wins, because a run that was held and then sent to you should
 * headline the hand-off, not the hold. Null when the run made no such decision.
 */
export function runDecisionHeadline(steps: readonly ReviewTimelineStep[]): string | null {
  let headline: string | null = null;
  for (const step of steps) {
    if (step.stepKey === 'moderation_checked' && step.detail['held'] === true) {
      headline = DECISION_HEADLINES.held_by_safety_check;
    } else if (step.stepKey === 'policy_gate') {
      const decision = step.detail['decision'];
      if (decision === 'held_for_owner') headline = DECISION_HEADLINES.held_for_owner;
      else if (decision === 'auto_approved') headline = DECISION_HEADLINES.auto_approved;
    } else if (step.stepKey === 'approval_downgraded') {
      headline = DECISION_HEADLINES.approval_paused;
    } else if (step.stepKey === 'review_updated') {
      headline = DECISION_HEADLINES.review_changed;
    }
  }
  return headline;
}

// ── Safe structured facts ───────────────────────────────────────────────────
//
// An allowlist, per step, of the detail keys that may render — and how. The
// detail JSON can carry customer prose and provider payloads; nothing outside
// this table reaches the DOM. Identifiers (response/escalation/business ids)
// and latencies are deliberately NOT facts: they read as a debug trace to the
// owner (D19) and say nothing about the decision.

type FactKind = 'boolean' | 'count' | 'date' | 'enum';

type FactSpec = {
  key: string;
  label: string;
  kind: FactKind;
  allowed?: readonly string[];
  /** Owner-facing wording per allowed enum value; `formatIdentifier` otherwise. */
  valueLabels?: Readonly<Record<string, string>>;
};

export type SafeStepFact = { key: string; label: string; value: string };

const SEVERITY = ['low', 'medium', 'high'] as const;
const SUGGESTED_ACTION: FactSpec = {
  key: 'suggested_action',
  label: 'Guardian suggested',
  kind: 'enum',
  allowed: ['respond', 'escalate', 'respond_and_escalate'],
  valueLabels: {
    respond: 'Reply',
    escalate: 'Flag it for you',
    respond_and_escalate: 'Reply and flag it for you',
  },
};

const STEP_FACTS: Readonly<Record<string, readonly FactSpec[]>> = {
  moderation_checked: [
    { key: 'flagged', label: 'Flagged', kind: 'boolean' },
    { key: 'severity', label: 'Severity', kind: 'enum', allowed: SEVERITY },
    { key: 'held', label: 'Held back', kind: 'boolean' },
  ],
  policy_gate: [
    {
      key: 'decision',
      label: 'Decision',
      kind: 'enum',
      allowed: ['auto_approved', 'held_for_owner'],
      valueLabels: { auto_approved: 'Approved automatically', held_for_owner: 'Sent to you' },
    },
  ],
  triage: [
    { key: 'severity', label: 'Severity', kind: 'enum', allowed: SEVERITY },
    SUGGESTED_ACTION,
  ],
  escalation_raised: [
    { key: 'severity', label: 'Severity', kind: 'enum', allowed: SEVERITY },
    SUGGESTED_ACTION,
  ],
  escalation_sent: [
    { key: 'sent', label: 'Notifications sent', kind: 'count' },
    { key: 'skipped', label: 'Skipped', kind: 'count' },
    { key: 'terminal_failed', label: 'Could not send', kind: 'count' },
  ],
  reply_posted: [
    {
      key: 'approval_method',
      label: 'Approved by',
      kind: 'enum',
      allowed: ['owner', 'auto_policy'],
      valueLabels: { owner: 'You', auto_policy: 'Your Autopilot policy' },
    },
  ],
  digest_sent: [
    { key: 'week_start_date', label: 'Week of', kind: 'date' },
  ],
};

type FactFormatter = (value: unknown, spec: FactSpec) => string | null;

const FACT_FORMATTERS: Record<FactKind, FactFormatter> = {
  boolean: (value) => typeof value === 'boolean' ? (value ? 'Yes' : 'No') : null,
  count: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString()
    : null,
  enum: (value, spec) => typeof value === 'string' && spec.allowed?.includes(value)
    ? spec.valueLabels?.[value] ?? formatIdentifier(value)
    : null,
  date: (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
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
