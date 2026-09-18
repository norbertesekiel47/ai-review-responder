import { describe, expect, it } from 'vitest';
import { STEP_PERSONA } from '@/lib/agents/run-spine';
import { describeStep, stepStatusLabel } from '../step-facts';

// The owner-facing half of the Safety review (G4-F1). Red-team RT-05: the new
// STEP_COPY entry had no test at all, and `STEP_PERSONA['safety_reviewed']` was
// reached only by a tautological Object.entries loop — so the entire rendering
// an owner sees when a draft is held was unexercised.

describe('safety_reviewed timeline copy', () => {
  it('renders a label and explanation rather than a de-snake-cased database word', () => {
    const copy = describeStep('safety_reviewed');

    expect(copy.label).toBe('Safety review');
    expect(copy.explain).not.toBeNull();
    // NOT "Safety check" — `moderation_checked` owns that label, and two steps
    // with one name on the same timeline is the defect this guards.
    expect(copy.label).not.toBe(describeStep('moderation_checked').label);
  });

  it('says a held draft was held for you, never that the check failed', () => {
    // persist.ts writes status 'failed' for a not-cleared verdict, matching
    // moderation_checked. "Failed" would tell the owner the opposite of what
    // happened: the check worked, and that is why nothing posted.
    const label = stepStatusLabel({ stepKey: 'safety_reviewed', status: 'failed' });

    expect(label).toBe('Held for you');
  });

  it('shows no status chip for a completed check', () => {
    expect(stepStatusLabel({ stepKey: 'safety_reviewed', status: 'completed' })).toBeNull();
  });

  it('is registered on the run spine as a system step', () => {
    expect(STEP_PERSONA.safety_reviewed).toBe('system');
  });
});
