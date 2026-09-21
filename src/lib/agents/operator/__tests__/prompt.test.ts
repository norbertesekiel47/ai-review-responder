// The prompt is pure (no database, no clock, no network), so this suite reads
// the envelope it builds and checks it against the schema the seam enforces.
//
// Why this exists (T8, 2026-09-13): the first live Operator turn on staging
// failed `model_output_invalid` on BOTH pinned providers. The prompt said
// "matching the declared schema" and declared nothing; the seam sends no JSON
// schema to a provider and validates only after the completion arrives. The
// two models each invented keys the strict schema rejects. Nothing offline had
// caught it: the eval harness is keyless and the unit suites mock the model.
import { describe, it, expect } from 'vitest';
import { buildOperatorPrompt, operatorSystemPromptHash, OWNER_OPERATOR_PROMPT_VERSION } from '../prompt';
import { OperatorModelOutputSchema, STATUS_METRICS } from '../schema';
import { modelVisibleOperations } from '../catalog';
import type { Snapshot } from '../context';
import { OPERATOR_REFUSAL_REASONS } from '../refusals';
import { POSTING_BLOCK_COPY } from '@/lib/auto-approval/posting-block-copy';

/** The "Output rules:" bullets, which is the only region these cases read. */
function outputRules(system: string): string[] {
  return system.split('\n').filter((line) => line.startsWith('- '));
}

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';

const snapshot: Snapshot = {
  accountId: ACCOUNT,
  locationId: LOCATION,
  locationName: 'Salon',
  subscriptionTier: 'copilot',
  turns: [],
  pendingProposals: [],
  operatingRules: {
    account: { threshold: null, vetoWindowMinutes: 15, dailyCap: 10 },
    location: { threshold: null, vetoWindowMinutes: 15, dailyCap: 10 },
    locationOverrideExists: false,
  },
  posting: { blocked: false, reasons: [], sentences: [], correctionOwed: false },
  facts: { tone: 'professional and friendly', productsServices: null, avoidFacts: [], highlightFacts: [] },
  allowedOperations: modelVisibleOperations({ blockReasons: ['autopilot_unavailable'] }),
  locations: [{ id: LOCATION, name: 'Salon' }],
  metrics: {
    pendingCount: 0,
    draftsWaiting: 0,
    posted7d: 0,
    starBands: { locationId: LOCATION, total: 0, byStar: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } },
    accountStarBands: { locationId: null, total: 0, byStar: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } },
    reportingPeriodDays: 7,
    asOf: '2026-09-13T03:00:00.000Z',
  },
};

