'use client';

import type { ProposalView } from '@/lib/agents/operator/proposals';
import type { OwnerConversationTurn } from '@/lib/agents/operator/reads';
import { ProposalCard } from './ProposalCard';
import { RequestedCapabilityCard } from './RequestedCapabilityCard';
import { statusMetricLabel } from './wording';
import './operator.css';

export interface TurnBodyProps {
  turn: OwnerConversationTurn;
  locationLabel: (id: string) => string;
  currentScope: string;
  onChooseLocation: (id: string) => void;
  onApply: (proposal: ProposalView, confirmationLevel?: string) => void;
  onDecline: (proposal: ProposalView) => void;
  onRefreshPlan: (proposal: ProposalView) => void;
  onRestore?: (proposal: ProposalView) => void;
  cardBusyId: string | null;
  cardErrors: Record<string, string>;
}

/**
 * One turn's reply, rendered exhaustively over `RenderedSegment` in stored
 * order. Status values stay frozen; refusal wording comes from the server.
 * A proposal reference places its card, and unreferenced proposals are
 * appended rather than lost (RB-06). Expansion proposals follow the transcript
 * in their separate confirmation group.
 */
export function TurnBody({
  turn,
  locationLabel,
  currentScope,
  onChooseLocation,
  onApply,
  onDecline,
  onRefreshPlan,
  onRestore,
  cardBusyId,
  cardErrors,
}: TurnBodyProps) {
  const byId = new Map(turn.proposals.map((proposal) => [proposal.id, proposal]));
  const placed = new Set<string>();
  const expansions: ProposalView[] = [];

  const card = (proposal: ProposalView) => {
    placed.add(proposal.id);
    return (
      <ProposalCard
        key={proposal.id}
        proposal={proposal}
        turnLocationId={turn.locationId}
        locationLabel={locationLabel}
        scopeMoved={currentScope !== turn.locationId}
        onApply={onApply}
        onDecline={onDecline}
        onRefreshPlan={onRefreshPlan}
        onRestore={onRestore}
        busy={cardBusyId === proposal.id}
        error={cardErrors[proposal.id] ?? null}
      />
    );
  };

  const rendered = turn.segments.map((segment, index) => {
    const key = `${turn.id}-${index}`;
    switch (segment.type) {
      case 'text':
        return <p key={key} className="op-body">{segment.text}</p>;
      case 'question':
        return <p key={key} className="op-body op-question">{segment.text}</p>;
      case 'notice':
        return <p key={key} className="op-note">{segment.text}</p>;
      case 'refusal':
        return (
          <div key={key} className="card op-card" role="group" aria-label="Policy refused">
            <h2 className="card-h2">RepWorth will not do this</h2>
            <p className="op-body">{segment.text}</p>
            <p className="op-state-line">Nothing changed.</p>
          </div>
        );
      case 'status':
        // FROZEN at completion: the value, its period and the instant it was
        // read. Nothing here re-reads a count.
        return (
          <p key={key} className="op-body">
            <span className="op-kv-value">{segment.value}</span>{' '}
            {statusMetricLabel(segment.metric, segment.reportingPeriodDays)}{' '}
            <span className="op-asof">
              (as of <time dateTime={segment.asOf}>{new Date(segment.asOf).toLocaleString()}</time>)
            </span>
          </p>
        );
      case 'scope_check':
        return (
          <div key={key} className="card op-card" role="group" aria-label="Which location?">
            <p className="op-body">
              Did you mean {segment.locationName}? Choose the location and ask again.
            </p>
            <div className="op-actions">
              <button
                type="button"
                className="btn btn-secondary op-action"
                onClick={() => onChooseLocation(segment.locationId)}
              >
                {segment.locationName}
              </button>
            </div>
          </div>
        );
      case 'proposal': {
        const proposal = byId.get(segment.proposalId);
        // A reference whose row is not in this turn's list is a transcript the
        // reader cannot act on; it is skipped rather than throwing, and the
        // card list below still shows anything that WAS returned.
        if (proposal === undefined || placed.has(proposal.id)) return null;
        if (proposal.requiresConfirmation) {
          placed.add(proposal.id);
          expansions.push(proposal);
          return null;
        }
        return card(proposal);
      }
      default: {
        // Exhaustiveness guard: a new RenderedSegment member fails typecheck
        // here rather than disappearing from the screen.
        const _never: never = segment;
        return null;
      }
    }
  });

  const expansionCards = [...expansions, ...turn.proposals.filter((proposal) => proposal.requiresConfirmation && !placed.has(proposal.id))];
  return (
    <>
      {rendered}
      {turn.proposals.filter((proposal) => !proposal.requiresConfirmation && !placed.has(proposal.id)).map(card)}
      {turn.unsupported.map((row) => (
        <RequestedCapabilityCard key={row.id} request={row.request} />
      ))}
      {expansionCards.length > 0 && <div className="op-expansions" role="group" aria-label="Changes that expand auto-reply">
        <h2 className="card-h2">Changes that expand auto-reply</h2>
        {expansionCards.map(card)}
      </div>}
    </>
  );
}
