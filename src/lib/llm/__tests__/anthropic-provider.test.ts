import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ChatPrompt, LLMRequest, LLMStructuredOutput } from '../types';
import { llmCircuitBreaker } from '../circuit-breaker';

// ── Mock the raw SDK — the unit under test is the provider's request
// mapping (contrast run-task.test.ts, which mocks the provider seam to
// test fallback orchestration). The provider caches its client at module
// level, so a single shared create fn covers every test. ─────────────────

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreate };
  },
}));

// The fallback-regression case drives the REAL anthropic provider through
// runLlmTask, so only the OpenAI side is mocked at the provider seam.
const openaiComplete = vi.fn();
vi.mock('../openai-provider', () => ({
  openaiProvider: { id: 'openai', complete: openaiComplete },
}));

// ── Helpers ──────────────────────────────────────────────────────────

function sdkResponse(text = 'Merci, Jane!', stopReason: string | null = 'end_turn') {
  return {
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 300,
    system: 'You are a helpful assistant.',
    user: 'Say thanks.',
    ...overrides,
  };
}

const prompt: ChatPrompt = {
  system: 'You are a helpful assistant.',
  user: 'Say thanks.',
};

// A transport fixture, not a registered task: a discriminated union (Zod 4
// renders it as `oneOf`) plus a length bound the API does not accept.
const structuredOutput: LLMStructuredOutput = {
  name: 'owner_operator',
  schema: z.strictObject({
    segments: z
      .array(
        z.discriminatedUnion('type', [
          z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(40) }),
          z.strictObject({ type: z.literal('ref'), index: z.number().int().min(0).max(4) }),
        ]),
      )
      .max(3),
  }),
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('anthropicProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Process-wide singleton consulted on every runLlmTask attempt — reset so
    // breaker state never leaks across tests.
    llmCircuitBreaker.reset();
  });

  it('forwards temperature to the Anthropic SDK', async () => {
    messagesCreate.mockResolvedValueOnce(sdkResponse());

    const { anthropicProvider } = await import('../anthropic-provider');
    await anthropicProvider.complete(request({ temperature: 0.6 }));

    expect(messagesCreate).toHaveBeenCalledOnce();
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.6 }),
    );

    // temperature: 0 (triage/judge in the registry) must forward as 0 — a
    // falsy-check regression (`request.temperature ? …`) would silently drop
    // the deterministic-task setting back to the SDK default.
    messagesCreate.mockResolvedValueOnce(sdkResponse());
    await anthropicProvider.complete(request({ temperature: 0 }));
    expect(messagesCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ temperature: 0 }),
    );
  });

  it('omits the temperature key entirely when the request leaves it undefined', async () => {
    messagesCreate.mockResolvedValueOnce(sdkResponse());

    const { anthropicProvider } = await import('../anthropic-provider');
    await anthropicProvider.complete(request({ temperature: undefined }));

    expect(messagesCreate).toHaveBeenCalledOnce();
    // Key absence (not `temperature: undefined`) is the contract: the SDK
    // default must remain in force for temperature-less tasks.
    expect(messagesCreate.mock.calls[0]![0]).not.toHaveProperty('temperature');
    // Unstructured requests carry no output_config at all.
    expect(messagesCreate.mock.calls[0]![0]).not.toHaveProperty('output_config');
  });

  it('sends output_config.format derived from the request schema by the installed helper', async () => {
    messagesCreate.mockResolvedValueOnce(sdkResponse('{"segments":[]}'));

    const { anthropicProvider } = await import('../anthropic-provider');
    await anthropicProvider.complete(request({ structuredOutput }));

    const body: unknown = messagesCreate.mock.calls[0]![0];
    expect(body).toMatchObject({ output_config: { format: { type: 'json_schema' } } });
    const format = isJsonObject(body) && isJsonObject(body.output_config)
      ? body.output_config.format
      : undefined;
    if (!isJsonObject(format)) throw new Error('expected output_config.format');
    // Wire fields only: the helper's parse() closure never reaches the request.
    expect(Object.keys(format).sort()).toEqual(['schema', 'type']);
    if (!isJsonObject(format.schema)) throw new Error('expected a schema object');
    expect(format.schema.additionalProperties).toBe(false);
    const serialized = JSON.stringify(format.schema);
    expect(serialized).not.toContain('"oneOf"');
    expect(serialized).toContain('"anyOf"');
    // The length bound is folded into a description, not sent as a keyword.
    // runLlmTask's Zod validation remains the authority for it.
    expect(serialized).not.toContain('"maxLength":');
  });

  it('keeps UUID checks in the registered validator without compiling UUID grammar at the provider', async () => {
    const { getLlmTask } = await import('../tasks');
    const schema = getLlmTask('owner_operator').outputSchema!;
    messagesCreate.mockResolvedValueOnce(sdkResponse('{}'));
    const { anthropicProvider } = await import('../anthropic-provider');
    await anthropicProvider.complete(request({ structuredOutput: { name: 'owner_operator', schema } }));
    const wire = messagesCreate.mock.calls[0]![0].output_config.format.schema;
    expect(JSON.stringify(wire)).not.toContain('"format":"uuid"');
    expect(JSON.stringify(wire)).toContain('UUID');
    const valid = {
      segments: [{ type: 'proposal_ref', index: 0 }],
      proposals: [{ operation: 'set_auto_reply_scope', scope: {
        accountId: '00000000-0000-7000-8000-00000000ac01',
        locationId: '00000000-0000-7000-8000-00000000b101',
      }, input: { threshold: 4 }, rationale: 'Include positive reviews.' }],
      unsupported: [],
    };
    expect(schema.safeParse(valid).success).toBe(true);
    valid.proposals[0]!.scope.accountId = 'not-a-uuid';
    expect(schema.safeParse(valid).success).toBe(false);
  });

  it('preserves application properties named format and type while translating UUID schema nodes', async () => {
    messagesCreate.mockResolvedValueOnce(sdkResponse('{}'));
    const { anthropicProvider } = await import('../anthropic-provider');
    await anthropicProvider.complete(request({ structuredOutput: {
      name: 'owner_operator',
      schema: z.strictObject({ format: z.literal('uuid'), type: z.string(), id: z.uuid() }),
    } }));
    const wire = messagesCreate.mock.calls[0]![0].output_config.format.schema;
    expect(Object.keys(wire.properties)).toEqual(['format', 'type', 'id']);
    expect(wire.properties.format.type).toBe('string');
    expect(wire.properties.id).toMatchObject({ type: 'string', description: expect.stringContaining('UUID') });
    expect(wire.properties.id).not.toHaveProperty('format');
  });

  it('returns a refused structured completion with its usage and no text, instead of throwing unbilled', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 80, output_tokens: 3 },
    });

    const { anthropicProvider } = await import('../anthropic-provider');
    const result = await anthropicProvider.complete(request({ structuredOutput }));

    expect(result).toStrictEqual({
      text: '',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      usage: { promptTokens: 80, completionTokens: 3 },
      incomplete: 'refused',
    });
  });

  it('marks a max_tokens structured completion truncated and keeps its usage', async () => {
    messagesCreate.mockResolvedValueOnce(sdkResponse('{"segments":[{"ty', 'max_tokens'));

    const { anthropicProvider } = await import('../anthropic-provider');
    const result = await anthropicProvider.complete(request({ structuredOutput }));

    expect(result.incomplete).toBe('truncated');
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
  });

  it('keeps the unstructured contract: empty throws, a max_tokens reply is returned unmarked', async () => {
    const { anthropicProvider } = await import('../anthropic-provider');

    messagesCreate.mockResolvedValueOnce(sdkResponse(''));
    await expect(anthropicProvider.complete(request())).rejects.toThrow(
      'Anthropic returned empty response',
    );

    messagesCreate.mockResolvedValueOnce(sdkResponse('Merci, Ja', 'max_tokens'));
    const result = await anthropicProvider.complete(request());
    expect(result).not.toHaveProperty('incomplete');
    expect(result.text).toBe('Merci, Ja');
  });

  // SPEC §9 fallback-regression pin: before #628 the Anthropic provider
  // dropped request.temperature, so existing tasks' FALLBACK path ran at the
  // SDK default. Forwarding changes that behavior for reply_generation (0.7)
  // and insights (0.5) — this test makes the change ride deliberately, not
  // silently.
  it('changes reply_generation and insights anthropic fallback temperature knowingly', async () => {
    // The failover log goes through the structured logger to console.error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    openaiComplete.mockRejectedValue(
      Object.assign(new Error('openai unavailable'), { code: 'ECONNRESET' }),
    );
    messagesCreate.mockResolvedValue(sdkResponse());

    const { runLlmTask } = await import('../run-task');

    const reply = await runLlmTask('reply_generation', prompt);
    expect(reply.provider).toBe('anthropic');
    expect(messagesCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ temperature: 0.7 }),
    );

    const insights = await runLlmTask('insights', prompt);
    expect(insights.provider).toBe('anthropic');
    expect(messagesCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ temperature: 0.5 }),
    );
  });
});
