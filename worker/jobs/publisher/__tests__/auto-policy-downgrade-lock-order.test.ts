import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('auto-policy downgrade lock and ownership source shape', () => {
  it('locks reviews, business, and response before attempt ownership and durable writes', () => {
    const source = readFileSync(
      new URL('../auto-policy-downgrade.ts', import.meta.url),
      'utf8',
    );
    const body = source.slice(source.indexOf('export async function'));
    const anchor = body.indexOf('anchorReviewLockOrder(');
    const businessLock = body.indexOf('FROM businesses', anchor);
    const responseLock = body.indexOf('FROM responses', businessLock);
    const attemptClaim = body.indexOf('markOutboxCompletedIfOwned(', responseLock);
    const responseMutation = body.indexOf('UPDATE responses', attemptClaim);
    const auditWrite = body.indexOf('insertAuditLogAutoPolicy(', responseMutation);
    const notificationWrite = body.indexOf('enqueueSendNotification(', auditWrite);

    expect(anchor).toBeGreaterThan(-1);
    expect(businessLock).toBeGreaterThan(anchor);
    expect(body.slice(businessLock, responseLock)).toContain('FOR UPDATE');
    expect(responseLock).toBeGreaterThan(businessLock);
    expect(body.slice(responseLock, attemptClaim)).toContain('FOR UPDATE');
    expect(attemptClaim).toBeGreaterThan(responseLock);
    expect(responseMutation).toBeGreaterThan(attemptClaim);
    expect(auditWrite).toBeGreaterThan(responseMutation);
    expect(notificationWrite).toBeGreaterThan(auditWrite);
    expect(body).not.toMatch(/\b(?:completeRun|recordOutcome|recordStep)\s*\(/);
  });
});
