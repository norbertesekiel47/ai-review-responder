import { describe, expect, it } from 'vitest';
import {
  AUTO_APPROVAL_THRESHOLD_LABELS,
  autoApprovalThresholdLabel,
} from '@/lib/auto-approval/types';

describe('auto-approval threshold labels', () => {
  it('maps every auto-approval threshold to its label', () => {
    expect(AUTO_APPROVAL_THRESHOLD_LABELS).toEqual({ 4: '4–5★', 5: '5★ only' });
    expect(autoApprovalThresholdLabel(null)).toBe('Off');
    expect(autoApprovalThresholdLabel(5)).toBe('5★ only');
    expect(autoApprovalThresholdLabel(4)).toBe('4–5★');
  });
});
