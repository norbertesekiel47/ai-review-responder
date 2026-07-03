import Anthropic from '@anthropic-ai/sdk';
import { LLM_CLIENT_OPTIONS } from './client-options';
import type { LLMProvider, LLMRequest, LLMCallResult } from './types';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic(LLM_CLIENT_OPTIONS);
  return _client;
}

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',
  async complete(request: LLMRequest): Promise<LLMCallResult> {
    const response = await getClient().messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } & typeof b => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text) {
      throw new Error('Anthropic returned empty response');
    }

    return {
      text,
      provider: 'anthropic',
      model: request.model,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
    };
  },
};
