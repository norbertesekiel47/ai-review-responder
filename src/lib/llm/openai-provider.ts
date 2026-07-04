import OpenAI from 'openai';
import { LLM_CLIENT_OPTIONS } from './client-options';
import type { LLMProvider, LLMRequest, LLMCallResult } from './types';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI(LLM_CLIENT_OPTIONS);
  return _client;
}

export const openaiProvider: LLMProvider = {
  id: 'openai',
  async complete(request: LLMRequest): Promise<LLMCallResult> {
    const response = await getClient().chat.completions.create({
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned empty response');
    return {
      text,
      provider: 'openai',
      model: request.model,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  },
};
