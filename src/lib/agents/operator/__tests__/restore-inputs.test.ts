import { describe, expect, it } from 'vitest';
import { proposableOperation } from '../catalog';
import { deriveRestoreInput, hasRestoreInput, parseRestoreInput, type RestoreSource } from '../restore-inputs';
import { PROPOSAL_STATUS, type PolicyReceipt, type VoiceReceipt } from '../schema';

const ACCOUNT = '00000000-0000-7000-8000-000000000001';
const LOCATION = '00000000-0000-7000-8000-000000000002';
const TURN = '00000000-0000-7000-8000-000000000003';
const SOURCE = '00000000-0000-7000-8000-000000000004';
const FOREIGN = '00000000-0000-7000-8000-000000000005';
const AT = '2026-09-14T12:00:00Z';
const VOICE = {
  tone: null, productsServices: null, avoidFacts: ['prices'],
  highlightFacts: ['appointments'], sampleResponses: ['Existing sample'],
};

function voiceReceipt(): VoiceReceipt {
  return {
    version: 1, operation: 'set_tone', scope: { accountId: ACCOUNT, locationId: LOCATION },
    before: { ...VOICE }, after: { ...VOICE, tone: 'warm' },
    differsFromPreview: false, effectiveNow: true, affects: 'future_drafts',
    remainingBlocked: [], appliedAt: AT, actorUserId: ACCOUNT, actorName: 'Owner',
    ownerText: 'Use a warm tone', turnId: TURN,
    versionToken: {
      before: { businessId: LOCATION, updatedAt: 'before' },
      after: { businessId: LOCATION, updatedAt: 'after' },
    },
  };
}

function policyReceipt(locationId: string | null = LOCATION): PolicyReceipt {
  const consequence = {
    total: 0, eligible: 0, held: { below_threshold: 0, cap_reached: 0, manual: 0 },
    byDay: [], busiestDay: 0, windowStart: AT, windowEnd: AT, asOf: AT,
    source: 'reviews_received_30d' as const, excludedImported: 0, excludedUnknown: 0,
  };
  const before = {
    domain: 'policy' as const, threshold: 5 as const, vetoWindowMinutes: 30 as const,
    dailyAutoPostCap: 2, effectiveDailyCap: 2, rowExists: true,
    consequence, affectedLocationCount: 1,
  };
  const token = {
    accountDefaultRow: { id: 'absent' as const },
    ...(locationId === null ? {} : { locationRow: { id: SOURCE, updatedAt: AT } }),
  };
  return {
    version: 1, operation: 'set_daily_cap', scope: { accountId: ACCOUNT, locationId },
    before, after: { ...before, dailyAutoPostCap: 3, effectiveDailyCap: 3 },
    differsFromPreview: false, effectiveNow: true, affects: 'future_eligible_reviews',
    remainingBlocked: [], appliedAt: AT, actorUserId: ACCOUNT, actorName: 'Owner',
    ownerText: 'Change the cap', turnId: TURN, versionToken: { before: token, after: token },
    retainedVeto: { count: 0, asOf: AT },
  };
}

function source(receipt: VoiceReceipt | PolicyReceipt = voiceReceipt()): RestoreSource {
  return {
    id: SOURCE, operation: receipt.operation, contractVersion: 1,
    locationId: receipt.scope.locationId, status: PROPOSAL_STATUS.APPLIED,
    turnId: TURN, receipt,
  };
}

function request(row: RestoreSource = source()) {
  return {
    accountId: ACCOUNT, operation: row.operation, contractVersion: 1,
    locationId: row.locationId, source: row,
  };
}

describe('Restore provenance', () => {
  it('accepts only the closed server-created envelope', () => {
    const value = { restore: { sourceProposalId: SOURCE } };
    expect(hasRestoreInput(value)).toBe(true);
    expect(parseRestoreInput(value)).toEqual({ sourceProposalId: SOURCE });
    for (const malformed of [
      { restore: null }, { restore: {} }, { restore: { sourceProposalId: 'invalid' } },
      { restore: { sourceProposalId: SOURCE, tone: 'fabricated' } },
      { ...value, tone: 'fabricated' }, { restore: undefined },
    ]) {
      expect(hasRestoreInput(malformed)).toBe(true);
      expect(parseRestoreInput(malformed)).toBeNull();
    }
    for (const ordinary of [null, [], 'restore', { tone: 'warm' }, {}]) {
      expect(hasRestoreInput(ordinary)).toBe(false);
      expect(parseRestoreInput(ordinary)).toBeNull();
    }
  });
});

