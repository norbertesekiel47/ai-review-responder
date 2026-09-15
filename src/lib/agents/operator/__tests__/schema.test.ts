import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  asProposalStatus,
  asTurnStatus,
  OperatorModelOutputSchema,
  parsePolicyState,
  parseReceipt,
  parseStoredPolicyState,
  parseVoiceState,
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

type JsonNode = Record<string, unknown>;

function isJsonNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function admitsNull(node: JsonNode): boolean {
  if (node.type === 'null') return true;
  if (Array.isArray(node.type) && node.type.includes('null')) return true;
  return Array.isArray(node.anyOf) && node.anyOf.some((option) => isJsonNode(option) && admitsNull(option));
}

/**
 * The strict-provider rules this schema itself must satisfy: every object is
 * closed and has properties, and a property may be absent only if it is also
 * nullable (the installed OpenAI helper throws otherwise). `oneOf` is NOT
 * checked here: the provider seam rewrites discriminated unions.
 */
function strictProviderViolations(node: unknown, path: string): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => strictProviderViolations(child, `${path}/${index}`));
  }
  if (!isJsonNode(node)) return [];
  const violations: string[] = [];
  if (node.type === 'object') {
    const properties = isJsonNode(node.properties) ? node.properties : {};
    const required = Array.isArray(node.required) ? node.required : [];
    // Closed empty input is valid for clear_location_override; an open record
    // remains rejected by additionalProperties below.
    if (!isJsonNode(node.properties)) violations.push(`${path}: object without properties`);
    if (node.additionalProperties !== false) violations.push(`${path}: additionalProperties is not false`);
    for (const [key, property] of Object.entries(properties)) {
      if (!required.includes(key) && !(isJsonNode(property) && admitsNull(property))) {
        violations.push(`${path}/properties/${key}: optional without nullable`);
      }
    }
  }
  for (const [key, child] of Object.entries(node)) {
    violations.push(...strictProviderViolations(child, `${path}/${key}`));
  }
  return violations;
}

