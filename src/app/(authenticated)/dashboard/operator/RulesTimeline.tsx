'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProposalView, RulesTimelineCursor } from '@/lib/agents/operator/proposals';
import { ProposalCard } from './ProposalCard';
import { getJson } from './useOperatorConversation';
import type { ProposalWrites } from './useProposalWrites';
import { routeErrorSentence } from './wording';

interface TimelinePage {
  proposals: ProposalView[];
  pendingRestores: ProposalView[];
  nextCursor: RulesTimelineCursor | null;
}

function timelineUrl(locationId: string | null, cursor: RulesTimelineCursor | null): string {
  const params = new URLSearchParams();
  if (locationId !== null) params.set('locationId', locationId);
  if (cursor !== null) {
    params.set('cursorAppliedAt', cursor.appliedAt);
    params.set('cursorId', cursor.id);
  }
  return `/api/operator/rules-timeline${params.size > 0 ? `?${params}` : ''}`;
}

function uniqueProposals(rows: ProposalView[]): ProposalView[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

/** Independent of the conversation's bounded transcript, with stale-read protection. */
function useRulesTimeline(locationId: string | null, revision: string, onDisabled: () => void) {
  const [page, setPage] = useState<(TimelinePage & { key: string; error: string | null; loadingMore: boolean }) | null>(null);
  const request = useRef<AbortController | null>(null);
  const key = `${locationId ?? 'all'}/${revision}`;

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void (async () => {
      const result = await getJson<TimelinePage>(timelineUrl(locationId, null), controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === 'disabled') { onDisabled(); return; }
      if (result.kind === 'aborted') return;
      setPage(result.kind === 'ok'
        ? { ...result.value, pendingRestores: result.value.pendingRestores ?? [], key, error: null, loadingMore: false }
        : { proposals: [], pendingRestores: [], nextCursor: null, key, loadingMore: false,
          error: routeErrorSentence(result.kind === 'error' ? result.code : 'rules_timeline_failed') });
    })();
    return () => { controller.abort(); request.current?.abort(); };
  }, [key, locationId, onDisabled]);

  const current = page?.key === key ? page : null;
  const loadMore = async () => {
    if (current === null || current.nextCursor === null || current.loadingMore) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPage({ ...current, loadingMore: true, error: null });
    const result = await getJson<TimelinePage>(timelineUrl(locationId, current.nextCursor), controller.signal);
    if (controller.signal.aborted) return;
    if (result.kind === 'disabled') { onDisabled(); return; }
    if (result.kind === 'aborted') return;
    setPage((latest) => {
      if (latest?.key !== key) return latest;
      if (result.kind !== 'ok') return { ...latest, loadingMore: false,
        error: routeErrorSentence(result.kind === 'error' ? result.code : 'rules_timeline_failed') };
      return { ...latest, loadingMore: false, error: null, nextCursor: result.value.nextCursor,
        proposals: uniqueProposals([...latest.proposals, ...result.value.proposals]),
        pendingRestores: uniqueProposals([...latest.pendingRestores, ...(result.value.pendingRestores ?? [])]) };
    });
  };
  return { page: current, loadMore };
}

export function RulesTimeline({ locationId, locationLabel, revision, onDisabled, cards }: {
  locationId: string | null;
  locationLabel: (id: string) => string;
  revision: number;
  onDisabled: () => void;
  cards: ProposalWrites;
}) {
  const [refresh, setRefresh] = useState(0);
  const { page, loadMore } = useRulesTimeline(locationId, `${revision}/${refresh}`, onDisabled);
  // Preparation can refer to a receipt older than the currently loaded page.
  // Keep the returned card visible while durable history catches up.
  const local = cards.preparedProposal;
  const localSourceLoaded = local?.restoreSourceProposalId !== undefined
    && page?.proposals.some((row) => row.id === local.restoreSourceProposalId);
  const pending = uniqueProposals([
    ...(local && !localSourceLoaded && (locationId === null || local.locationId === locationId) ? [local] : []),
    ...(page?.pendingRestores ?? []),
  ]).map((row) => cards.updatedProposals[row.id] ?? row)
    .filter((row) => row.status !== 'applied' && !page?.proposals.some((applied) => applied.id === row.id));
  const card = (row: ProposalView) => <ProposalCard
    key={row.id} proposal={row} turnLocationId={row.locationId ?? ''} locationLabel={locationLabel}
    scopeMoved={false} busy={cards.busyId === row.id} error={cards.errors[row.id] ?? null}
    onApply={(proposal, confirmation) => void cards.write(proposal, 'apply', confirmation)}
    onDecline={(proposal) => void cards.write(proposal, 'decline')}
    onRestore={(proposal) => void cards.write(proposal, 'restore')}
    onRefreshPlan={(proposal) => void cards.write(proposal, 'restore')}
  />;

  return <section className="op-conversation" aria-label="Applied changes timeline">
    <header className="op-head">
      <h2 className="card-h2">Rules timeline</h2>
      <p className="op-body">Applied changes for {locationId === null ? 'all locations' : locationLabel(locationId)}. Restore prepares a new proposal for you to review.</p>
    </header>
    {pending.length > 0 && <div className="op-turn" role="group" aria-label="Prepared restores">
      <p className="op-state-line">Review the prepared restore below. Nothing changes until you apply it.</p>
      {pending.map(card)}
    </div>}
    {page === null && <p className="op-preparing" role="status">Loading rules timeline…</p>}
    {page?.error && <p className="op-notice" role="alert">{page.error}</p>}
    {page?.proposals.map(card)}
    {page && page.proposals.length === 0 && !page.error && <p className="op-body">No applied changes in this scope yet.</p>}
    {page && <div className="op-actions">
      {page.nextCursor !== null && <button type="button" className="btn btn-secondary op-action"
        disabled={page.loadingMore} onClick={() => void loadMore()}>{page.loadingMore ? 'Loading older changes…' : 'Load older changes'}</button>}
      <button type="button" className="btn btn-secondary op-action" disabled={page.loadingMore}
        onClick={() => setRefresh((value) => value + 1)}>Refresh timeline</button>
    </div>}
  </section>;
}
