import type { RunDisplayState } from '@/lib/agents/read';

const STATE_LABELS: Record<RunDisplayState, string> = {
  in_progress: 'In progress',
  waiting_on_owner: 'Waiting on you',
  stalled: 'Stalled',
  completed: 'Completed',
  failed: 'Failed',
};

export function RunStateBadge({
  displayState,
  startedAt,
}: {
  displayState: RunDisplayState;
  startedAt: string;
}) {
  const label = displayState === 'stalled'
    ? `${STATE_LABELS.stalled} · ${formatAge(startedAt)}`
    : STATE_LABELS[displayState];

  return (
    <span className={`timeline-run-state timeline-run-state--${displayState}`}>
      {label}
    </span>
  );
}

function formatAge(startedAt: string): string {
  const elapsedHours = Math.max(
    0,
    Math.floor((Date.now() - new Date(startedAt).getTime()) / (60 * 60 * 1000)),
  );
  const days = Math.floor(elapsedHours / 24);
  const hours = elapsedHours % 24;
  if (days === 0) return `${hours}h`;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}
