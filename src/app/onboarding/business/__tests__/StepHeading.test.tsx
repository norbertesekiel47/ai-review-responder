import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StepHeading, wizardFlowCopy, wizardStepLabel } from '../StepHeading';

describe('wizardStepLabel', () => {
  it('formats "Step N of 3 — Name" so every step reads the same', () => {
    expect(wizardStepLabel(2, 'Voice')).toBe('Step 2 of 3 — Voice');
  });
});

describe('wizardFlowCopy — flow-aware labels (A10, A11)', () => {
  it('names the demo flow Profile → Voice → Connect and lets Voice only "Continue"', () => {
    const copy = wizardFlowCopy(true);
    expect(copy.stepNames).toEqual({ 1: 'Profile', 2: 'Voice', 3: 'Connect' });
    expect(copy.voiceSubmitLabel).toBe('Continue →');
    expect(copy.subtitle).toMatch(/then we connect your reviews/);
  });

  it('names the legacy flow Location → Profile → Voice and lets Voice "Finish setup"', () => {
    const copy = wizardFlowCopy(false);
    expect(copy.stepNames).toEqual({ 1: 'Location', 2: 'Profile', 3: 'Voice' });
    expect(copy.voiceSubmitLabel).toBe('Finish setup');
    expect(copy.subtitle).toBe('A few quick details so we can start fetching your reviews.');
  });
});

describe('StepHeading', () => {
  it('renders the sub-step label and the title inside one h2', () => {
    const html = renderToStaticMarkup(
      <StepHeading stepLabel="Step 1 of 3 — Profile">Business profile</StepHeading>,
    );
    expect(html).toMatch(/<h2[^>]*>.*Step 1 of 3 — Profile.*Business profile.*<\/h2>/);
  });
});
