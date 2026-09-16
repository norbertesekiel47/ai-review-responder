import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ChatPrompt, LLMRequest, LLMStructuredOutput, LLMTaskId } from '../types';
import { llmCircuitBreaker } from '../circuit-breaker';
import { ANTHROPIC_MODEL, OPENAI_MODEL, getLlmTask } from '../tasks';

// ── Mock BOTH raw SDKs — the units under test are the providers' request
// mapping and, in the last block, the registered tasks' schemas reaching both
// providers through the real runLlmTask. The SDK helper modules
// (`openai/helpers/zod`, `@anthropic-ai/sdk/helpers/zod`) are separate
// specifiers and stay REAL: the derived schema is what these tests inspect. ──

const chatCreate = vi.fn();
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: chatCreate } };
  },
}));

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreate };
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────

function sdkCompletion(
  message: { content: string | null; refusal?: string },
  finishReason = 'stop',
) {
  return {
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: message.content, refusal: message.refusal ?? null },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 40 },
  };
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: OPENAI_MODEL,
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

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...path: string[]): unknown {
  let node = value;
  for (const key of path) node = isJsonObject(node) ? node[key] : undefined;
  return node;
}

function keysOf(value: unknown): string[] {
  return isJsonObject(value) ? Object.keys(value).sort() : [];
}

const SUBSCHEMA_MAPS = new Set(['properties', '$defs', 'definitions']);

/** Every JSON Schema KEYWORD at any depth — property names excluded. */
function schemaKeywords(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) schemaKeywords(child, found);
    return found;
  }
  if (!isJsonObject(node)) return found;
  for (const [key, value] of Object.entries(node)) {
    found.add(key);
    if (SUBSCHEMA_MAPS.has(key) && isJsonObject(value)) {
      for (const child of Object.values(value)) schemaKeywords(child, found);
    } else {
      schemaKeywords(value, found);
    }
  }
  return found;
}

function objectNodes(node: unknown, found: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(node)) {
    for (const child of node) objectNodes(child, found);
    return found;
  }
  if (!isJsonObject(node)) return found;
  if (node.type === 'object') found.push(node);
  for (const value of Object.values(node)) objectNodes(value, found);
  return found;
}

/** What OpenAI strict mode requires of every object node, checked offline. */
function expectOpenAiStrict(schema: unknown): void {
  const nodes = objectNodes(schema);
  expect(nodes.length).toBeGreaterThan(0);
  for (const node of nodes) {
    const properties = keysOf(node.properties);
    // Closed empty inputs are intentional for clear_location_override and
    // restore_last; an open/unstructured object remains forbidden.
    expect(isJsonObject(node.properties)).toBe(true);
    expect(node.additionalProperties).toBe(false);
    expect(Array.isArray(node.required) ? [...node.required].sort() : node.required).toEqual(
      properties,
    );
  }
  const keywords = schemaKeywords(schema);
  expect(keywords.has('oneOf')).toBe(false);
}

// A transport fixture, not a registered task: a discriminated union (Zod 4
// renders it as `oneOf`), string length bounds, and a property whose name
// matches a JSON Schema keyword.
const fixtureSchema = z.strictObject({
  maxLength: z.number().int().min(1).max(10),
  segments: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(40) }),
        z.strictObject({ type: z.literal('ref'), index: z.number().int().min(0).max(4) }),
      ]),
    )
    .max(3),
});
const structuredOutput: LLMStructuredOutput = { name: 'owner_operator', schema: fixtureSchema };

