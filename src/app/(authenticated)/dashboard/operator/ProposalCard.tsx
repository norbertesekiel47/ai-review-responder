'use client';

import { Fragment, useId, useState } from 'react';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import { parsePolicyState, parseVoiceState } from '@/lib/agents/operator/schema';
import { PolicyConsequenceLine, PolicyStateDetail } from './PolicyStateDetail';
import { ReceiptView } from './ReceiptView';
import {
  AFFECTS_FUTURE_DRAFTS,
  AFFECTS_FUTURE_ELIGIBLE_REVIEWS,
  READINESS_WORDING,
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

/**
 * The lead-in for an APPLIED armed rule on a blocked account (#1352). Present
 * tense, and it concedes the save first: the owner's rule really is stored, and
 * what follows is the account as it stands now — not a warning about a change
 * they have yet to make.
 */
const POSTING_BLOCK_NOW_LEAD =
  'This rule is saved, but your account is not set up to post replies automatically right now:';

const POLICY_TITLES: Readonly<Record<string, string>> = {
  set_auto_reply_scope: 'Change auto-reply scope',
  set_veto_window: 'Change the time to stop a reply',
  set_daily_cap: 'Change the daily auto-reply limit',
  clear_location_override: 'Use the account default for auto-reply',
};

export interface ProposalCardProps {
  proposal: ProposalView;
  /** The turn's STORED location — the card's target, never the selector (§3.3). */
  turnLocationId: string;
  /** How to name a location on screen. Supplied by the client, which owns the roster. */
  locationLabel: (locationId: string) => string;
  /** True when the browser's current scope is not the turn's location (D4). */
  scopeMoved: boolean;
  onApply: (proposal: ProposalView, confirmationLevel?: string) => void;
  onDecline: (proposal: ProposalView) => void;
  onRefreshPlan: (proposal: ProposalView) => void;
  onRestore?: (proposal: ProposalView) => void;
  busy: boolean;
  error: string | null;
}

/**
 * One **Proposal** as a Harbor card, rendered ENTIRELY from the stored row.
 *
 * Policy targets use the proposal's scope, including a null account default.
 * Voice targets fall back to the turn's stored location, never the current
 * selector (spec §3.3). That is
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
  onRestore,
  busy,
  error,
}: ProposalCardProps) {
  const policy = proposal.before.domain === 'policy';
  const account = policy && proposal.locationId === null;
  const instanceId = useId();
  const headingId = `op-proposal-${proposal.id}-${instanceId}`;
  const reasonId = `${headingId}-reason`;

  const applied = proposal.status === 'applied';

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
      <h2 className="card-h2" id={headingId}>{proposal.describe.startsWith('Restore:')
        ? proposal.describe : policy ? POLICY_TITLES[proposal.operation] ?? proposal.describe : proposal.describe}</h2>

      <ProposalTarget proposal={proposal} account={account} turnLocationId={turnLocationId}
        locationLabel={locationLabel} scopeMoved={scopeMoved} />
      <ProposalPreview proposal={proposal} policy={policy} account={account} />
      <p className="op-state-line">{policy ? AFFECTS_FUTURE_ELIGIBLE_REVIEWS : AFFECTS_FUTURE_DRAFTS}</p>

      <ProposalState
        proposal={proposal}
        locationLabel={locationLabel}
        reasonId={reasonId}
        onApply={onApply}
        onDecline={onDecline}
        onRefreshPlan={onRefreshPlan}
        onRestore={onRestore}
        busy={busy}
        error={error}
      />
    </section>
  );
}

function ProposalTarget({ proposal, account, turnLocationId, locationLabel, scopeMoved }:
  Pick<ProposalCardProps, 'proposal' | 'turnLocationId' | 'locationLabel' | 'scopeMoved'> & { account: boolean }) {
  const targetLocationId = proposal.locationId ?? turnLocationId;
  return <>
    <div className="op-kv">
      <span className="op-kv-label">{account ? 'Scope' : 'This location'}</span>
      <span className="op-kv-value">{account ? 'Account default' : locationLabel(targetLocationId)}</span>
    </div>
    {account && proposal.affectedLocationCount !== null && <p className="op-note">Affects {proposal.affectedLocationCount} locations that inherit the account default. Locations with their own rule keep it.</p>}
    {!account && scopeMoved && <p className="op-note">{preparedForNote(locationLabel(targetLocationId))}</p>}
  </>;
}

function ProposalPreview({ proposal, policy, account }: { proposal: ProposalView; policy: boolean; account: boolean }) {
  return <>

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
        {policy
          ? <PolicyStateDetail state={parsePolicyState(proposal.before, 'proposal.before')} other={parsePolicyState(proposal.after, 'proposal.after')} account={account} />
          : <VoiceStateDetail state={parseVoiceState(proposal.before, 'proposal.before')} other={parseVoiceState(proposal.after, 'proposal.after')} side="before" />}
      </div>
      <div className="op-diff-col">
        <span className="op-kv-label">After this change</span>
        {policy
          ? <PolicyStateDetail state={parsePolicyState(proposal.after, 'proposal.after')} other={parsePolicyState(proposal.before, 'proposal.before')} account={account} />
          : <VoiceStateDetail state={parseVoiceState(proposal.after, 'proposal.after')} other={parseVoiceState(proposal.before, 'proposal.before')} side="after" />}
      </div>
    </div>

    {policy && !account && proposal.before.rowExists === false && proposal.after.rowExists === true && (
      <p className="op-note">This creates a location rule. It stops inheriting the account default and uses all the settings shown above.</p>
    )}
    {policy && proposal.consequence && <PolicyConsequenceLine line={proposal.consequence} operation={proposal.operation} vetoWindowMinutes={parsePolicyState(proposal.after, 'proposal.after').vetoWindowMinutes} />}
  </>;
}

/**
 * WHAT THIS CARD'S STATUS MEANS, and what the owner may still do about it.
 *
 * Every status has a rendering, deliberately: a card with a headline and no
 * state line is a card the owner cannot act on and cannot interpret. Split out
 * of `ProposalCard` so the card above stays a description of the plan and this
 * stays the one place the six statuses are answered.
 */
function ProposalState({
  proposal,
  locationLabel,
  reasonId,
  onApply,
  onDecline,
  onRefreshPlan,
  onRestore,
  busy,
  error,
}: Pick<
  ProposalCardProps,
  'proposal' | 'locationLabel' | 'onApply' | 'onDecline' | 'onRefreshPlan' | 'onRestore' | 'busy' | 'error'
> & {
  /** The id the refusal notice carries, so Apply can describe itself by it. */
  reasonId: string;
}) {
  const pending = proposal.status === 'pending';
  // The view marks this one optional (`proposals.ts`): a payload built before
  // the field existed carries no notice rather than no card.
  const postingBlockNow = proposal.postingBlockNowSentences ?? [];
  const refreshable =
    proposal.failureReason !== null && OFFERS_REFRESH_PLAN.has(proposal.failureReason);

  return (
    <>
      <ProposalStatusLine proposal={proposal} locationLabel={locationLabel} />

      {error !== null && (
        <p className="op-notice" id={reasonId} role="alert">{error}</p>
      )}

      {proposal.requiresConfirmation && proposal.readinessBlockReasons.length > 0 && (
        <ul className="op-readiness">{proposal.readinessBlockReasons.map((reason) => <li key={reason}>{READINESS_WORDING[reason]}</li>)}</ul>
      )}

      {/* THE ACCOUNT'S POSTING BLOCK (#1352). Already owner-ready sentences —
          `src/lib/auto-approval/posting-block-copy.ts` owns the words and the
          settings page reads the same ones, so the card does NO mapping of its
          own. It adds no disable condition: this card would state a change to
          auto-posting the account cannot act on, and saying so is the whole
          correction. Readiness and the confirmation phrase still gate Apply on
          their own, unchanged. */}
      {proposal.postingBlockSentences.length > 0 && (
        <ul className="op-readiness">{proposal.postingBlockSentences.map((sentence) => <li key={sentence}>{sentence}</li>)}</ul>
      )}

      {/* THE SAME ACCOUNT, AFTER APPLY. The label above now reads "Active rule"
          and the receipt says "Effective now", so a saved rule with nothing
          behind it is #1352 again one step later. Present tense on purpose and
          led by a line that says the rule IS saved, so this cannot be misread
          as the pending card's pre-Apply warning; the receipt beside it still
          records only what happened. The server makes the two lists mutually
          exclusive, so a card shows at most one of them. */}
      {postingBlockNow.length > 0 && (
        <>
          <p className="op-note">{POSTING_BLOCK_NOW_LEAD}</p>
          <ul className="op-readiness">{postingBlockNow.map((sentence) => <li key={sentence}>{sentence}</li>)}</ul>
        </>
      )}

      {pending && <PendingProposalActions proposal={proposal} reasonId={reasonId}
        onApply={onApply} onDecline={onDecline} busy={busy} error={error} />}

      <RestoreProposalAction proposal={proposal} onRestore={onRestore}
        busy={busy} error={error} reasonId={reasonId} />

      {!pending && refreshable && (
        <div className="op-actions">
          <button type="button" className="btn btn-secondary op-action" disabled={busy}
            onClick={() => onRefreshPlan(proposal)}>{REFRESH_PLAN}</button>
        </div>
      )}
    </>
  );
}

/** Restore prepares a new Proposal only when this card has an applied Receipt. */
function RestoreProposalAction({ proposal, onRestore, busy, error, reasonId }:
  Pick<ProposalCardProps, 'proposal' | 'onRestore' | 'busy' | 'error'> & { reasonId: string }) {
  if (proposal.status !== 'applied' || proposal.receipt === null || !onRestore) return null;
  return (
    <div className="op-actions">
      <button type="button" className="btn btn-secondary op-action" disabled={busy}
        aria-describedby={error !== null ? reasonId : undefined}
        onClick={() => onRestore(proposal)}>{busy ? 'Preparing restore…' : 'Restore'}</button>
      <span className="op-note">Prepare a change to review before applying.</span>
    </div>
  );
}

function ProposalStatusLine({ proposal, locationLabel }: Pick<ProposalCardProps, 'proposal' | 'locationLabel'>) {
  switch (proposal.status) {
    case 'pending': return null;
    case 'applied':
      // The applied label survives a missing receipt; only a stored receipt
      // supplies the immutable record and its actual before/after values.
      return <>
        <p className="op-state-line">{PROPOSAL_LABEL_APPLIED[proposal.labelKind]}</p>
        {proposal.receipt !== null && <ReceiptView receipt={proposal.receipt}
          describe={proposal.describe} locationLabel={locationLabel} />}
      </>;
    case 'superseded': return <p className="op-state-line">{PROPOSAL_SUPERSEDED}</p>;
    case 'rejected':
      if (proposal.failureReason === null) return <p className="op-state-line">{PROPOSAL_DECLINED}</p>;
      return <p className="op-state-line">{proposalFailureSentence(proposal.failureReason)}</p>;
    case 'stale':
    case 'failed': return <p className="op-state-line">{proposalFailureSentence(proposal.failureReason)}</p>;
  }
}

function PendingProposalActions({ proposal, reasonId, onApply, onDecline, busy, error }:
  Pick<ProposalCardProps, 'proposal' | 'onApply' | 'onDecline' | 'busy' | 'error'> & { reasonId: string }) {
  const [confirmation, setConfirmation] = useState('');
  const confirmationBlocked = proposal.requiresConfirmation &&
  (confirmation !== proposal.confirmationPhrase || proposal.readinessBlockReasons.length > 0);
  return <>
    {proposal.requiresConfirmation && (
      <div className="op-confirmation">
        <label htmlFor={`${reasonId}-confirmation`}>Type “{proposal.confirmationPhrase}” to confirm this scope</label>
        <input id={`${reasonId}-confirmation`} className="input op-confirmation-input" type="text"
          maxLength={100} value={confirmation} disabled={busy} autoComplete="off" spellCheck={false}
          aria-describedby={error !== null ? reasonId : undefined}
          onChange={(event) => setConfirmation(event.target.value)} />
      </div>
    )}

    <div className="op-actions">
      <button
        type="button"
        className="btn btn-primary op-action"
        disabled={busy || confirmationBlocked}
        aria-describedby={error !== null ? reasonId : undefined}
        onClick={() => proposal.requiresConfirmation ? onApply(proposal, confirmation) : onApply(proposal)}
      >
        {proposal.requiresConfirmation ? 'Confirm and apply' : APPLY}
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
  </>;
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
