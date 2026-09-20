import { describe, it, expect } from 'vitest';
import {
  materializeReply,
  REVIEW_TEXT_REMOVED_MARKER,
  renderSegments,
  scrubPastedReview,
  semanticRejectionCodes,
  validateModelOutput,
} from '../render';
import { modelVisibleOperations } from '../catalog';
import type { Snapshot } from '../context';
import { parseReplySegments, type Segment } from '../schema';
import { OPERATOR_REFUSAL_REASONS, OPERATOR_REFUSAL_RULES } from '../refusals';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';
const OTHER_LOCATION = '00000000-0000-7000-8000-00000000b102';

const snapshot: Snapshot = {
  accountId: ACCOUNT,
  locationId: LOCATION,
  locationName: 'Salon',
  subscriptionTier: 'copilot',
  turns: [],
  pendingProposals: [],
  operatingRules: {
    // `null` is the T5 `RuleSummary` spelling of "no threshold is set" — the
    // plan's fixture said 'manual', which the declared type does not admit.
    account: { threshold: null, vetoWindowMinutes: 30, dailyCap: 10 },
    location: { threshold: null, vetoWindowMinutes: 30, dailyCap: 10 },
    locationOverrideExists: false,
  },
  posting: { blocked: false, reasons: [], sentences: [], correctionOwed: false },
  facts: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [] },
  allowedOperations: [
    { id: 'set_tone', kind: 'proposable', labelKind: 'fact', describe: 'Set the reply tone' },
    { id: 'set_avoid_facts', kind: 'proposable', labelKind: 'fact', describe: 'Set what to keep out' },
    { id: 'read_pending_work', kind: 'read', labelKind: null, describe: 'Count what is waiting' },
  ],
  locations: [
    { id: LOCATION, name: 'Salon' },
    { id: OTHER_LOCATION, name: 'Cafe' },
  ],
  metrics: {
    pendingCount: 3,
    draftsWaiting: 4,
    posted7d: 9,
    starBands: { locationId: LOCATION, total: 3, byStar: { '1': 1, '2': 0, '3': 0, '4': 1, '5': 1 } },
    accountStarBands: { locationId: null, total: 4, byStar: { '1': 1, '2': 0, '3': 0, '4': 1, '5': 2 } },
    reportingPeriodDays: 7,
    asOf: '2026-09-11T10:00:00.000Z',
  },
};

function output(overrides: Partial<{
  segments: unknown[]; proposals: unknown[]; unsupported: unknown[];
}> = {}) {
  return {
    segments: [{ type: 'text', text: 'Here is what I can do.' }],
    proposals: [],
    unsupported: [],
    ...overrides,
  } as never;
}

const toneProposal = {
  operation: 'set_tone',
  scope: { accountId: ACCOUNT, locationId: LOCATION },
  input: { tone: 'warm and brief' },
  rationale: 'You asked for shorter replies.',
};

