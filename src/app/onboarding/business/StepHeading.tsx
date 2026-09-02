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

const WIZARD_TOTAL_STEPS = 3;

/** "Step 1 of 3 — Profile". One owner for the format so every step matches. */
export function wizardStepLabel(step: number, name: string): string {
  return `Step ${step} of ${WIZARD_TOTAL_STEPS} — ${name}`;
}

export type WizardStep = 1 | 2 | 3;

/**
 * Everything about the wizard that reads differently per flow. Both flows are
 * three steps; only the names, the subtitle and the Voice primary differ —
 * "Finish setup" when Voice is the last step (legacy), "Continue →" when
 * Connect follows (demo), because a button must never promise to finish when
 * it only advances (A11).
 */
export interface WizardFlowCopy {
  stepNames: Record<WizardStep, string>;
  subtitle: string;
  voiceSubmitLabel: string;
}

const DEMO_FLOW_COPY: WizardFlowCopy = {
  stepNames: { 1: 'Profile', 2: 'Voice', 3: 'Connect' },
  subtitle:
    'You’re in. A few quick details so replies sound like you, then we connect your reviews.',
  voiceSubmitLabel: 'Continue →',
};

const LEGACY_FLOW_COPY: WizardFlowCopy = {
  stepNames: { 1: 'Location', 2: 'Profile', 3: 'Voice' },
  subtitle: 'A few quick details so we can start fetching your reviews.',
  voiceSubmitLabel: 'Finish setup',
};

export function wizardFlowCopy(demoFlowEnabled: boolean): WizardFlowCopy {
  return demoFlowEnabled ? DEMO_FLOW_COPY : LEGACY_FLOW_COPY;
}
