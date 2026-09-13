'use client';

import type { Receipt, VoiceState } from '@/lib/agents/operator/schema';
import { AFFECTS_FUTURE_DRAFTS, AFFECTS_FUTURE_ELIGIBLE_REVIEWS, READINESS_WORDING, VOICE_FIELD_LABELS } from './wording';
import { PolicyStateDetail } from './PolicyStateDetail';
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
        {receipt.effectiveNow ? 'Effective now.' : 'Scheduled.'} {receipt.affects === 'future_drafts' ? AFFECTS_FUTURE_DRAFTS : AFFECTS_FUTURE_ELIGIBLE_REVIEWS}
      </p>

      <ReceiptDiff receipt={receipt} />
      {receipt.affects === 'future_eligible_reviews' && <PolicyReceiptConsequences receipt={receipt} />}

      {receipt.differsFromPreview && (
        <p className="op-note">
          The saved result is not exactly what the plan previewed. What is shown under
          &ldquo;After&rdquo; is the state that was actually saved.
        </p>
      )}
      <ReceiptReadiness receipt={receipt} />
      <ReceiptRecord receipt={receipt} describe={describe} locationLabel={locationLabel} />
    </div>
  );
}

function ReceiptDiff({ receipt }: Pick<ReceiptViewProps, 'receipt'>) {
  return <div className="op-diff">
    <div className="op-diff-col">
      <span className="op-kv-label">Before</span>
      {receipt.affects === 'future_drafts' ? <VoiceStateLines state={receipt.before} /> : <PolicyStateDetail state={receipt.before} account={receipt.scope.locationId === null} />}
    </div>
    <div className="op-diff-col">
      <span className="op-kv-label">After</span>
      {receipt.affects === 'future_drafts' ? <VoiceStateLines state={receipt.after} /> : <PolicyStateDetail state={receipt.after} account={receipt.scope.locationId === null} />}
    </div>
  </div>;
}

function PolicyReceiptConsequences({ receipt }: {
  receipt: Extract<Receipt, { affects: 'future_eligible_reviews' }>;
}) {
  return <>
    <p className="op-body">Old rule: {receipt.before.consequence.eligible} of {receipt.before.consequence.total} eligible; new rule: {receipt.after.consequence.eligible} of {receipt.after.consequence.total} eligible.</p>
    <p className="op-note">Reviews received {receipt.after.consequence.windowStart.slice(0, 10)} to {receipt.after.consequence.windowEnd.slice(0, 10)}. Excluded {receipt.after.consequence.excludedImported} imported reviews and {receipt.after.consequence.excludedUnknown} reviews whose origin is unknown.</p>
    <p className="op-body">{receipt.retainedVeto.count} drafts keep their granted veto window.</p>
    <p className="op-asof">Counted as of <time dateTime={receipt.retainedVeto.asOf}>{new Date(receipt.retainedVeto.asOf).toLocaleString()}</time>.</p>
    {receipt.scope.locationId === null && <p className="op-note">Affected {receipt.after.affectedLocationCount} locations inheriting the account default.</p>}
  </>;
}

function ReceiptReadiness({ receipt }: Pick<ReceiptViewProps, 'receipt'>) {
  if (receipt.remainingBlocked.length === 0) return null;
  return <ul className="op-readiness">{receipt.affects === 'future_eligible_reviews'
    ? receipt.remainingBlocked.map((reason) => <li key={reason}>{READINESS_WORDING[reason]}</li>)
    : receipt.remainingBlocked.map((reason) => <li key={reason}>{reason}</li>)}</ul>;
}

/** Immutable who/where/when and the owner's original instruction. */
function ReceiptRecord({ receipt, describe, locationLabel }: ReceiptViewProps) {
  return <dl className="op-kv op-facts">
    <dt className="op-kv-label">Change</dt>
    <dd className="op-diff-value">{describe}</dd>
    <dt className="op-kv-label">Location</dt>
    <dd className="op-diff-value">{receipt.scope.locationId === null ? 'Account default' : locationLabel(receipt.scope.locationId)}</dd>
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
  </dl>;
}

/**
 * The five voice fields, each labelled from the SHARED vocabulary and in the
 * shared order (F4). Every field reads the same way it does on the card that
 * proposed the change — including the sample replies, which this component
 * used to reduce to "3 saved" while the card listed them, so the Receipt and
 * the preview described different things. `null` and `[]` read as "not set".
 */
function VoiceStateLines({ state }: { state: VoiceState }) {
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
