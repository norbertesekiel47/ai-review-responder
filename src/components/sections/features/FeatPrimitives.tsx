import { cn } from '@/lib/ui/cn';

export interface FeatStep {
  n: string;
  title: string;
  sub: string;
  /** Elapsed-time label on the row's right ("0:00", "+0:12", "ongoing"). */
  t: string;
  /** The last step: filled forest disc and the stronger hairline. */
  final: boolean;
}

/**
 * The numbered step timeline two chapters share (02 Guardian's escalation
 * path, 04 The Gate's approval path): a hairline disc, a paper card, and the
 * elapsed-time label, one row per step.
 */
export function FeatSteps({ steps }: { steps: readonly FeatStep[] }) {
  return (
    <ol className="feat-steps">
      {steps.map((s) => (
        <li key={s.n} className="feat-step-row">
          <span className={cn('feat-step-num', s.final && 'is-final')}>{s.n}</span>
          <div className={cn('feat-step-card', s.final && 'is-final')}>
            <p className="feat-step-t">{s.title}</p>
            <p className="feat-step-s">{s.sub}</p>
          </div>
          <span className="feat-step-time">{s.t}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Ink star glyphs with the accessible rating (Daylight: ratings are content,
 * not action — stars are never coloured). `glyphs` is the literal run so a
 * 4★ sample can show its hollow fifth star.
 */
export function ReviewStars({ rating, glyphs = '★★★★★' }: { rating: number; glyphs?: string }) {
  return (
    <span className="rw-dl-stars" aria-label={`${rating} out of 5 stars`}>
      <span aria-hidden="true">{glyphs}</span>
    </span>
  );
}

/**
 * The three-cell receipt strip (`.rw-dl-rec`) from data, so the chapters
 * that show settings or counts share one markup path.
 */
export function FeatReceipt({
  cells,
  className,
}: {
  cells: readonly (readonly [label: string, value: string])[];
  className?: string;
}) {
  return (
    <div className={cn('rw-dl-rec', className)}>
      {cells.map(([k, v]) => (
        <div key={k}>
          <div className="rw-dl-rec-k">{k}</div>
          <div className="rw-dl-rec-v">{v}</div>
        </div>
      ))}
    </div>
  );
}
