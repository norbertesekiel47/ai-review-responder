'use client';

import { useState } from 'react';
import type { ReviewTimelineEscalation } from '@/lib/agents/read';

type PendingAction = 'acknowledge' | 'resolve';

export function TimelineEscalationActions({
  escalation,
  onRefresh,
}: {
  escalation: ReviewTimelineEscalation;
  onRefresh: () => Promise<unknown> | unknown;
}) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (escalation.status === 'resolved') return null;

  async function transition(action: PendingAction) {
    setPending(action);
    setError(null);
    try {
      const result = await fetch(`/api/dashboard/escalations/${escalation.id}/${action}`, {
        method: 'POST',
      });
      if (result.status === 409) {
        await onRefresh();
        return;
      }
      if (!result.ok) {
        const body: unknown = await result.json().catch(() => null);
        throw new Error(readError(body) ?? `Unable to ${action} escalation`);
      }
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to ${action} escalation`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="timeline-escalation__actions">
      {escalation.status === 'escalated' && (
        <button
          type="button"
          className="btn btn-secondary timeline-escalation__button"
          disabled={pending != null}
          onClick={() => void transition('acknowledge')}
        >
          {pending === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
        </button>
      )}
      <button
        type="button"
        className="btn btn-primary timeline-escalation__button"
        disabled={pending != null}
        onClick={() => void transition('resolve')}
      >
        {pending === 'resolve' ? 'Resolving…' : 'Resolve'}
      </button>
      {error && <p className="timeline-escalation__error" role="alert">{error}</p>}
    </div>
  );
}

function readError(value: unknown): string | null {
  if (value == null || typeof value !== 'object') return null;
  const error = Reflect.get(value, 'error');
  return typeof error === 'string' ? error : null;
}
