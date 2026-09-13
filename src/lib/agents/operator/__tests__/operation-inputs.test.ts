import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AutoApprovalPatchSchema,
  isAutoApprovalThreshold,
  isVetoWindowMinutes,
} from '@/lib/auto-approval/types';
import { VOICE_FIELD_LIMITS } from '@/lib/responses/voice-settings';
import {
  DailyCapValueSchema,
  OPERATION_INPUT_SCHEMAS,
  ThresholdValueSchema,
  VetoWindowValueSchema,
} from '../operation-inputs';

/** Every boundary and near-miss the three policy domains could disagree on. */
const PROBES: unknown[] = [
  null, undefined, -1, 0, 1, 3, 4, 4.5, 5, 6, 10, 14, 15, 16, 20, 29, 30, 31, 45, 50, 51, 60,
  '4', '15', '10', true,
];

describe('operator operation inputs', () => {
  it('policy value domains agree with the shared auto-approval guards and the writer PATCH schema', () => {
    // The domains are re-spelled here because types.ts keeps its zod schemas
    // private. This is the drift guard: widen or narrow a domain there and the
    // agreement below fails before a Proposal can carry a value the writer refuses.
    for (const value of PROBES) {
      const label = String(value);
      const writerThreshold = value === null
        ? AutoApprovalPatchSchema.safeParse({ operation: 'set_account_manual' }).success
        : AutoApprovalPatchSchema.safeParse({ operation: 'set_account_default', threshold: value }).success;
      expect(ThresholdValueSchema.safeParse(value).success, `threshold ${label}`)
        .toBe(value === null || isAutoApprovalThreshold(value));
      expect(ThresholdValueSchema.safeParse(value).success, `threshold writer ${label}`)
        .toBe(value !== undefined && writerThreshold);

      expect(VetoWindowValueSchema.safeParse(value).success, `veto ${label}`)
        .toBe(isVetoWindowMinutes(value));
      expect(VetoWindowValueSchema.safeParse(value).success, `veto writer ${label}`)
        .toBe(AutoApprovalPatchSchema.safeParse({ operation: 'set_account_veto_window', minutes: value }).success);

      expect(DailyCapValueSchema.safeParse(value).success, `cap writer ${label}`)
        .toBe(AutoApprovalPatchSchema.safeParse({ operation: 'set_account_daily_cap', cap: value }).success);
    }
  });

  it('policy inputs are strict one-dial objects', () => {
    const { set_auto_reply_scope, set_veto_window, set_daily_cap } = OPERATION_INPUT_SCHEMAS;
    expect(set_auto_reply_scope.safeParse({ threshold: null }).success).toBe(true);
    expect(set_auto_reply_scope.safeParse({}).success).toBe(false);
    expect(set_auto_reply_scope.safeParse({ threshold: 4, locationId: 'x' }).success).toBe(false);
    expect(set_veto_window.safeParse({ minutes: 30 }).success).toBe(true);
    expect(set_veto_window.safeParse({ minutes: 30, cap: 5 }).success).toBe(false);
    expect(set_daily_cap.safeParse({ cap: null }).success).toBe(true);
    expect(set_daily_cap.safeParse({ cap: 50 }).success).toBe(true);
    expect(set_daily_cap.safeParse({ cap: 51 }).success).toBe(false);
    expect(set_daily_cap.safeParse({ cap: 0 }).success).toBe(false);
    expect(set_daily_cap.safeParse({ cap: 2.5 }).success).toBe(false);
  });

  it('voice inputs keep the Run A shapes and read VOICE_FIELD_LIMITS', () => {
    const { set_tone, set_products_services, set_avoid_facts, set_highlight_facts } = OPERATION_INPUT_SCHEMAS;
    expect(set_tone.safeParse({ tone: 'x'.repeat(VOICE_FIELD_LIMITS.tone.maxLength) }).success).toBe(true);
    expect(set_tone.safeParse({ tone: 'x'.repeat(VOICE_FIELD_LIMITS.tone.maxLength + 1) }).success).toBe(false);
    expect(set_tone.safeParse({ tone: '   ' }).success).toBe(false);
    // `.trim()` still normalizes on parse, without a transform.
    expect(set_tone.parse({ tone: '  warm  ' })).toEqual({ tone: 'warm' });
    expect(set_products_services.safeParse({ productsServices: null }).success).toBe(true);
    expect(set_products_services.safeParse({}).success).toBe(false);
    const tooMany = Array.from({ length: VOICE_FIELD_LIMITS.avoidFacts.maxItems + 1 }, () => 'x');
    expect(set_avoid_facts.safeParse({ avoidFacts: tooMany }).success).toBe(false);
    expect(set_highlight_facts.safeParse({ highlightFacts: [''] }).success).toBe(false);
  });

  it('every input schema converts to a closed JSON Schema object, so a provider can receive it', () => {
    for (const [id, schema] of Object.entries(OPERATION_INPUT_SCHEMAS)) {
      // Throws on a transform (`unrepresentable: 'throw'` is the default).
      const json = z.toJSONSchema(schema) as Record<string, unknown>;
      expect(json.type, id).toBe('object');
      expect(json.additionalProperties, id).toBe(false);
      expect(new Set(json.required as string[]), id).toEqual(new Set(Object.keys(schema.shape)));
    }
  });
});
