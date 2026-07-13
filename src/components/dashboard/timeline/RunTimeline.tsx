import type { ReviewTimelineOutcome, ReviewTimelineRun } from '@/lib/agents/read';
import { RunStateBadge } from './RunStateBadge';
import { formatIdentifier, formatOutcomeKind } from './format';
import { PersonaMark, TimelineStepRow } from './TimelineStepRow';

const RUN_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function RunTimeline({
  run,
  ordinal,
}: {
  run: ReviewTimelineRun;
  ordinal: number;
}) {
  const headingId = `timeline-run-${run.id}`;
  const outcomes = collapseAutoPostedPair(run.outcomes);
  const failureReason = run.displayState === 'failed' ? describeRunFailure(run.error) : null;

  return (
    <article className="card timeline-run" aria-labelledby={headingId}>
      <header className="timeline-run__header">
        <div>
          <p className="timeline-run__eyebrow">{ordinal === 1 ? 'Latest run' : `Run ${ordinal}`}</p>
          <h2 id={headingId}>{formatRunDate(run.startedAt)}</h2>
        </div>
        <RunStateBadge displayState={run.displayState} startedAt={run.startedAt} />
      </header>

      {failureReason && <p className="timeline-run__error">{failureReason}</p>}

      {run.steps.length > 0 ? (
        <ol className="timeline-steps">
          {run.steps.map((step) => <TimelineStepRow key={step.stepIndex} step={step} />)}
        </ol>
      ) : (
        <p className="timeline-run__no-steps">No recorded steps for this run.</p>
      )}

      {outcomes.length > 0 && (
        <div className="timeline-outcomes" aria-label="Recorded outcomes">
          <span className="timeline-outcomes__label">Outcomes</span>
          {outcomes.map((outcome) => (
            <span
              className={`timeline-outcome timeline-outcome--${outcome.attributedAgent}`}
              key={`${outcome.outcomeKind}-${outcome.occurredAt}`}
            >
              <PersonaMark persona={outcome.attributedAgent} />
              {formatOutcomeKind(outcome.outcomeKind)}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

// One auto-policy post records BOTH reply_posted and reply_auto_posted on the
// same run (mark-posted.ts) — the qualifier chip alone tells the whole story.
function collapseAutoPostedPair(outcomes: ReviewTimelineOutcome[]): ReviewTimelineOutcome[] {
  if (!outcomes.some((outcome) => outcome.outcomeKind === 'reply_auto_posted')) return outcomes;
  return outcomes.filter((outcome) => outcome.outcomeKind !== 'reply_posted');
}

function describeRunFailure(error: Record<string, unknown> | null): string | null {
  if (error == null) return null;
  const reason = error['reason'];
  if (typeof reason === 'string' && reason.length > 0) return formatIdentifier(reason);
  return 'This run hit an unexpected error.';
}

function formatRunDate(value: string): string {
  return RUN_DATE_FORMATTER.format(new Date(value));
}
