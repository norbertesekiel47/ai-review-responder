import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  AGENT_PERSONAS,
  AGENT_RUN_KINDS,
  AGENT_OUTCOME_KINDS,
  STEP_PERSONA,
  personaForStep,
} from '../run-spine';

describe('run-spine constants', () => {
  it('exposes the three customer personas plus system', () => {
    expect(AGENT_PERSONAS).toEqual(['reply', 'guardian', 'insights', 'system']);
  });

  it('run kinds match migration 071 CHECK', () => {
    expect(AGENT_RUN_KINDS).toEqual(['review_handler', 'weekly_insights']);
  });

  it('outcome kinds match migration 071 CHECK', () => {
    expect(AGENT_OUTCOME_KINDS).toEqual([
      'reply_drafted', 'reply_posted', 'reply_auto_posted',
      'reply_approved_no_edit', 'reply_edited_by_owner',
      'review_escalated', 'escalation_resolved', 'digest_sent',
    ]);
  });
});

describe('persona map', () => {
  it('maps every known step key to a persona (totality)', () => {
    for (const [stepKey, persona] of Object.entries(STEP_PERSONA)) {
      expect(AGENT_PERSONAS).toContain(persona);
      expect(personaForStep(stepKey as keyof typeof STEP_PERSONA)).toBe(persona);
    }
  });

  it('attributes pipeline steps to the personas the design doc names', () => {
    expect(personaForStep('review_ingested')).toBe('system');
    expect(personaForStep('review_updated')).toBe('system');
    expect(personaForStep('draft_generated')).toBe('reply');
    expect(personaForStep('moderation_checked')).toBe('system');
    expect(personaForStep('policy_gate')).toBe('reply');
    expect(personaForStep('reply_posted')).toBe('reply');
  });
});
