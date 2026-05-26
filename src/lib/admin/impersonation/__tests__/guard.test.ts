import { describe, expect, it } from 'vitest';
import { assertImpersonatedActionAllowed } from '../guard';

describe('assertImpersonatedActionAllowed', () => {
  it('allows only non-destructive view actions', () => {
    expect(assertImpersonatedActionAllowed('view_dashboard')).toEqual({ ok: true });
    expect(assertImpersonatedActionAllowed('cancel_subscription')).toEqual({
      ok: false,
      error: 'impersonated_action_blocked',
    });
  });
});
