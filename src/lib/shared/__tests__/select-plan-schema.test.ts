import { describe, expect, it } from 'vitest';
import { SelectPlanSchema } from '../schemas';

describe('SelectPlanSchema', () => {
  it.each(['copilot', 'autopilot'] as const)(
    'accepts tier %s',
    (tier) => {
      expect(SelectPlanSchema.parse({ tier })).toEqual({ tier });
    },
  );

  it('rejects unknown tiers', () => {
    expect(() => SelectPlanSchema.parse({ tier: 'enterprise' })).toThrow();
  });

  it('rejects a missing tier rather than inferring Copilot', () => {
    expect(() => SelectPlanSchema.parse({})).toThrow();
  });

  it.each(['founders', 'basic', 'standard', 'premium'])('rejects legacy tier %s', (tier) => {
    expect(() => SelectPlanSchema.parse({ tier })).toThrow();
  });
});
