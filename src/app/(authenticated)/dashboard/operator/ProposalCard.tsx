'use client';

import { Fragment } from 'react';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import { parseVoiceState } from '@/lib/agents/operator/schema';
import { ReceiptView } from './ReceiptView';
import {
  AFFECTS_FUTURE_DRAFTS,
  APPLY,
  NOT_NOW,
  OFFERS_REFRESH_PLAN,
  PROPOSAL_DECLINED,
  PROPOSAL_LABEL_APPLIED,
  PROPOSAL_LABEL_PENDING,
  PROPOSAL_SUPERSEDED,
  REFRESH_PLAN,
  VOICE_FIELD_LABELS,
  preparedForNote,
  proposalFailureSentence,
} from './wording';
import './operator.css';

export interface ProposalCardProps {
  proposal: ProposalView;
  /** The turn's STORED location — the card's target, never the selector (§3.3). */
  turnLocationId: string;
  /** How to name a location on screen. Supplied by the client, which owns the roster. */
  locationLabel: (locationId: string) => string;
  /** True when the browser's current scope is not the turn's location (D4). */
  scopeMoved: boolean;
  onApply: (proposal: ProposalView) => void;
  onDecline: (proposal: ProposalView) => void;
  onRefreshPlan: (proposal: ProposalView) => void;
  busy: boolean;
  error: string | null;
}

/**
 * One **Proposal** as a Harbor card, rendered ENTIRELY from the stored row.
 *
 * The target is the proposal's own `location_id`, falling back to the turn's
 * stored location — never the browser's current selector (spec §3.3). That is
 * the whole reason the note exists: the owner may be looking at the Cafe while
 * reading a plan prepared for the Salon, and a card that renamed itself to
 * match the selector would be describing a change it is not about to make.
 */