describe('operator output validator', () => {
  it('distinguishes completion, scope and reference rejection diagnostics from real validation', () => {
    const result = validateModelOutput(output({
      segments: [
        { type: 'text', text: 'I have updated your tone.' },
        { type: 'scope_check', locationId: LOCATION },
        { type: 'proposal_ref', index: 0 },
      ],
    }), snapshot);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected semantic rejection');
    expect(semanticRejectionCodes(result.reasons)).toEqual([
      'completion_claim', 'invalid_proposal_ref', 'scope_check_current_location',
    ]);
  });

  it('never copies model-controlled reason suffixes or unknown reasons into diagnostic codes', () => {
    const privateText = 'PRIVATE_SENTINEL\n{"owner_text":"DO_NOT_LOG"}';
    const codes = semanticRejectionCodes([
      `status_ref names a metric outside the snapshot: ${privateText}`,
      `proposal names an operation outside the catalog: ${privateText}`,
      `proposal names an operation this account may not use: ${privateText}`,
      `proposal scope must name the stored location for ${privateText}`,
      `proposal input is outside the domain for ${privateText}`,
      privateText,
      '__proto__',
    ]);
    expect(codes).toEqual([
      'unknown_status_metric', 'unknown_operation', 'operation_unavailable',
      'proposal_location_required', 'invalid_operation_input',
      'unknown_semantic_rejection', 'unknown_semantic_rejection',
    ]);
    expect(JSON.stringify(codes)).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(codes)).not.toContain('DO_NOT_LOG');
    expect(semanticRejectionCodes([])).toEqual([]);
  });

  it('keeps ordinary proposals separate from indexed Restore requests in a mixed refusal reply', () => {
    const ready = { ...snapshot, allowedOperations: modelVisibleOperations({ blockReasons: [] }) };
    const restore = { ...toneProposal, operation: 'restore_last', input: {} };
    const result = validateModelOutput(output({
      proposals: [restore, toneProposal, { ...restore, scope: { accountId: ACCOUNT, locationId: null } }],
      segments: [{ type: 'proposal_ref', index: 0 }, { type: 'refusal_ref', reason: 'review_incentive' },
        { type: 'proposal_ref', index: 1 }, { type: 'proposal_ref', index: 2 }],
    }), ready);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.map((proposal) => proposal.operation.id)).toEqual(['set_tone']);
    expect(result.restoreRequests).toEqual([
      { index: 0, scope: { accountId: ACCOUNT, locationId: LOCATION } },
      { index: 2, scope: { accountId: ACCOUNT } },
    ]);
    expect(materializeReply({
      segments: result.output.segments, metrics: snapshot.metrics, scrubbed: false,
      proposalIds: ['location-restore', 'ordinary', 'account-restore'], refusalIds: { review_incentive: 'subject' },
    })).toEqual([
      { type: 'proposal', proposalId: 'location-restore' },
      { type: 'refusal', reason: 'review_incentive', subjectId: 'subject' },
      { type: 'proposal', proposalId: 'ordinary' }, { type: 'proposal', proposalId: 'account-restore' },
    ]);
  });

  it('refuses Restore requests for foreign scopes, missing availability, or fabricated state', () => {
    const ready = { ...snapshot, allowedOperations: modelVisibleOperations({ blockReasons: [] }) };
    const restore = { ...toneProposal, operation: 'restore_last', input: {} };
    for (const candidate of [
      { ...restore, scope: { accountId: OTHER_LOCATION, locationId: LOCATION } },
      { ...restore, scope: { accountId: ACCOUNT, locationId: OTHER_LOCATION } },
      { ...restore, input: { sourceProposalId: LOCATION } },
    ]) expect(validateModelOutput(output({ proposals: [candidate] }), ready).ok).toBe(false);
    expect(validateModelOutput(output({ proposals: [restore] }), snapshot).ok).toBe(false);
  });

  it('clear_location_override requires the stored location and an empty ordinary input', () => {
    const readySnapshot = { ...snapshot, allowedOperations: modelVisibleOperations({ blockReasons: [] }) };
    const clear = { ...toneProposal, operation: 'clear_location_override', input: {} };
    expect(validateModelOutput(output({ proposals: [clear] }), readySnapshot).ok).toBe(true);
    expect(validateModelOutput(output({ proposals: [{ ...clear, scope: { accountId: ACCOUNT, locationId: null } }] }), readySnapshot).ok).toBe(false);
  });

  it('materializes every refusal into a durable subject and renders the fixed rule after reload', () => {
    for (const reason of OPERATOR_REFUSAL_REASONS) {
      const stored = materializeReply({
        segments: [{ type: 'refusal_ref', reason }], metrics: snapshot.metrics, proposalIds: [],
        refusalIds: { [reason]: LOCATION }, scrubbed: false,
      });
      expect(stored).toEqual([{ type: 'refusal', reason, subjectId: LOCATION }]);
      expect(renderSegments(parseReplySegments(JSON.stringify(stored)), { locations: [] })).toEqual([
        { type: 'refusal', reason, subjectId: LOCATION, text: OPERATOR_REFUSAL_RULES[reason].rule },
      ]);
    }
  });

  it('throws when a refusal has no server ID instead of silently dropping its durable record', () => {
    expect(() => materializeReply({
      segments: [{ type: 'refusal_ref', reason: 'invented_business_fact' }],
      metrics: snapshot.metrics, proposalIds: [], scrubbed: false,
    })).toThrow('refusal_ref has no server-minted subject ID');
  });

  it('stored refusal segments require a UUID and reject model references or fabricated wording', () => {
    const stored = { type: 'refusal', reason: 'invented_business_fact', subjectId: LOCATION };
    expect(() => parseReplySegments([{ ...stored, subjectId: 'not-a-uuid' }])).toThrow();
    expect(() => parseReplySegments([{ ...stored, reason: 'made_up' }])).toThrow();
    expect(() => parseReplySegments([{ ...stored, text: 'Fake clause' }])).toThrow();
    expect(() => parseReplySegments([{ type: 'refusal_ref', reason: stored.reason }])).toThrow();
  });

  it('rejects duplicate identical refusal references while accepting distinct same-lane reasons', () => {
    const first = { type: 'refusal_ref', reason: 'invented_business_fact' };
    const duplicate = validateModelOutput(output({ segments: [first, first] }), snapshot);
    expect(duplicate.ok).toBe(false);
    expect(!duplicate.ok && duplicate.reasons.join(' ')).toContain('duplicate refusal_ref');
    expect(validateModelOutput(output({ segments: [first,
      { type: 'refusal_ref', reason: 'customer_data_exposure' },
    ] }), snapshot).ok).toBe(true);
  });

  it('validator rejects a text segment that invents a count next to a metric word', () => {
    const result = validateModelOutput(
      output({ segments: [{ type: 'text', text: 'You have 3 reviews waiting.' }] }),
      snapshot,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasons.join(' ')).toContain('count');
    // The same sentence as a status_ref is legal: the server renders the number.
    expect(validateModelOutput(
      output({ segments: [{ type: 'status_ref', metric: 'pending_count' }] }),
      snapshot,
    ).ok).toBe(true);
  });

  it('validator rejects a text segment that claims a change was applied before any click', () => {
    for (const text of [
      'I have updated your tone.',
      'Done — that is now active.',
      'Saved. Your avoid list is changed.',
    ]) {
      const result = validateModelOutput(output({ segments: [{ type: 'text', text }] }), snapshot);
      expect(result.ok, text).toBe(false);
      expect(result.ok === false && result.reasons.join(' ')).toContain('completion');
    }
    expect(validateModelOutput(
      output({ segments: [{ type: 'text', text: 'Apply the card below and I will use it next time.' }] }),
      snapshot,
    ).ok).toBe(true);
  });

  it('validator applies the count and completion patterns to question segments, not only text', () => {
    // A `question` is model prose in the same sentence position as a `text`:
    // it reaches the owner identically and can invent a number or claim a
    // change just as easily. Both patterns run over both members.
    const invented = validateModelOutput(
      output({ segments: [{ type: 'question', text: 'You have 3 reviews waiting — shall I start?' }] }),
      snapshot,
    );
    expect(invented.ok).toBe(false);
    expect(invented.ok === false && invented.reasons.join(' ')).toContain('question');
    expect(invented.ok === false && invented.reasons.join(' ')).toContain('count');

    const claimed = validateModelOutput(
      output({ segments: [{ type: 'question', text: 'I have updated your tone — anything else?' }] }),
      snapshot,
    );
    expect(claimed.ok).toBe(false);
    expect(claimed.ok === false && claimed.reasons.join(' ')).toContain('completion');

    // The identical sentences as `text` are still rejected, so this widened the
    // gate rather than moving it.
    expect(validateModelOutput(
      output({ segments: [{ type: 'text', text: 'You have 3 reviews waiting.' }] }),
      snapshot,
    ).ok).toBe(false);

    // An ordinary question is untouched.
    expect(validateModelOutput(
      output({ segments: [{ type: 'question', text: 'Shall I keep the replies short?' }] }),
      snapshot,
    ).ok).toBe(true);
  });

  it('validator returns the parsed proposals it already computed, in the model order', () => {
    const result = validateModelOutput(
      output({
        proposals: [
          toneProposal,
          {
            operation: 'set_avoid_facts',
            scope: { accountId: ACCOUNT, locationId: LOCATION },
            input: { avoidFacts: ['never mention the old owner'] },
            rationale: 'You asked me to leave that out.',
          },
        ],
      }),
      snapshot,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The catalog entry and the NARROWED input, so the row builder repeats
    // neither lookup nor parse — and in the model's own order, which is what
    // `proposal_ref.index` means.
    expect(result.proposals.map((p) => p.operation.id)).toEqual(['set_tone', 'set_avoid_facts']);
    expect(result.proposals[0]!.input).toEqual({ tone: 'warm and brief' });
    expect(result.proposals[0]!.operation.contractVersion).toBe(1);
    expect(result.proposals[1]!.rationale).toBe('You asked me to leave that out.');

    // A rejected output carries no proposals at all.
    const rejected = validateModelOutput(
      output({ proposals: [{ ...toneProposal, operation: 'set_business_hours' }] }),
      snapshot,
    );
    expect(rejected.ok).toBe(false);
  });

  it('validator rejects a proposal_ref index with no proposal and a status_ref metric outside the snapshot', () => {
    const danglingRef = validateModelOutput(
      output({ segments: [{ type: 'proposal_ref', index: 0 }] }),
      snapshot,
    );
    expect(danglingRef.ok).toBe(false);

    const outOfRange = validateModelOutput(
      output({ segments: [{ type: 'proposal_ref', index: 1 }], proposals: [toneProposal] }),
      snapshot,
    );
    expect(outOfRange.ok).toBe(false);

    const badMetric = validateModelOutput(
      output({ segments: [{ type: 'status_ref', metric: 'revenue_7d' }] }),
      snapshot,
    );
    expect(badMetric.ok).toBe(false);

    expect(validateModelOutput(
      output({ segments: [{ type: 'proposal_ref', index: 0 }], proposals: [toneProposal] }),
      snapshot,
    ).ok).toBe(true);
  });

  it('validator rejects a scope_check that names the stored location or coexists with a proposal for the stored location', () => {
    const namesStored = validateModelOutput(
      output({ segments: [{ type: 'scope_check', locationId: LOCATION }] }),
      snapshot,
    );
    expect(namesStored.ok).toBe(false);

    const unknownLocation = validateModelOutput(
      output({ segments: [{ type: 'scope_check', locationId: '00000000-0000-7000-8000-00000000b999' }] }),
      snapshot,
    );
    expect(unknownLocation.ok).toBe(false);

    const coexists = validateModelOutput(
      output({
        segments: [{ type: 'scope_check', locationId: OTHER_LOCATION }],
        proposals: [toneProposal],
      }),
      snapshot,
    );
    expect(coexists.ok).toBe(false);

    expect(validateModelOutput(
      output({ segments: [{ type: 'scope_check', locationId: OTHER_LOCATION }] }),
      snapshot,
    ).ok).toBe(true);
  });

  it('validator rejects a proposal whose operation is outside the catalog or whose scope is neither the stored location nor the account default', () => {
    // `set_daily_cap` is registered since Run C, so the outside-the-catalog
    // fixture is an id no catalog has. The wire schema now refuses it too;
    // this drives the validator's own branch directly.
    const unknownOperation = validateModelOutput(
      output({ proposals: [{ ...toneProposal, operation: 'set_business_hours' }] }),
      snapshot,
    );
    expect(unknownOperation.ok).toBe(false);
    expect(unknownOperation.ok === false && unknownOperation.reasons.join(' ')).toContain('outside the catalog');

    const foreignLocation = validateModelOutput(
      output({ proposals: [{ ...toneProposal, scope: { accountId: ACCOUNT, locationId: OTHER_LOCATION } }] }),
      snapshot,
    );
    expect(foreignLocation.ok).toBe(false);

    const foreignAccount = validateModelOutput(
      output({
        proposals: [{
          ...toneProposal,
          scope: { accountId: '00000000-0000-7000-8000-00000000ac99', locationId: LOCATION },
        }],
      }),
      snapshot,
    );
    expect(foreignAccount.ok).toBe(false);

    const badInput = validateModelOutput(
      output({ proposals: [{ ...toneProposal, input: { tone: 'x'.repeat(101) } }] }),
      snapshot,
    );
    expect(badInput.ok).toBe(false);

    // Every voice operation is scopeRule 'location', so an omitted locationId
    // is a rejection, not an account-default proposal.
    const noLocation = validateModelOutput(
      output({ proposals: [{ ...toneProposal, scope: { accountId: ACCOUNT } }] }),
      snapshot,
    );
    expect(noLocation.ok).toBe(false);
    expect(noLocation.ok === false && noLocation.reasons.join(' '))
      .toContain('must name the stored location');

    expect(validateModelOutput(output({ proposals: [toneProposal] }), snapshot).ok).toBe(true);
  });

  it('validator rejects a catalog operation the snapshot does not allow this account to use', () => {
    // `set_highlight_facts` IS a registered proposable operation with a valid
    // input here, so it clears the outside-the-catalog branch above and reaches
    // the allowedOperations gate — which the fixture snapshot closes to
    // set_tone / set_avoid_facts / read_pending_work. Run A's
    // `modelVisibleOperations` still returns the whole catalog, so this is the
    // forward guard for Run B's tier-gated operations.
    const result = validateModelOutput(
      output({
        proposals: [{
          operation: 'set_highlight_facts',
          scope: { accountId: ACCOUNT, locationId: LOCATION },
          input: { highlightFacts: ['we are dog friendly'] },
          rationale: 'You asked me to mention it.',
        }],
      }),
      snapshot,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasons.join(' ')).toContain('may not use');
    expect(result.ok === false && result.reasons.join(' ')).toContain('set_highlight_facts');

    // The SAME proposal passes once the snapshot allows it, so the rejection is
    // the gate and not the input shape.
    const allowed = validateModelOutput(
      output({
        proposals: [{
          operation: 'set_highlight_facts',
          scope: { accountId: ACCOUNT, locationId: LOCATION },
          input: { highlightFacts: ['we are dog friendly'] },
          rationale: 'You asked me to mention it.',
        }],
      }),
      {
        ...snapshot,
        allowedOperations: [
          ...snapshot.allowedOperations,
          {
            id: 'set_highlight_facts', kind: 'proposable', labelKind: 'fact',
            describe: 'Set what to highlight when a reply fits',
          },
        ],
      },
    );
    expect(allowed.ok).toBe(true);
  });
});

