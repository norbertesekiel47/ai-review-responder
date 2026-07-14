import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  const nextExport = source.indexOf('\nexport async function ', start + 1);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, nextExport === -1 ? undefined : nextExport);
}

describe('autonomy account-lock source order', () => {
  it.each([
    ['suspendAccountAutonomy', 'INSERT INTO auto_approval_policies'],
    ['unsuspendAccountAutonomy', 'WITH target AS'],
  ])('%s locks the guaranteed account row before policy mutation', (name, mutation) => {
    const source = readFileSync(new URL('../suspension.ts', import.meta.url), 'utf8');
    const body = functionBody(source, name);
    const accountLock = body.indexOf('lockAutonomyAccount(');
    const policyMutation = body.indexOf(mutation);

    expect(accountLock).toBeGreaterThan(-1);
    expect(policyMutation).toBeGreaterThan(accountLock);
  });

  it('governor revalidation locks the account before policy and audit reads', () => {
    const source = readFileSync(new URL('../governor.ts', import.meta.url), 'utf8');
    const body = functionBody(source, 'revalidateGovernorCandidate');
    const accountLock = body.indexOf('lockAutonomyAccount(');
    const policyRead = body.indexOf('FROM auto_approval_policies');
    const auditRead = body.indexOf('FROM account_audit_log');

    expect(accountLock).toBeGreaterThan(-1);
    expect(policyRead).toBeGreaterThan(accountLock);
    expect(auditRead).toBeGreaterThan(policyRead);
  });
});