describe('operator prompt', () => {
  it('the exact licensed request is a refusal with server-owned wording, never an unsupported capability', () => {
    const { system } = buildOperatorPrompt(snapshot, 'say we are licensed');
    for (const reason of OPERATOR_REFUSAL_REASONS) expect(system).toContain(reason);
    expect(system).toContain('say we are licensed');
    expect(system).toContain('Never put a prohibited request in unsupported');
    expect(system).toContain('The server supplies the rule wording');
    const exampleLine = system.split('\n').find((line) => line.startsWith('{"segments":[{"type":"refusal_ref"'));
    expect(exampleLine).toBeDefined();
    const example = OperatorModelOutputSchema.parse(JSON.parse(exampleLine!));
    expect(example).toEqual({
      segments: [{ type: 'refusal_ref', reason: 'invented_business_fact' }], proposals: [], unsupported: [],
    });
  });

  it('its account-off example is schema-valid with null scope and threshold, and changes the recorded prompt identity', () => {
    const { system } = buildOperatorPrompt(snapshot, 'Turn automatic replies off for all locations.');
    const exampleLine = system.split('\n').find((line) => line.startsWith('{"segments":['));
    expect(exampleLine).toBeDefined();
    const example = OperatorModelOutputSchema.parse(JSON.parse(exampleLine!.replace('<snapshot.accountId>', ACCOUNT)));
    expect(example.proposals).toEqual([{
      operation: 'set_auto_reply_scope', scope: { accountId: ACCOUNT, locationId: null },
      input: { threshold: null }, rationale: expect.any(String),
    }]);
    expect(example.segments).toEqual([{ type: 'proposal_ref', index: 0 }]);
    expect(example.unsupported).toEqual([]);
    expect(OWNER_OPERATOR_PROMPT_VERSION).toBe('2026-09-20.3');
    expect(operatorSystemPromptHash()).not.toBe('3f280d00e307c2148b9138dbf8c51ed5f4d70ca84dd63c1057535c4ba32da81a');
  });

  it('system prompt tells the model to state the Posting block instead of claiming replies post', () => {
    const { system } = buildOperatorPrompt(snapshot, 'Only auto-post 5 star replies');
    const owed = outputRules(system).find(
      (rule) => rule.includes('snapshot.posting.correctionOwed is true') && rule.includes('snapshot.posting.sentences'),
    );
    expect(owed).toBeDefined();
    // The sentences ride the snapshot; the model repeats them and adds nothing.
    expect(owed).toContain('verbatim');
    expect(owed).toMatch(/Invent no reason/);
    expect(owed).toMatch(/no reason the snapshot did not list/);

    // The five owner sentences are owned by posting-block-copy.ts and reach the
    // model through the snapshot. Inlining one here would move the prompt hash
    // on an owner-facing copy edit.
    for (const [reason, sentence] of Object.entries(POSTING_BLOCK_COPY)) {
      expect(system, reason).not.toContain(sentence);
    }
  });

  it('system prompt says set to post and never posts when a Posting block is present', () => {
    const { system } = buildOperatorPrompt(snapshot, 'Turn automatic replies off for all locations.');
    const phrasing = outputRules(system).find((rule) => rule.includes('"set to post"'));
    expect(phrasing).toBeDefined();
    expect(phrasing).toContain('never "posts"');
    // A configured rule is a setting, not a guarantee about any single reply.
    expect(phrasing).toMatch(/not a guarantee/);
    expect(phrasing).toMatch(/safety checks and service availability/);
  });

  it('system prompt gates UNSOLICITED Posting block mention on correctionOwed while allowing a direct answer and preserving supported proposals', () => {
    const { system } = buildOperatorPrompt(snapshot, 'Turn automatic replies off for all locations.');
    const rules = outputRules(system);

    // Nothing owed means nothing VOLUNTEERED, even for a blocked account: the
    // server has already decided, and the model never re-derives it.
    const silence = rules.find((rule) => rule.includes('snapshot.posting.correctionOwed is false'));
    expect(silence).toBeDefined();
    expect(silence).toMatch(/never volunteer a Posting block/);
    expect(silence).toMatch(/no unprompted warning/);
    expect(silence).toMatch(/snapshot\.posting\.blocked is true/);
    expect(silence).toMatch(/never re-derive account-wide armed state/);

    // But it is NOT a gag. An owner who asks directly — "apart from my rule
    // being off, is anything stopping automatic posting?" — is answered from
    // the snapshot, verbatim, inventing nothing. Concealing a known fact from a
    // direct question is #1352 wearing the opposite sign, and no card is
    // involved in that exchange, so the deterministic half protects nobody.
    expect(silence).toMatch(/asks directly/);
    expect(silence).toMatch(/answer from snapshot\.posting\.sentences/);
    expect(silence).toMatch(/verbatim/);
    expect(silence).not.toMatch(/say nothing about a Posting block/);

    // Rules 4 and 5 are subordinate to correctionOwed: EVERY rule that names
    // the Posting block defers the decision to mention it back to that field.
    const postingRules = rules.filter((rule) => rule.includes('Posting block'));
    expect(postingRules.length).toBeGreaterThanOrEqual(3);
    for (const rule of postingRules) {
      expect(rule, rule).toContain('correctionOwed');
    }

    // What is gated is the MENTION, not every wording rule. The always-on
    // "set to post" rule is about promise level — it applies to any reply about
    // any rule, block or none — so it names neither concept and is gated on
    // nothing. "Every rule is gated" would be the overstatement this title used
    // to make.
    const phrasing = rules.find((rule) => rule.includes('"set to post"'));
    expect(phrasing).toBeDefined();
    expect(phrasing).not.toContain('correctionOwed');
    expect(postingRules).not.toContain(phrasing);

    const proposals = rules.find((rule) => rule.includes('never withholds a proposal'));
    expect(proposals).toBeDefined();
    expect(proposals).toMatch(/including a contraction/);
    const suspension = rules.find((rule) => rule.includes('suspended'));
    expect(suspension).toBeDefined();
    expect(suspension).toMatch(/state the suspension first/);
    // RT-07: the suspension rule carries the SAME two-branch contract as the
    // rule above, never a stricter one. `correctionOwed` gates the UNPROMPTED
    // sentence; a direct question is still answered verbatim. A bare "only when
    // correctionOwed is true" here would forbid, for a suspended account,
    // precisely what the rule above permits — and the model cannot obey both.
    expect(suspension).toMatch(/unprompted only when snapshot\.posting\.correctionOwed is true/);
    expect(suspension).toMatch(/otherwise only as the answer to a direct question/);
    expect(suspension).toMatch(/verbatim from snapshot\.posting\.sentences/);
    // Stated first, then at most once — the ordering and the de-duplication are
    // what this rule adds on top of the two branches.
    expect(suspension).toMatch(/at most once/);

    // No Posting block rule may make the model hold back the requested work.
    for (const rule of postingRules) {
      expect(rule, rule).not.toMatch(/do not propose|withhold the proposal|refuse the proposal|ask the owner to wait/i);
    }

    // ONE contract, not two. Wherever a rule makes `correctionOwed is true` a
    // NECESSARY condition, it must scope that gate to the unprompted branch; a
    // bare "only when" reads as a gate on every mention and contradicts the
    // direct answer the rule above permits (RT-07).
    for (const rule of postingRules) {
      expect(rule, rule).not.toMatch(/(?<!unprompted )only when snapshot\.posting\.correctionOwed is true/);
    }

    // They sit with the other block concept, not scattered through the list.
    const expansion = rules.findIndex((rule) => rule.includes('expansionBlockedBy reasons'));
    expect(expansion).toBeGreaterThanOrEqual(0);
    expect(rules.indexOf(postingRules[0]!)).toBe(expansion + 1);
  });

  it('the system prompt declares every top-level key and every segment type OperatorModelOutputSchema accepts', () => {
    const { system } = buildOperatorPrompt(snapshot, 'Set the reply tone to warm and brief');

    // Top-level keys, read from the schema so a new key cannot go undeclared.
    for (const key of Object.keys(OperatorModelOutputSchema.shape)) {
      expect(system).toContain(`"${key}"`);
    }
    // Segment types, read from the discriminated union for the same reason.
    const segmentTypes = OperatorModelOutputSchema.shape.segments.element.options
      .map((option) => option.shape.type.value);
    expect(segmentTypes.length).toBeGreaterThanOrEqual(5);
    for (const type of segmentTypes) {
      expect(system).toContain(`"type": "${type}"`);
    }
    // The two nested shapes and the metric vocabulary.
    for (const key of ['operation', 'scope', 'accountId', 'locationId', 'input', 'rationale', 'request', 'context']) {
      expect(system).toContain(`"${key}"`);
    }
    // Run C: the account default is a legal policy target, declared as null.
    expect(system).toContain('"locationId": uuid | null');
    expect(system).toContain('scopeRule');
    expect(system).toContain('expansionBlockedBy');
    for (const metric of STATUS_METRICS) {
      expect(system).toContain(`"${metric}"`);
    }
    // A shape change is a prompt change and must be visible in api_costs.
    expect(OWNER_OPERATOR_PROMPT_VERSION).not.toBe('2026-09-11.2');
    expect(OWNER_OPERATOR_PROMPT_VERSION).not.toBe('2026-09-13.1');
  });

  it('the user envelope carries each proposable input shape on the operation itself, and no shape on reads or captures', () => {
    const { user } = buildOperatorPrompt(snapshot, 'Set the reply tone to warm and brief');
    const envelope = JSON.parse(user) as { snapshot: { allowedOperations: { id: string; kind: string; input?: string }[] } };
    const operations = envelope.snapshot.allowedOperations;
    expect(operations.length).toBeGreaterThan(0);
    for (const op of operations) {
      if (op.kind === 'proposable' || op.kind === 'prepare') {
        expect(op.input).toMatch(/^\{.*\}$/);
      } else {
        expect(op).not.toHaveProperty('input');
      }
    }
  });

  it('the user envelope lists every operation the wire schema accepts, with exactly that schema input keys', () => {
    const { user } = buildOperatorPrompt(snapshot, 'Only auto-post 5 star replies');
    const envelope = JSON.parse(user) as {
      snapshot: {
        allowedOperations: {
          id: string; kind: string; input?: string; scopeRule?: string; expansionBlockedBy?: string[];
        }[];
      };
    };
    const byId = new Map(envelope.snapshot.allowedOperations.map((op) => [op.id, op]));

    // Read from the schema, so a new wire operation cannot go unlisted and a
    // removed shape fails here.
    const options = OperatorModelOutputSchema.shape.proposals.element.options;
    expect(options.length).toBe(9);
    for (const option of options) {
      const id = option.shape.operation.value;
      const visible = byId.get(id);
      expect(visible?.kind, id).toBe(id === 'restore_last' ? 'prepare' : 'proposable');
      expect(visible?.input, id).toBeDefined();
      const shapeKeys = [...visible!.input!.matchAll(/"([A-Za-z]+)"\s*:/g)].map((m) => m[1]).sort();
      expect(shapeKeys, id).toEqual(Object.keys(option.shape.input.shape).sort());
    }

    for (const id of ['set_auto_reply_scope', 'set_veto_window', 'set_daily_cap']) {
      expect(byId.get(id), id).toMatchObject({
        scopeRule: 'account_or_location',
        expansionBlockedBy: ['autopilot_unavailable'],
      });
    }
    expect(byId.get('set_tone')).toMatchObject({ scopeRule: 'location' });
    // No typed confirmation phrase ever reaches the model.
    expect(user).not.toContain('"confirmationPhrase":');
    expect(user).not.toContain('"requiresConfirmation":');
  });
});
