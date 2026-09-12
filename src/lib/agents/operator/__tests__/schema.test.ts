import { describe, it, expect } from 'vitest';
import {
  asProposalStatus,
  asTurnStatus,
  OperatorModelOutputSchema,
  PROPOSAL_STATUS,
  TURN_STATUS,
} from '../schema';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';

const MINIMAL = {
  segments: [{ type: 'text', text: 'Here is the plan.' }],
  proposals: [],
  unsupported: [],
};

const PROPOSAL = {
  operation: 'set_tone',
  scope: { accountId: ACCOUNT, locationId: LOCATION },
  input: { tone: 'warm' },
  rationale: 'You asked for shorter replies.',
};

/** Every field the model must not be able to emit, at any level. */
const FORBIDDEN = ['count', 'counts', 'approved', 'approval', 'confirmation',
  'requiresConfirmation', 'receipt', 'applied', 'appliedAt'] as const;

describe('operator model output schema', () => {
  it('model output schema has no field for counts, approval, confirmation, or receipts', () => {
    expect(OperatorModelOutputSchema.safeParse(MINIMAL).success).toBe(true);

    for (const key of FORBIDDEN) {
      // Top level.
      expect(OperatorModelOutputSchema.safeParse({ ...MINIMAL, [key]: 1 }).success, `top ${key}`)
        .toBe(false);
      // Inside a segment.
      expect(OperatorModelOutputSchema.safeParse({
        ...MINIMAL,
        segments: [{ type: 'text', text: 'ok', [key]: 1 }],
      }).success, `segment ${key}`).toBe(false);
      // Inside a proposal, and inside its scope.
      expect(OperatorModelOutputSchema.safeParse({
        ...MINIMAL, proposals: [{ ...PROPOSAL, [key]: 1 }],
      }).success, `proposal ${key}`).toBe(false);
      expect(OperatorModelOutputSchema.safeParse({
        ...MINIMAL,
        proposals: [{ ...PROPOSAL, scope: { accountId: ACCOUNT, locationId: LOCATION, [key]: 1 } }],
      }).success, `scope ${key}`).toBe(false);
      // Inside an unsupported request.
      expect(OperatorModelOutputSchema.safeParse({
        ...MINIMAL, unsupported: [{ request: 'x', context: '', [key]: 1 }],
      }).success, `unsupported ${key}`).toBe(false);
    }

    // `.strict()` everywhere is the mechanism: ANY unknown key is a rejection,
    // which is what makes the absence a property of the schema rather than a
    // list someone has to keep extending.
    expect(OperatorModelOutputSchema.safeParse({ ...MINIMAL, somethingNew: true }).success).toBe(false);
    expect(OperatorModelOutputSchema.safeParse({
      ...MINIMAL, segments: [{ type: 'status_ref', metric: 'pending_count', value: 3 }],
    }).success).toBe(false);
    // A `status_ref` carries the metric NAME and nothing else.
    expect(OperatorModelOutputSchema.safeParse({
      ...MINIMAL, segments: [{ type: 'status_ref', metric: 'pending_count' }],
    }).success).toBe(true);
    // The server-only segment is not a model segment.
    expect(OperatorModelOutputSchema.safeParse({
      ...MINIMAL, segments: [{ type: 'server_notice', notice: 'pasted_review_removed' }],
    }).success).toBe(false);
    expect(OperatorModelOutputSchema.safeParse({
      ...MINIMAL,
      segments: [{ type: 'status', metric: 'pending_count', value: 3, reportingPeriodDays: 7, asOf: '2026-09-11T10:00:00.000Z' }],
    }).success).toBe(false);
  });

  it('status narrowings throw on a value no writer produces', () => {
    // Both columns carry a CHECK constraint (migration 120), so a value outside
    // the vocabulary means the row was written by something that is not this
    // codebase. A THROW, not a silent widening back to `string` — the reads
    // that call these hand their result straight to the owner's screen.
    for (const status of Object.values(TURN_STATUS)) {
      expect(asTurnStatus(status)).toBe(status);
    }
    for (const status of Object.values(PROPOSAL_STATUS)) {
      expect(asProposalStatus(status)).toBe(status);
    }

    expect(() => asTurnStatus('archived')).toThrow(/agent_turns\.status/);
    expect(() => asTurnStatus('')).toThrow();
    // Each narrowing owns ITS OWN vocabulary: a legal PROPOSAL status is not a
    // legal turn status, and vice versa.
    expect(() => asTurnStatus(PROPOSAL_STATUS.SUPERSEDED)).toThrow(/agent_turns\.status/);
    expect(() => asProposalStatus('archived')).toThrow(/agent_proposals\.status/);
    expect(() => asProposalStatus(TURN_STATUS.ACCEPTED)).toThrow(/agent_proposals\.status/);
  });
});
