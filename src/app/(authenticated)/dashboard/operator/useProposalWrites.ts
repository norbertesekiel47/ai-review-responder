'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import { postJson } from './useOperatorConversation';
import { routeErrorSentence } from './wording';

/**
 * THE CARD WRITES — Apply, Not now and Restore preparation — and their state: which
 * card is busy, and the last refusal per card.
 *
 * Split out of `OperatorClient`, which carried the turn submission and these
 * two in one component. The rule the whole hook exists to keep is ONE WRITE AT
 * A TIME: an Apply moves `businesses.updated_at`, which stales every sibling
 * plan on that location (D11), so a second write started beside the first
 * would be deciding a plan the server is about to answer differently.
 */

/** What a proposal write answers with, in every status (200 and 409 alike). */
interface ProposalWriteBody {
  proposal?: ProposalView;
}

function writtenProposal(body: unknown): ProposalView | null {
  if (typeof body !== 'object' || body === null) return null;
  const row = (body as ProposalWriteBody).proposal;
  return row ?? null;
}

export interface ProposalWrites {
  /** The proposal id whose write is in flight, if any. */
  busyId: string | null;
  /** The last refusal sentence per proposal id. */
  errors: Record<string, string>;
  /** Retained until a durable read places this new card, even outside the transcript window. */
  preparedProposal: ProposalView | null;
  write: (proposal: ProposalView, action: 'apply' | 'decline' | 'restore', confirmationLevel?: string) => Promise<void>;
}

export function useProposalWrites({
  onDisabled,
  patchProposal,
  reloadTranscript,
}: {
  onDisabled: () => void;
  /** Repaint one card from the row the server returned. */
  patchProposal: (row: ProposalView) => void;
  /** A write landed: every sibling card on this location may now be stale. */
  reloadTranscript: () => void;
}): ProposalWrites {
  /** The proposal id whose write is in flight, and the last refusal per card. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preparedProposal, setPreparedProposal] = useState<ProposalView | null>(null);
  const writing = useRef(false);

  /**
   * One POST, one re-render from the ROW the server returned. Every non-404
   * body carries `proposal`, so a refusal repaints the card with the stored
   * state instead of leaving the browser to guess what a 409 meant.
   */
  const write = useCallback(
    async (proposal: ProposalView, action: 'apply' | 'decline' | 'restore', confirmationLevel?: string) => {
      if (writing.current) return;
      writing.current = true;
      setBusyId(proposal.id);
      setErrors((current) => {
        const next = { ...current };
        delete next[proposal.id];
        return next;
      });
      try {
        const targetId = action === 'restore' && proposal.status !== 'applied'
          ? proposal.restoreSourceProposalId ?? proposal.id : proposal.id;
        const result = await postJson<ProposalWriteBody>(
          `/api/operator/proposals/${targetId}/${action}`,
          action === 'apply' ? {
            expectedVersionToken: proposal.preparedVersionToken,
            ...(confirmationLevel === undefined ? {} : { confirmationLevel }),
          } : action === 'restore' ? {} : undefined,
        );
        if (result.kind === 'disabled') { onDisabled(); return; }
        if (result.kind === 'aborted') return;
        if (result.kind === 'unreachable') {
          setErrors((current) => ({ ...current, [proposal.id]: routeErrorSentence(null) }));
          return;
        }
        const row = result.kind === 'ok'
          ? result.value.proposal ?? null
          : writtenProposal(result.body);
        if (row !== null) {
          patchProposal(row);
          setPreparedProposal((current) => action === 'restore' || current?.id === row.id ? row : current);
        }
        if (result.kind === 'error') {
          setErrors((current) => ({
            ...current,
            [proposal.id]: routeErrorSentence(result.code),
          }));
        } else {
          // An Apply moved `businesses.updated_at`, so every SIBLING card on
          // this location is now stale in the database (D11).
          reloadTranscript();
        }
      } finally {
        writing.current = false;
        setBusyId(null);
      }
    },
    [onDisabled, patchProposal, reloadTranscript],
  );

  return useMemo(() => ({ busyId, errors, preparedProposal, write }), [busyId, errors, preparedProposal, write]);
}