export function ProposalCard({
  proposal,
  turnLocationId,
  locationLabel,
  scopeMoved,
  onApply,
  onDecline,
  onRefreshPlan,
  busy,
  error,
}: ProposalCardProps) {
  const targetLocationId = proposal.locationId ?? turnLocationId;
  const headingId = `op-proposal-${proposal.id}`;
  const reasonId = `${headingId}-reason`;

  const before = parseVoiceState(proposal.before, 'agent_proposals.before');
  const after = parseVoiceState(proposal.after, 'agent_proposals.after');

  const pending = proposal.status === 'pending';
  const applied = proposal.status === 'applied';
  const refreshable =
    proposal.failureReason !== null && OFFERS_REFRESH_PLAN.has(proposal.failureReason);

  return (
    <section className="card op-card" aria-labelledby={headingId}>
      {/* THE §1 LABEL, above the headline where the owner reads it first: what
          KIND of thing this card is before they decide. Spec §1 lists it as
          the card's first element and exists to separate a rule the engine
          ENFORCES from a fact a workflow READS — a distinction the operation's
          describer cannot carry. The applied half is the state line below
          (S1). */}
      {!applied && (
        <span className="badge op-label-chip">{PROPOSAL_LABEL_PENDING[proposal.labelKind]}</span>
      )}
      <h2 className="card-h2" id={headingId}>{proposal.describe}</h2>

      <div className="op-kv">
        <span className="op-kv-label">This location</span>
        <span className="op-kv-value">{locationLabel(targetLocationId)}</span>
      </div>
      {scopeMoved && <p className="op-note">{preparedForNote(locationLabel(targetLocationId))}</p>}

      {/* EXACT before and after of the full voice state (spec §3.3, §6.1).
          Counts are not enough: replacing one avoided fact with a different
          one of the same length produced two identical-looking columns, and
          the owner approved replacement content they never saw. The catalog
          describer has the same limit ("Keep 3 thing(s) out of every reply",
          src/lib/agents/operator/catalog.ts:157-171), which is why the card
          does not lean on it for the values. */}
      <div className="op-diff">
        <div className="op-diff-col">
          <span className="op-kv-label">Now</span>
          <VoiceStateDetail state={before} other={after} side="before" />
        </div>
        <div className="op-diff-col">
          <span className="op-kv-label">After this change</span>
          <VoiceStateDetail state={after} other={before} side="after" />
        </div>
      </div>

      <p className="op-state-line">{AFFECTS_FUTURE_DRAFTS}</p>

      {/* THE APPLIED LABEL IS NOT CONDITIONAL ON THE RECEIPT. Apply writes the
          status and the Receipt in one transaction, so the two always travel
          together — but a row that somehow arrived applied without one must
          still SAY it was applied rather than render as a plan the owner has
          not decided yet. Every status below has a rendering for the same
          reason: a card with a headline and no state line is a card the owner
          cannot act on and cannot interpret. */}
      {applied && (
        <>
          {/* The APPLIED half of the §1 contract, in place of the bare word
              "Applied": after success the card names what it now IS — an
              Active rule, or a Remembered fact. */}
          <p className="op-state-line">{PROPOSAL_LABEL_APPLIED[proposal.labelKind]}</p>
          {proposal.receipt !== null && (
            <ReceiptView
              receipt={proposal.receipt}
              describe={proposal.describe}
              locationLabel={locationLabel}
            />
          )}
        </>
      )}

      {proposal.status === 'superseded' && <p className="op-state-line">{PROPOSAL_SUPERSEDED}</p>}

      {(proposal.status === 'stale'
        || proposal.status === 'rejected'
        || proposal.status === 'failed') && (
        <p className="op-state-line">
          {/* An owner decline stores NO reason (D5), so a `rejected` row with a
              null reason reads "Not applied" rather than as a failure. */}
          {proposal.status === 'rejected' && proposal.failureReason === null
            ? PROPOSAL_DECLINED
            : proposalFailureSentence(proposal.failureReason)}
        </p>
      )}

      {error !== null && (
        <p className="op-notice" id={reasonId} role="alert">{error}</p>
      )}

      {pending && (
        <div className="op-actions">
          <button
            type="button"
            className="btn btn-primary op-action"
            disabled={busy}
            aria-describedby={error !== null ? reasonId : undefined}
            onClick={() => onApply(proposal)}
          >
            {APPLY}
          </button>
          <button
            type="button"
            className="btn btn-secondary op-action"
            disabled={busy}
            onClick={() => onDecline(proposal)}
          >
            {NOT_NOW}
          </button>
        </div>
      )}

      {!pending && refreshable && (
        <div className="op-actions">
          <button
            type="button"
            className="btn btn-secondary op-action"
            disabled={busy}
            onClick={() => onRefreshPlan(proposal)}
          >
            {REFRESH_PLAN}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * One column of the before/after diff: ALL FIVE voice fields, with their EXACT
 * stored values.
 *
 * The two list fields are rendered ITEM BY ITEM, not as a count, and each item
 * that is absent from the other side is marked as changed. A count-only render
 * makes "avoid: peanuts" → "avoid: shellfish" look identical on both sides,
 * and the owner approves a replacement they never read (RB-04).
 *
 * A `null` scalar reads "Cleared" on the AFTER side of a real removal and
 * "Not set" everywhere else: clearing a value is a change the owner is
 * agreeing to, and "Not set" on both sides would hide it.
 */
function VoiceStateDetail({
  state,
  other,
  side,
}: {
  state: ReturnType<typeof parseVoiceState>;
  other: ReturnType<typeof parseVoiceState>;
  /** Which column this is. Only the after side can report a removal. */
  side: 'before' | 'after';
}) {
  // `side` is which COLUMN this is. "Cleared" is a statement about a removal,
  // so it belongs only to the AFTER side of one: a null on the BEFORE side of
  // a proposal that SETS a value means the field was never set, and calling
  // that "Cleared" told the owner a change had happened that had not (RB2-07).
  const scalar = (value: string | null, counterpart: string | null) => {
    const changed = value !== counterpart;
    const removed = side === 'after' && value === null && counterpart !== null;
    const text = value === null ? (removed ? 'Cleared' : 'Not set') : value;
    return <span className={changed ? 'op-diff-value op-changed' : 'op-diff-value'}>{text}</span>;
  };

  const list = (values: readonly string[], counterpart: readonly string[]) => {
    if (values.length === 0) return <span className="op-diff-value">Nothing</span>;
    const theirs = new Set(counterpart);
    return (
      <ul className="op-diff-list">
        {values.map((value, index) => (
          <li
            key={`${value}-${index}`}
            className={theirs.has(value) ? 'op-diff-value' : 'op-diff-value op-changed'}
          >
            {value}
          </li>
        ))}
      </ul>
    );
  };

  // ONE ordered list of labels, shared with the Receipt (F4). Iterating it
  // rather than transcribing five pairs is what keeps the two renderers from
  // disagreeing about a field's name or its position.
  return (
    <>
      {VOICE_FIELD_LABELS.map(({ field, label }) => (
        <Fragment key={field}>
          <span className="op-kv-label">{label}</span>
          {field === 'tone' || field === 'productsServices'
            ? scalar(state[field], other[field])
            : list(state[field], other[field])}
        </Fragment>
      ))}
    </>
  );
}
