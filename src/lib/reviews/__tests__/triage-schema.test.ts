import { describe, it, expect } from 'vitest';
import {
  TRIAGE_ISSUES,
  TRIAGE_SOURCE,
  TriageOutputSchema,
} from '../triage-schema';

describe('TriageOutputSchema', () => {
  it('accepts a valid classification', () => {
    const parsed = TriageOutputSchema.parse({
      severity: 'high',
      issues: ['safety_or_health', 'staff_conduct'],
      suggested_action: 'respond_and_escalate',
    });
    expect(parsed.severity).toBe('high');
  });

  it('rejects unknown severity, unknown issue, and >3 issues', () => {
    expect(TriageOutputSchema.safeParse({
      severity: 'critical', issues: [], suggested_action: 'respond',
    }).success).toBe(false);
    expect(TriageOutputSchema.safeParse({
      severity: 'low', issues: ['made_up_issue'], suggested_action: 'respond',
    }).success).toBe(false);
    expect(TriageOutputSchema.safeParse({
      severity: 'low',
      issues: ['pricing', 'wait_time', 'cleanliness', 'other'],
      suggested_action: 'respond',
    }).success).toBe(false);
  });

  it('rejects extra keys and missing keys', () => {
    expect(TriageOutputSchema.safeParse({
      severity: 'low', issues: [], suggested_action: 'respond', extra: true,
    }).success).toBe(false);
    expect(TriageOutputSchema.safeParse({ severity: 'low' }).success).toBe(false);
  });

  it('pins the taxonomy and source vocabulary (migration 072 + spec §2.3/§2.4)', () => {
    expect(TRIAGE_ISSUES).toEqual([
      'service_quality', 'product_quality', 'wait_time', 'pricing',
      'cleanliness', 'staff_conduct', 'order_accuracy', 'communication',
      'safety_or_health', 'billing_or_refund', 'other',
    ]);
    expect(TRIAGE_SOURCE).toEqual({
      LLM: 'llm_triage_v1',
      FALLBACK: 'fallback_high_v1',
      MOCK: 'mock_v1',
    });
  });
});