describe('operator model output schema', () => {
  it('allows only scope and empty input for restore_last, never receipt IDs or prior state', () => {
    const restore = { ...PROPOSAL, operation: 'restore_last', input: {} };
    const accepts = (proposal: unknown) => OperatorModelOutputSchema.safeParse({ ...MINIMAL, proposals: [proposal] }).success;
    expect(accepts(restore)).toBe(true);
    expect(accepts({ ...restore, scope: { accountId: ACCOUNT, locationId: null } })).toBe(true);
    for (const input of [{ sourceProposalId: LOCATION }, { tone: null }, { restore: { sourceProposalId: LOCATION } }]) {
      expect(accepts({ ...restore, input })).toBe(false);
    }
    expect(accepts({ ...restore, receipt: {} })).toBe(false);
  });

  it('accepts only a closed refusal reason and rejects fabricated wording, scope, category and durable IDs', () => {
    const reasons = ['invented_business_fact', 'customer_data_exposure', 'reviewer_disparagement',
      'review_incentive', 'review_edit_pressure', 'competitor_review_reply'];
    for (const reason of reasons) {
      const segment = { type: 'refusal_ref', reason };
      expect(OperatorModelOutputSchema.safeParse({ ...MINIMAL, segments: [segment] }).success, reason).toBe(true);
      for (const key of ['text', 'scope', 'category', 'subjectId', 'businessId', ...FORBIDDEN]) {
        expect(OperatorModelOutputSchema.safeParse({
          ...MINIMAL, segments: [{ ...segment, [key]: 'fabricated' }],
        }).success, key).toBe(false);
      }
    }
    expect(OperatorModelOutputSchema.safeParse({
      ...MINIMAL, segments: [{ type: 'refusal_ref', reason: 'made_up' }],
    }).success).toBe(false);
    expect(OperatorModelOutputSchema.safeParse({
      ...MINIMAL, segments: [{ type: 'refusal', reason: reasons[0], subjectId: LOCATION }],
    }).success).toBe(false);
  });

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
      // Inside a proposal's input: the input is finite per operation now.
      expect(OperatorModelOutputSchema.safeParse({
        ...MINIMAL, proposals: [{ ...PROPOSAL, input: { ...PROPOSAL.input, [key]: 1 } }],
      }).success, `input ${key}`).toBe(false);
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

  it('the proposal wire shape is finite: each operation carries exactly its own input, and a null or absent locationId is the account default', () => {
    const accepts = (proposal: unknown) =>
      OperatorModelOutputSchema.safeParse({ ...MINIMAL, proposals: [proposal] }).success;

    expect(accepts(PROPOSAL)).toBe(true);
    // Arbitrary input keys, another operation's input, and an empty input.
    expect(accepts({ ...PROPOSAL, input: { tone: 'warm', extra: 1 } })).toBe(false);
    expect(accepts({ ...PROPOSAL, input: { minutes: 15 } })).toBe(false);
    expect(accepts({ ...PROPOSAL, input: {} })).toBe(false);
    // An operation outside the catalog now fails at SHAPE, before the validator.
    expect(accepts({ ...PROPOSAL, operation: 'set_business_hours' })).toBe(false);
    expect(accepts({ ...PROPOSAL, operation: 'read_pending_work', input: {} })).toBe(false);

    const cap = {
      operation: 'set_daily_cap',
      scope: { accountId: ACCOUNT, locationId: null },
      input: { cap: null },
      rationale: 'You asked me to use the default limit.',
    };
    expect(accepts(cap)).toBe(true);
    expect(accepts({ ...cap, scope: { accountId: ACCOUNT } })).toBe(true);
    expect(accepts({ ...cap, scope: { accountId: ACCOUNT, locationId: LOCATION } })).toBe(true);
    expect(accepts({ ...cap, input: { cap: 51 } })).toBe(false);
    expect(accepts({ ...cap, scope: { accountId: ACCOUNT, locationId: 'not-a-uuid' } })).toBe(false);
    expect(accepts({ ...cap, operation: 'set_veto_window', input: { minutes: 20 } })).toBe(false);
    expect(accepts({ ...cap, operation: 'set_auto_reply_scope', input: { threshold: 3 } })).toBe(false);
    expect(accepts({ ...PROPOSAL, operation: 'clear_location_override', input: {} })).toBe(true);
    expect(accepts({ ...PROPOSAL, operation: 'clear_location_override', input: { restore: true } })).toBe(false);

    // The wire does not encode tenancy: a foreign uuid is shape-valid, and the
    // semantic validator refuses it (render.test.ts).
    expect(accepts({ ...PROPOSAL, scope: { accountId: '00000000-0000-7000-8000-00000000ac99', locationId: LOCATION } }))
      .toBe(true);

    const operations = OperatorModelOutputSchema.shape.proposals.element.options
      .map((option) => option.shape.operation.value)
      .sort();
    expect(operations).toEqual([
      'clear_location_override',
      'restore_last',
      'set_auto_reply_scope',
      'set_avoid_facts',
      'set_daily_cap',
      'set_highlight_facts',
      'set_products_services',
      'set_tone',
      'set_veto_window',
    ]);
  });

  it('the model output schema converts to JSON Schema that meets the strict-provider object rules', () => {
    expect(strictProviderViolations(z.toJSONSchema(OperatorModelOutputSchema), '#')).toEqual([]);
    // The walker is not vacuous: it flags the two shapes the old schema had.
    expect(strictProviderViolations(z.toJSONSchema(z.object({ locationId: z.uuid().optional() }).strict()), '#'))
      .not.toEqual([]);
    expect(strictProviderViolations(z.toJSONSchema(z.object({ input: z.record(z.string(), z.unknown()) }).strict()), '#'))
      .not.toEqual([]);
  });

  it('a policy state parses with its discriminant, and voice and policy states never parse as each other', () => {
    const policy = {
      domain: 'policy', threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: null, effectiveDailyCap: 10, rowExists: false,
    };
    expect(parsePolicyState(policy, 'agent_proposals.before')).toEqual(policy);
    expect(() => parsePolicyState({ ...policy, extra: 1 }, 'agent_proposals.before')).toThrow(/policy state/);
    expect(() => parsePolicyState({ ...policy, vetoWindowMinutes: 20 }, 'agent_proposals.before')).toThrow();
    expect(() => parsePolicyState({ ...policy, domain: undefined }, 'agent_proposals.before')).toThrow();

    // The Run A six-key voice state still parses, and stays voice-only.
    const legacyVoice = {
      tone: 'warm', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
      updatedAt: '2026-09-11 10:00:00.123456+00',
    };
    expect(parseVoiceState(legacyVoice, 'agent_proposals.before')).not.toHaveProperty('updatedAt');
    expect(() => parsePolicyState(legacyVoice, 'agent_proposals.before')).toThrow();
    expect(() => parseVoiceState(policy, 'agent_proposals.before')).toThrow();
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

describe('stored policy metadata and receipts', () => {
  const STATE = {
    domain: 'policy', threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: null, effectiveDailyCap: 10, rowExists: true,
  };
  const LINE = {
    total: 2, eligible: 1, held: { below_threshold: 1, cap_reached: 0, manual: 0 },
    byDay: [{ day: '2026-09-01', total: 2, eligible: 1, held: 1 }], busiestDay: 2,
    windowStart: '2026-08-14 03:00:00+00', windowEnd: '2026-09-13 03:00:00+00',
    asOf: '2026-09-13 03:00:00+00', source: 'reviews_received_30d', excludedImported: 0, excludedUnknown: 5,
  };

  it('parsePolicyState strips server metadata; the stored parser keeps it and pins its shape', () => {
    const stored = { ...STATE, consequence: LINE, affectedLocationCount: 2, expansionBlockedBy: ['autopilot_unavailable'] };
    expect(parsePolicyState(stored, 'agent_proposals.after')).toEqual(STATE);
    expect(parseStoredPolicyState(stored, 'agent_proposals.after')).toEqual(stored);

    expect(() => parseStoredPolicyState({ ...STATE, expansionBlockedBy: ['made_up'] }, 'c')).toThrow();
    expect(() => parseStoredPolicyState({ ...STATE, consequence: { ...LINE, excludedUnknown: -1 } }, 'c')).toThrow();
    expect(() => parseStoredPolicyState({ ...STATE, consequence: { ...LINE, source: 'all_time' } }, 'c')).toThrow();
    // eligible + held must partition total.
    expect(() => parseStoredPolicyState({ ...STATE, consequence: { ...LINE, eligible: 2 } }, 'c')).toThrow();
  });

  it('policy and voice receipts are disjoint arms of one parser', () => {
    const policy = {
      version: 1,
      operation: 'set_auto_reply_scope',
      scope: { accountId: ACCOUNT, locationId: null },
      before: { ...STATE, threshold: null, consequence: LINE, affectedLocationCount: 2 },
      after: { ...STATE, consequence: LINE, affectedLocationCount: 2 },
      differsFromPreview: false,
      effectiveNow: true,
      affects: 'future_eligible_reviews',
      remainingBlocked: [],
      appliedAt: '2026-09-13T03:00:00.000Z',
      actorUserId: ACCOUNT,
      actorName: null,
      ownerText: 'Let the good ones post.',
      turnId: ACCOUNT,
      versionToken: {
        before: { accountDefaultRow: { id: 'absent' } },
        after: { accountDefaultRow: { id: LOCATION, updatedAt: '2026-09-13 03:00:00.1+00' } },
      },
      retainedVeto: { count: 1, asOf: '2026-09-13 03:00:00+00' },
    };
    expect(parseReceipt(JSON.stringify(policy))).toEqual(policy);

    // A policy receipt with a voice token, a missing line or no retained count is refused.
    expect(() => parseReceipt({ ...policy, versionToken: { before: { businessId: LOCATION, updatedAt: 'x' }, after: policy.versionToken.after } })).toThrow();
    expect(() => parseReceipt({ ...policy, after: STATE })).toThrow();
    const { retainedVeto: _retained, ...withoutRetained } = policy;
    expect(() => parseReceipt(withoutRetained)).toThrow();
    // A voice-state before under the policy arm is refused.
    expect(() => parseReceipt({
      ...policy,
      before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
    })).toThrow();
  });
});
