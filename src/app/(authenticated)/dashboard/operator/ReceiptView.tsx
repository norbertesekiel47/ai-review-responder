'use client';

import type { Receipt } from '@/lib/agents/operator/schema';
import { AFFECTS_FUTURE_DRAFTS } from './wording';
import './operator.css';

export interface ReceiptViewProps {
  receipt: Receipt;
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
export function ReceiptView({ receipt, locationLabel }: ReceiptViewProps) {
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
        <dd className="op-diff-value">{receipt.operation}</dd>
        <dt className="op-kv-label">Location</dt>
        <dd className="op-diff-value">{locationLabel(receipt.scope.locationId)}</dd>
        <dt className="op-kv-label">Applied at</dt>
        <dd className="op-diff-value">
          <time dateTime={receipt.appliedAt}>{new Date(receipt.appliedAt).toLocaleString()}</time>
        </dd>
        <dt className="op-kv-label">Applied by</dt>
        <dd className="op-diff-value">{receipt.actorUserId}</dd>
        <dt className="op-kv-label">You asked</dt>
        {/* VERBATIM owner text, as the server stored it (spec §6.5). */}
        <dd className="op-diff-value">{receipt.ownerText}</dd>
        <dt className="op-kv-label">Reference</dt>
        <dd className="op-diff-value">{receipt.turnId}</dd>
      </dl>
    </div>
  );
}

/** The five voice fields, each labelled. `null` and `[]` read as "not set". */
function VoiceStateLines({ state }: { state: Receipt['before'] }) {
  const rows: Array<[string, string]> = [
    ['Tone', state.tone ?? 'Not set'],
    ['Products and services', state.productsServices ?? 'Not set'],
    ['Keep out of replies', state.avoidFacts.length === 0 ? 'Nothing' : state.avoidFacts.join('; ')],
    ['Highlight when it fits', state.highlightFacts.length === 0 ? 'Nothing' : state.highlightFacts.join('; ')],
    ['Sample replies', state.sampleResponses.length === 0 ? 'None' : `${state.sampleResponses.length} saved`],
  ];
  return (
    <>
      {rows.map(([label, value]) => (
        <span key={label} className="op-diff-value">
          <span className="op-kv-label">{label}: </span>
          {value}
        </span>
      ))}
    </>
  );
}
