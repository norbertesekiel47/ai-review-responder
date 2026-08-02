import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatPrompt, LLMRequest } from '../types';
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

function sdkResponse(text = 'Merci, Jane!') {
  return {
    content: [{ type: 'text', text }],
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