describe('openaiProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmCircuitBreaker.reset();
  });

  it('sends an unstructured request byte-identical to the pre-schema mapping', async () => {
    chatCreate.mockResolvedValueOnce(sdkCompletion({ content: 'Thanks, Jane!' }));

    const { openaiProvider } = await import('../openai-provider');
    const result = await openaiProvider.complete(request({ temperature: 0.7 }));

    expect(chatCreate.mock.calls[0]![0]).toStrictEqual({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Say thanks.' },
      ],
      temperature: 0.7,
      max_tokens: 300,
    });
    expect(result).toStrictEqual({
      text: 'Thanks, Jane!',
      provider: 'openai',
      model: OPENAI_MODEL,
      usage: { promptTokens: 120, completionTokens: 40 },
    });
  });

  it('sends a strict json_schema response_format derived from the request schema', async () => {
    chatCreate.mockResolvedValueOnce(sdkCompletion({ content: '{"maxLength":1,"segments":[]}' }));

    const { openaiProvider } = await import('../openai-provider');
    await openaiProvider.complete(request({ structuredOutput }));

    const body: unknown = chatCreate.mock.calls[0]![0];
    expect(body).toMatchObject({
      response_format: { type: 'json_schema', json_schema: { name: 'owner_operator', strict: true } },
    });
    const schema = at(body, 'response_format', 'json_schema', 'schema');
    expectOpenAiStrict(schema);
    // The union survives as anyOf, both branches intact.
    expect(schemaKeywords(schema).has('anyOf')).toBe(true);
    expect(at(schema, 'properties', 'segments', 'items', 'anyOf')).toHaveLength(2);
    expect(schemaKeywords(schema).has('minLength')).toBe(true);
    expect(schemaKeywords(schema).has('maxLength')).toBe(true);
    // Property names remain data during the union conversion.
    expect(keysOf(at(schema, 'properties'))).toEqual(['maxLength', 'segments']);
  });

  it('fails before any SDK call when a schema has an optional-without-nullable field', async () => {
    const { openaiProvider } = await import('../openai-provider');
    const loose: LLMStructuredOutput = {
      name: 'triage',
      schema: z.strictObject({ locationId: z.uuid().optional() }),
    };

    await expect(openaiProvider.complete(request({ structuredOutput: loose }))).rejects.toThrow(
      /optional\(\)/,
    );
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it('returns a refused structured completion with its usage and no text, instead of throwing unbilled', async () => {
    chatCreate.mockResolvedValueOnce(
      sdkCompletion({ content: null, refusal: 'I cannot help Jane with that.' }),
    );

    const { openaiProvider } = await import('../openai-provider');
    const result = await openaiProvider.complete(request({ structuredOutput }));

    expect(result).toStrictEqual({
      text: '',
      provider: 'openai',
      model: OPENAI_MODEL,
      usage: { promptTokens: 120, completionTokens: 40 },
      incomplete: 'refused',
    });
  });

  it('treats a content_filter finish on a structured request as refused', async () => {
    chatCreate.mockResolvedValueOnce(sdkCompletion({ content: null }, 'content_filter'));

    const { openaiProvider } = await import('../openai-provider');
    const result = await openaiProvider.complete(request({ structuredOutput }));

    expect(result.incomplete).toBe('refused');
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 40 });
  });

  it('marks a length-truncated structured completion and keeps its usage', async () => {
    chatCreate.mockResolvedValueOnce(sdkCompletion({ content: '{"segments":[{"ty' }, 'length'));

    const { openaiProvider } = await import('../openai-provider');
    const result = await openaiProvider.complete(request({ structuredOutput }));

    expect(result.incomplete).toBe('truncated');
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 40 });
  });

  it('drops refusal text even when a structured completion also reports length truncation', async () => {
    chatCreate.mockResolvedValueOnce(
      sdkCompletion({ content: 'SENTINEL-CONTENT', refusal: 'SENTINEL-REFUSAL' }, 'length'),
    );

    const { openaiProvider } = await import('../openai-provider');
    const result = await openaiProvider.complete(request({ structuredOutput }));

    expect(result).toStrictEqual({
      text: '',
      provider: 'openai',
      model: OPENAI_MODEL,
      usage: { promptTokens: 120, completionTokens: 40 },
      incomplete: 'refused',
    });
  });

  it('preserves billed usage for a structured response with no choice', async () => {
    chatCreate.mockResolvedValueOnce({
      choices: [],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    });

    const { openaiProvider } = await import('../openai-provider');
    const result = await openaiProvider.complete(request({ structuredOutput }));

    expect(result).toStrictEqual({
      text: '',
      provider: 'openai',
      model: OPENAI_MODEL,
      usage: { promptTokens: 120, completionTokens: 40 },
    });
  });

  it('keeps the unstructured contract: empty throws, a length finish is returned unmarked', async () => {
    const { openaiProvider } = await import('../openai-provider');

    chatCreate.mockResolvedValueOnce(sdkCompletion({ content: null }));
    await expect(openaiProvider.complete(request())).rejects.toThrow(
      'OpenAI returned empty response',
    );

    chatCreate.mockResolvedValueOnce(sdkCompletion({ content: 'Thanks, Ja' }, 'length'));
    const result = await openaiProvider.complete(request());
    expect(result).not.toHaveProperty('incomplete');
    expect(result.text).toBe('Thanks, Ja');
  });
});