describe('operator output validator — auto-approval policy proposals', () => {
  const policySnapshot: Snapshot = {
    ...snapshot,
    allowedOperations: modelVisibleOperations({ blockReasons: ['autopilot_unavailable'] }),
  };
  const capProposal = {
    operation: 'set_daily_cap',
    scope: { accountId: ACCOUNT, locationId: null },
    input: { cap: 5 },
    rationale: 'You asked for fewer auto-posts a day.',
  };

  it('normalizes a wire null locationId to the account default once, before the scope rules and the parsed proposals', () => {
    const result = validateModelOutput(output({ proposals: [capProposal] }), policySnapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.scope).toEqual({ accountId: ACCOUNT });
    expect('locationId' in result.proposals[0]!.scope).toBe(false);
    expect(result.proposals[0]!.operation.domain).toBe('policy');

    // Absent and null are the same account default.
    const absent = validateModelOutput(
      output({ proposals: [{ ...capProposal, scope: { accountId: ACCOUNT } }] }),
      policySnapshot,
    );
    expect(absent.ok && absent.proposals).toHaveLength(1);
    expect(absent.ok && absent.proposals[0]!.scope).toEqual({ accountId: ACCOUNT });

    // An account-default proposal does not target the stored location, so it
    // may sit beside a scope_check for another location.
    expect(validateModelOutput(
      output({ segments: [{ type: 'scope_check', locationId: OTHER_LOCATION }], proposals: [capProposal] }),
      policySnapshot,
    ).ok).toBe(true);

    // The stored location is still a legal policy target.
    const located = validateModelOutput(
      output({ proposals: [{ ...capProposal, scope: { accountId: ACCOUNT, locationId: LOCATION } }] }),
      policySnapshot,
    );
    expect(located.ok && located.proposals).toHaveLength(1);
    expect(located.ok && located.proposals[0]!.scope).toEqual({ accountId: ACCOUNT, locationId: LOCATION });
  });

  it('a null locationId never turns a voice operation into an account default', () => {
    const result = validateModelOutput(
      output({ proposals: [{ ...toneProposal, scope: { accountId: ACCOUNT, locationId: null } }] }),
      policySnapshot,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasons.join(' ')).toContain('must name the stored location');
  });

  it('refuses a policy proposal for another location, another account, the switched target beside a scope_check, or an out-of-domain input', () => {
    const foreignLocation = validateModelOutput(
      output({ proposals: [{ ...capProposal, scope: { accountId: ACCOUNT, locationId: OTHER_LOCATION } }] }),
      policySnapshot,
    );
    expect(foreignLocation.ok === false && foreignLocation.reasons.join(' '))
      .toContain('neither the stored location nor the account default');

    const foreignAccount = validateModelOutput(
      output({ proposals: [{ ...capProposal, scope: { accountId: '00000000-0000-7000-8000-00000000ac99', locationId: null } }] }),
      policySnapshot,
    );
    expect(foreignAccount.ok === false && foreignAccount.reasons.join(' ')).toContain('another account');

    const switched = validateModelOutput(
      output({
        segments: [{ type: 'scope_check', locationId: OTHER_LOCATION }],
        proposals: [{ ...capProposal, scope: { accountId: ACCOUNT, locationId: LOCATION } }],
      }),
      policySnapshot,
    );
    expect(switched.ok === false && switched.reasons.join(' ')).toContain('cannot coexist');

    const badInput = validateModelOutput(
      output({ proposals: [{ ...capProposal, operation: 'set_veto_window', input: { minutes: 20 } }] }),
      policySnapshot,
    );
    expect(badInput.ok === false && badInput.reasons.join(' ')).toContain('outside the domain for set_veto_window');
  });

  it('keeps narrowing policy operations available on Copilot: readiness is attached, not a filter', () => {
    expect(policySnapshot.allowedOperations.map((op) => op.id))
      .toEqual(expect.arrayContaining(['set_auto_reply_scope', 'set_veto_window', 'set_daily_cap']));
    const off = validateModelOutput(
      output({
        proposals: [{
          operation: 'set_auto_reply_scope',
          scope: { accountId: ACCOUNT, locationId: LOCATION },
          input: { threshold: null },
          rationale: 'You asked to stop auto-posting here.',
        }],
      }),
      policySnapshot,
    );
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.proposals).toHaveLength(1);
    expect(off.proposals[0]!.operation.id).toBe('set_auto_reply_scope');
    expect(off.proposals[0]!.scope).toEqual({ accountId: ACCOUNT, locationId: LOCATION });
    expect(off.proposals[0]!.input).toEqual({ threshold: null });
  });
});

