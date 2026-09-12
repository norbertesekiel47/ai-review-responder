'use client';

import type { Receipt } from '@/lib/agents/operator/schema';
import { AFFECTS_FUTURE_DRAFTS, VOICE_FIELD_LABELS } from './wording';
import './operator.css';

/** Who the Receipt names when the actor's row carried no name (S5 / F10). */
const UNNAMED_ACTOR = 'Account owner';

export interface ReceiptViewProps {
  receipt: Receipt;
  /**
   * The operation IN PLAIN WORDS — the catalog describer the card's own
   * heading uses. The Receipt stores `operation`, which is the catalog id
   * (`set_tone`), and the one document §6.5 says "establishes that something
   * changed" must not describe the change with an identifier the owner has
   * never seen anywhere else in the product (S4).
   */
  describe: string;
  locationLabel: (locationId: string) => string;
}

/**
 * The **Receipt**, rendered from the stored JSONB and nothing else.
 *
 * Only the Receipt establishes that something changed (spec §6.5), so every
 * field here is a passthrough of what the server wrote inside the mutation's
 * transaction. Nothing on this component recomputes a value, reads a live
 * count, or formats a number the server did not produce.
 */
export function ReceiptView({ receipt, describe, locationLabel }: ReceiptViewProps) {
  return (
    <div className="op-receipt">
      <p className="op-state-line">
        {receipt.effectiveNow ? 'Effective now.' : 'Scheduled.'} {AFFECTS_FUTURE_DRAFTS}
      </p>

      <div className="op-diff">
        <div className="op-diff-col">
          <span className="op-kv-label">Before</span>
          <VoiceStateLines state={receipt.before} />
        </div>
        <div className="op-diff-col">
          <span className="op-kv-label">After</span>
          <VoiceStateLines state={receipt.after} />
        </div>
      </div>

      {receipt.differsFromPreview && (
        <p className="op-note">
          The saved result is not exactly what the plan previewed. What is shown under
          &ldquo;After&rdquo; is the state that was actually saved.
        </p>
      )}

      {receipt.remainingBlocked.length > 0 && (
        <p className="op-note">Still blocked: {receipt.remainingBlocked.join(', ')}.</p>
      )}

      {/* The record half of the Receipt: what ran, where, when, by whom, from
          which instruction, under which correlation id.

          `Applied at` and `Applied by`, never a bare `Applied` — the card's
          own state line is already exactly that word, and a second node
          reading it makes the screen ambiguous about which one is the status
          and which one is a row label. */}
      <dl className="op-kv op-facts">
        <dt className="op-kv-label">Change</dt>
        <dd className="op-diff-value">{describe}</dd>
        <dt className="op-kv-label">Location</dt>
        <dd className="op-diff-value">{locationLabel(receipt.scope.locationId)}</dd>
        <dt className="op-kv-label">Applied at</dt>
        <dd className="op-diff-value">
          <time dateTime={receipt.appliedAt}>{new Date(receipt.appliedAt).toLocaleString()}</time>
        </dd>
        {/* THE PERSON, not the database key. `actorName` is server-written
            under the same lock as `actorUserId` and frozen at the Apply, so a
            later rename cannot rewrite history; the uuid never reaches the
            screen (S5 / F10). `Reference` below stays the turn id — §6.5 calls
            it a correlation id, and a support reference is legitimately
            opaque. */}
        <dt className="op-kv-label">Applied by</dt>
        <dd className="op-diff-value">{receipt.actorName ?? UNNAMED_ACTOR}</dd>
        <dt className="op-kv-label">You asked</dt>
        {/* VERBATIM owner text, as the server stored it (spec §6.5). */}
        <dd className="op-diff-value">{receipt.ownerText}</dd>
        <dt className="op-kv-label">Reference</dt>
        <dd className="op-diff-value">{receipt.turnId}</dd>
      </dl>
    </div>
  );
}

/**
 * The five voice fields, each labelled from the SHARED vocabulary and in the
 * shared order (F4). Every field reads the same way it does on the card that
 * proposed the change — including the sample replies, which this component
 * used to reduce to "3 saved" while the card listed them, so the Receipt and
 * the preview described different things. `null` and `[]` read as "not set".
 */
function VoiceStateLines({ state }: { state: Receipt['before'] }) {
  const line = (field: (typeof VOICE_FIELD_LABELS)[number]['field']): string => {
    const value = state[field];
    if (value === null) return 'Not set';
    if (typeof value === 'string') return value;
    return value.length === 0 ? 'Nothing' : value.join('; ');
  };
  return (
    <>
      {VOICE_FIELD_LABELS.map(({ field, label }) => (
        <span key={field} className="op-diff-value">
          <span className="op-kv-label">{label}: </span>
          {line(field)}
        </span>
      ))}
    </>
  );
}
