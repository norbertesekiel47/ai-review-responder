import { describe, expect, it } from 'vitest';
import { autoApprovalThresholdLabel } from '@/lib/auto-approval/types';

// The label map itself is module-private; `autoApprovalThresholdLabel` is the
// whole interface. Exhaustiveness is guarded by the `Record<AutoApprovalThreshold,
// string>` annotation at the definition — widening the union without adding a
// label fails to compile, so asserting the map's literal shape here would only
// re-test the type system.
describe('auto-approval threshold labels', () => {
  it('maps every auto-approval threshold to its label', () => {
    expect(autoApprovalThresholdLabel(null)).toBe('Off');
    expect(autoApprovalThresholdLabel(5)).toBe('5★ only');
    expect(autoApprovalThresholdLabel(4)).toBe('4–5★');
  });

  it('throws rather than rendering undefined for an out-of-domain threshold', () => {
    // Reachable only through the unvalidated row cast in
    // business-detail/queries.ts if migration 074's CHECK ever drifts.
    expect(() => autoApprovalThresholdLabel(3 as 4 | 5)).toThrow(
      /unknown_auto_approval_threshold:3/,
    );
  });
});