describe('reply materialization', () => {
  const PROPOSAL_A = '00000000-0000-7000-8000-0000000000a1';
  const PROPOSAL_B = '00000000-0000-7000-8000-0000000000b2';

  it('materializeReply binds proposal ids by index and freezes every status_ref value', () => {
    const segments: Segment[] = [
      { type: 'text', text: 'Two things I can set up.' },
      { type: 'proposal_ref', index: 1 },
      { type: 'status_ref', metric: 'posted_7d' },
      { type: 'proposal_ref', index: 0 },
      { type: 'question', text: 'Shall I?' },
    ];

    const stored = materializeReply({
      segments,
      metrics: snapshot.metrics,
      proposalIds: [PROPOSAL_A, PROPOSAL_B],
      scrubbed: false,
    });

    // BY INDEX, at the one moment the order is known. The rows share a single
    // `NOW()`, so a read-time `ORDER BY created_at` re-derivation is a tie-only
    // sort — the second sentence could point at the first card.
    expect(stored).toEqual([
      { type: 'text', text: 'Two things I can set up.' },
      { type: 'proposal', proposalId: PROPOSAL_B },
      {
        type: 'status', metric: 'posted_7d', value: snapshot.metrics.posted7d,
        reportingPeriodDays: 7, asOf: '2026-09-11T10:00:00.000Z',
      },
      { type: 'proposal', proposalId: PROPOSAL_A },
      { type: 'question', text: 'Shall I?' },
    ]);
    // The VALUE, not the metric name: the stored bytes carry no unresolved ref
    // of either kind, so nothing downstream can re-read today's number or
    // re-sort today's rows.
    const json = JSON.stringify(stored);
    expect(json).not.toContain('status_ref');
    expect(json).not.toContain('proposal_ref');
    // And it round-trips through the stored union, which admits neither.
    expect(parseReplySegments(json)).toEqual(stored);
    expect(() => parseReplySegments(JSON.stringify([{ type: 'proposal_ref', index: 0 }])))
      .toThrow(/no writer produces/);

    // Each metric materializes its OWN number, not whichever one is first.
    const each = materializeReply({
      segments: [
        { type: 'status_ref', metric: 'pending_count' },
        { type: 'status_ref', metric: 'drafts_waiting' },
      ],
      metrics: snapshot.metrics,
      proposalIds: [],
      scrubbed: false,
    });
    expect(each).toMatchObject([
      { metric: 'pending_count', value: snapshot.metrics.pendingCount },
      { metric: 'drafts_waiting', value: snapshot.metrics.draftsWaiting },
    ]);
  });

  it('materializeReply prepends the scrub notice and drops a reference nothing backs', () => {
    const scrubbed = materializeReply({
      segments: [{ type: 'text', text: 'I asked about a review.' }],
      metrics: snapshot.metrics,
      proposalIds: [],
      scrubbed: true,
    });
    // FIRST, and stored: the read path never sees the owner's raw message, so
    // it could not re-derive this notice on a refresh.
    expect(scrubbed[0]).toEqual({ type: 'server_notice', notice: 'pasted_review_removed' });
    expect(scrubbed).toHaveLength(2);

    // A `proposal_ref` with no id behind it is dropped rather than thrown: the
    // turn's budget is already spent, and one missing sentence beats a retry
    // that cannot converge. (The validator rejects this shape upstream; this is
    // the unreachable-miss behaviour, not a second policy.)
    expect(materializeReply({
      segments: [{ type: 'proposal_ref', index: 3 }, { type: 'text', text: 'Here.' }],
      metrics: snapshot.metrics,
      proposalIds: [PROPOSAL_A],
      scrubbed: false,
    })).toEqual([{ type: 'text', text: 'Here.' }]);
  });

  it('renderSegments passes a stored proposal id through and resolves no index', () => {
    const rendered = renderSegments(
      [
        { type: 'proposal', proposalId: PROPOSAL_B },
        { type: 'status', metric: 'pending_count', value: 3, reportingPeriodDays: 7, asOf: '2026-09-11T10:00:00.000Z' },
        { type: 'server_notice', notice: 'pasted_review_removed' },
        { type: 'scope_check', locationId: OTHER_LOCATION },
      ],
      { locations: snapshot.locations },
    );
    expect(rendered[0]).toEqual({ type: 'proposal', proposalId: PROPOSAL_B });
    expect(rendered[1]).toMatchObject({ type: 'status', value: 3 });
    expect(rendered[2]!.type).toBe('notice');
    expect(rendered[3]).toEqual({ type: 'scope_check', locationId: OTHER_LOCATION, locationName: 'Cafe' });
  });
});