describe('validated Receipt inverses', () => {
  it('restores null tone without widening the ordinary model input or writing unrelated voice fields', () => {
    expect(proposableOperation('set_tone')?.parseInput({ tone: null }).ok).toBe(false);
    expect(deriveRestoreInput(request())).toEqual({ domain: 'voice', input: { tone: null }, fields: { tone: null } });
  });

  it.each([
    ['set_products_services', { productsServices: null }],
    ['set_avoid_facts', { avoidFacts: ['prices'] }],
    ['set_highlight_facts', { highlightFacts: ['appointments'] }],
  ])('restores only the field owned by %s', (operation, fields) => {
    const receipt = { ...voiceReceipt(), operation };
    const result = deriveRestoreInput(request(source(receipt)));
    expect(result).toEqual({ domain: 'voice', input: fields, fields });
    if (result?.domain === 'voice' && Array.isArray(result.fields.avoidFacts)) {
      result.fields.avoidFacts.push('new');
      expect(receipt.before.avoidFacts).toEqual(['prices']);
    }
  });

  it('preserves absent account defaults and single-dial policy inverses', () => {
    expect(deriveRestoreInput(request(source(policyReceipt())))).toEqual({
      domain: 'policy', patch: { operation: 'set_location_daily_cap', locationId: LOCATION, cap: 2 },
    });
    const receipt = policyReceipt(null);
    receipt.before.rowExists = false;
    expect(deriveRestoreInput(request(source(receipt)))).toEqual({
      domain: 'policy', patch: { operation: 'clear_account_default' },
    });
  });

  it('restores all cleared override dials and derives undo from the immediate receipt', () => {
    const receipt = policyReceipt();
    receipt.operation = 'clear_location_override';
    receipt.before.dailyAutoPostCap = null;
    receipt.after.rowExists = false;
    expect(deriveRestoreInput(request(source(receipt)))).toEqual({
      domain: 'policy', patch: {
        operation: 'restore_reply_policy', locationId: LOCATION,
        state: { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: null },
      },
    });
    const undo = { ...receipt, before: receipt.after, after: receipt.before };
    expect(deriveRestoreInput(request(source(undo)))).toEqual({
      domain: 'policy', patch: { operation: 'delete_location_override', locationId: LOCATION },
    });
  });

  it('rejects missing, unsettled, obsolete, foreign and mismatched source evidence', () => {
    const original = request();
    const invalid = [
      { ...original, accountId: FOREIGN },
      { ...original, locationId: FOREIGN },
      { ...original, operation: 'set_avoid_facts' },
      { ...original, contractVersion: 2 },
      ...[
        { receipt: null }, { id: 'invalid' }, { status: PROPOSAL_STATUS.PENDING },
        { status: PROPOSAL_STATUS.STALE }, { contractVersion: 2 }, { turnId: FOREIGN },
        { locationId: FOREIGN }, { operation: 'removed_operation' },
        { receipt: { ...voiceReceipt(), operation: 'set_avoid_facts' } },
        { receipt: { ...voiceReceipt(), scope: { accountId: FOREIGN, locationId: LOCATION } } },
      ].map((change) => ({ ...original, source: { ...original.source, ...change } })),
    ];
    for (const candidate of invalid) expect(deriveRestoreInput(candidate)).toBeNull();
  });

  it('rejects malformed receipt state and a shape-valid receipt from the wrong domain', () => {
    const malformed = { ...voiceReceipt(), before: { ...VOICE, tone: 123 } } as unknown as VoiceReceipt;
    expect(deriveRestoreInput(request(source(malformed)))).toBeNull();
    const wrongDomain = { ...policyReceipt(), operation: 'set_tone' };
    expect(deriveRestoreInput(request(source(wrongDomain)))).toBeNull();
    const wrongScope = { ...policyReceipt(null), operation: 'clear_location_override' };
    expect(deriveRestoreInput(request(source(wrongScope)))).toBeNull();
  });
});
