'use client';

// The wizard's only in-card progress cue. The funnel thread above the card
// already shows the four milestones; a second dot strip underneath it stacked
// two progress systems and overflowed a 390px viewport (A10/A27). The sub-step
// now reads as one line inside the step heading — "Step 2 of 3 — Voice" — so a
// screen reader hears position and title together.
export function StepHeading({
  stepLabel,
  children,
}: {
  /** e.g. "Step 1 of 3 — Profile" — built by `wizardStepLabel`. */
  stepLabel: string;
  children: React.ReactNode;
}) {
  return (
    <h2 className="text-xl font-medium text-rw-ink">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-rw-teal-strong">
        {stepLabel}
      </span>
      {children}
    </h2>
  );
}

export const WIZARD_TOTAL_STEPS = 3;

/** "Step 1 of 3 — Profile". One owner for the format so every step matches. */
export function wizardStepLabel(step: number, name: string): string {
  return `Step ${step} of ${WIZARD_TOTAL_STEPS} — ${name}`;
}
