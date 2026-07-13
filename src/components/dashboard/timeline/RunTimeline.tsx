import type { ReviewTimelineRun } from '@/lib/agents/read';
import { RunStateBadge } from './RunStateBadge';
import { formatIdentifier } from './format';
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

  return (
    <article className="card timeline-run" aria-labelledby={headingId}>
      <header className="timeline-run__header">
        <div>
          <p className="timeline-run__eyebrow">{ordinal === 1 ? 'Latest run' : `Run ${ordinal}`}</p>
          <h2 id={headingId}>{formatRunDate(run.startedAt)}</h2>
        </div>
        <RunStateBadge displayState={run.displayState} startedAt={run.startedAt} />
      </header>

      {run.steps.length > 0 ? (
        <ol className="timeline-steps">
          {run.steps.map((step) => <TimelineStepRow key={step.stepIndex} step={step} />)}
        </ol>
      ) : (
        <p className="timeline-run__no-steps">No recorded steps for this run.</p>
      )}

      {run.outcomes.length > 0 && (
        <div className="timeline-outcomes" aria-label="Recorded outcomes">
          <span className="timeline-outcomes__label">Outcomes</span>
          {run.outcomes.map((outcome) => (
            <span
              className={`timeline-outcome timeline-outcome--${outcome.attributedAgent}`}
              key={`${outcome.outcomeKind}-${outcome.occurredAt}`}
            >
              <PersonaMark persona={outcome.attributedAgent} />
              {formatIdentifier(outcome.outcomeKind)}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function formatRunDate(value: string): string {
  return RUN_DATE_FORMATTER.format(new Date(value));
}