describe('pasted-review scrub', () => {
  it('scrubber replaces a pasted review block with the marker and leaves ordinary owner text untouched', () => {
    const plain = 'Can you make my replies shorter and warmer?';
    expect(scrubPastedReview(plain)).toEqual({ text: plain, scrubbed: false });

    // A rating MENTION is ordinary owner instruction and survives untouched —
    // this is the sentence the whole rating-LINE design exists to protect.
    const instruction = 'Change my tone for 4 and 5 star reviews';
    expect(scrubPastedReview(instruction)).toEqual({ text: instruction, scrubbed: false });
    const longInstruction = `Here is what I want. ${'Keep the replies short, warm and specific to what the customer actually said. '.repeat(6)}`;
    expect(longInstruction.length).toBeGreaterThan(300);
    expect(scrubPastedReview(longInstruction).scrubbed).toBe(false);

    // A rating LINE opening a block is a pasted review.
    const rating = scrubPastedReview('What do I do about this?\n\n5/5\nGreat food, terrible parking. — Priya M.');
    expect(rating.scrubbed).toBe(true);
    expect(rating.text).toContain(REVIEW_TEXT_REMOVED_MARKER);
    expect(rating.text).not.toContain('terrible parking');
    expect(rating.text).not.toContain('Priya M.');
    expect(rating.text).toContain('What do I do about this?');
    expect(scrubPastedReview('Rated: 4 stars\nThe cut was fine, the wait was not.').scrubbed).toBe(true);
    expect(scrubPastedReview('★★★★★\nBest in town.').scrubbed).toBe(true);

    // Word ratings at block start.
    const words = scrubPastedReview('five stars\nGreat place');
    expect(words.scrubbed).toBe(true);
    expect(words.text).not.toContain('Great place');

    // A byline in either order.
    const byline = scrubPastedReview('Alex wrote: the coffee was cold and nobody cared.');
    expect(byline.scrubbed).toBe(true);
    expect(byline.text).not.toContain('the coffee was cold');

    const named = scrubPastedReview('Reviewed by Alex P. wrote: the coffee was cold and nobody cared.');
    expect(named.scrubbed).toBe(true);
    expect(named.text).not.toContain('the coffee was cold');

    // A SHORT rating line is a header: the body it introduces is the next
    // block, and both go.
    const body = 'The service was slow and the room was cold. '.repeat(8);
    expect(body.length).toBeGreaterThan(300);
    const header = scrubPastedReview(`5/5\n\n${body}`);
    expect(header.scrubbed).toBe(true);
    expect(header.text).not.toContain('the room was cold');
    expect(header.text.replace(/\s/g, '')).toBe(
      `${REVIEW_TEXT_REMOVED_MARKER}${REVIEW_TEXT_REMOVED_MARKER}`.replace(/\s/g, ''),
    );

    // A TYPED marker must not smuggle a body past the scrub: there is no
    // short-circuit on the marker, so the block is judged on its own shape.
    const smuggled = scrubPastedReview('[review text removed] Alex wrote: the coffee was cold.');
    expect(smuggled.scrubbed).toBe(true);
    expect(smuggled.text).not.toContain('the coffee was cold');

    // Over 300 characters of QUOTED prose — quoted, not merely long.
    const longQuote = scrubPastedReview(`Thoughts?\n\n"${'the service was slow. '.repeat(20)}"`);
    expect(longQuote.scrubbed).toBe(true);
    expect(longQuote.text).toContain(REVIEW_TEXT_REMOVED_MARKER);

    // Idempotent WITHOUT a marker short-circuit: a bare marker matches none of
    // the three patterns, so a second pass changes nothing on its own merits.
    expect(scrubPastedReview(rating.text)).toEqual({ text: rating.text, scrubbed: false });
  });
});
