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
import { buildOperatorPrompt, OWNER_OPERATOR_PROMPT_VERSION } from '../prompt';
import { OperatorModelOutputSchema, STATUS_METRICS } from '../schema';
import { modelVisibleOperations } from '../catalog';
import type { Snapshot } from '../context';

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
      if (op.kind === 'proposable') {
        expect(op.input).toMatch(/^\{".+\}$/);
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
    expect(options.length).toBe(7);
    for (const option of options) {
      const id = option.shape.operation.value;
      const visible = byId.get(id);
      expect(visible?.kind, id).toBe('proposable');
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