// ── The four registered structured tasks, through the REAL runLlmTask and
// BOTH real providers. Primary refuses, fallback truncates: each provider's
// captured request must carry the schema derived from the registered
// outputSchema, and both billed usages must reach the terminal error.
//
// owner_operator is EXPECTED RED until the catalog writer lands its finite
// operation-input union + nullish scope.locationId: at 2c1fcda7 the OpenAI
// helper throws on `locationId: z.uuid().optional()`, and the loose
// `input: z.record(...)` degrades to a property-less object on both wires. ──

describe('registered structured tasks reach both providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmCircuitBreaker.reset();
  });

  const STRUCTURED_TASKS = [
    'triage',
    'judge',
    'solicitation_ask',
    'owner_operator',
  ] as const satisfies readonly LLMTaskId[];

  it.each(STRUCTURED_TASKS)(
    '%s: derived schemas on OpenAI then Anthropic; refusal + truncation stay billed',
    async (taskId) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      chatCreate.mockResolvedValueOnce(sdkCompletion({ content: null, refusal: 'No.' }));
      messagesCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"trunc' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 300, output_tokens: 90 },
      });

      const registered = getLlmTask(taskId).outputSchema;
      if (!(registered instanceof z.ZodObject)) {
        throw new Error(`${taskId}: registered outputSchema must be a Zod object`);
      }
      const registeredKeys = Object.keys(registered.shape).sort();

      const { runLlmTask, LLMStructuredOutputError } = await import('../run-task');
      const outcome = await runLlmTask(taskId, prompt).then(
        () => new Error('expected runLlmTask to throw'),
        (err: unknown) => err,
      );

      expect(outcome).toBeInstanceOf(LLMStructuredOutputError);
      expect(outcome).toMatchObject({
        billedAttempts: [
          { provider: 'openai', model: OPENAI_MODEL, usage: { promptTokens: 120, completionTokens: 40 } },
          { provider: 'anthropic', model: ANTHROPIC_MODEL, usage: { promptTokens: 300, completionTokens: 90 } },
        ],
      });

      expect(chatCreate).toHaveBeenCalledOnce();
      const openaiBody: unknown = chatCreate.mock.calls[0]![0];
      expect(openaiBody).toMatchObject({
        response_format: { type: 'json_schema', json_schema: { name: taskId, strict: true } },
      });
      const openaiSchema = at(openaiBody, 'response_format', 'json_schema', 'schema');
      expect(keysOf(at(openaiSchema, 'properties'))).toEqual(registeredKeys);
      expectOpenAiStrict(openaiSchema);

      expect(messagesCreate).toHaveBeenCalledOnce();
      const anthropicBody: unknown = messagesCreate.mock.calls[0]![0];
      expect(keysOf(at(anthropicBody, 'output_config', 'format'))).toEqual(['schema', 'type']);
      const anthropicSchema = at(anthropicBody, 'output_config', 'format', 'schema');
      expect(keysOf(at(anthropicSchema, 'properties'))).toEqual(registeredKeys);
      for (const node of objectNodes(anthropicSchema)) {
        expect(node.additionalProperties).toBe(false);
        expect(isJsonObject(node.properties)).toBe(true);
      }
      expect(schemaKeywords(anthropicSchema).has('oneOf')).toBe(false);
    },
  );
});
