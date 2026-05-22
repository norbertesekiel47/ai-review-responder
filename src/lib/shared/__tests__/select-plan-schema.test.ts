import { describe, expect, it } from 'vitest';
import { SelectPlanSchema } from '../schemas';

describe('SelectPlanSchema', () => {
  it.each(['founders', 'basic', 'standard', 'premium'] as const)(
    'accepts tier %s',
    (tier) => {
      expect(SelectPlanSchema.parse({ tier })).toEqual({ tier });
    },
  );

  it('rejects unknown tiers', () => {
    expect(() => SelectPlanSchema.parse({ tier: 'enterprise' })).toThrow();
  });
});
