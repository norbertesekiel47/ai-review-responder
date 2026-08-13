import { describe, expect, it } from 'vitest';
import { classifyOutboxStatus, OUTBOX_IN_FLIGHT_STATUSES } from '../job-outbox-status';

describe('classifyOutboxStatus', () => {
  it('maps every canonical in-flight status, completed, and terminal statuses', () => {
    for (const status of OUTBOX_IN_FLIGHT_STATUSES) {
      expect(classifyOutboxStatus(status)).toBe('in_flight');
    }
    expect(classifyOutboxStatus('completed')).toBe('completed');
    expect(classifyOutboxStatus('failed')).toBe('terminal');
    expect(classifyOutboxStatus('cancelled')).toBe('terminal');
    expect(classifyOutboxStatus('unknown_future_status')).toBe('terminal');
  });
});
