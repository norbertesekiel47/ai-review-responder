import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LLM_CLIENT_OPTIONS } from './client-options';
import type { LLMProvider, LLMRequest, LLMCallResult, LLMStructuredOutput } from './types';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic(LLM_CLIENT_OPTIONS);
  return _client;
}

/**
 * The `output_config.format` for a structured task, derived from the
 * registered Zod schema by the installed `zodOutputFormat`. The helper keeps
 * the keywords the API accepts and folds the rest (length bounds, numeric
 * bounds, `maxItems`, `minItems` above 1, `pattern`, and string `enum`/`const`)
 * into the node's `description`. The provider sees those as guidance, not as
 * constraints; runLlmTask's Zod validation stays the authority for each one.
 *
 * Only the two wire fields are copied: the helper also returns a `parse`
 * closure meant for `messages.parse`, and this seam validates in runLlmTask.
 */
function outputFormatFor(structured: LLMStructuredOutput): Anthropic.JSONOutputFormat {
  const { type, schema } = zodOutputFormat(structured.schema);
  return { type, schema: describeUuidFormat(schema) as Record<string, unknown> };
}

/**
 * Repeated UUID formats in the Operator unions exceed Anthropic's compiled
 * grammar limit (keyed regression, 2026-09-13). Keep UUID guidance alongside
 * the helper's other description-only constraints. The registered Zod schema
 * still validates every UUID before semantic tenant checks or persistence.
 */
function describeUuidFormat(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(describeUuidFormat);
  if (value === null || typeof value !== 'object') return value;
  const node = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, describeUuidFormat(child)]),
  );
  // Property maps can contain keys named type/format; only a string schema
  // node has this pair of scalar values.
  if (node.type === 'string' && node.format === 'uuid') {
    delete node.format;
    node.description = [node.description, 'Must be a valid UUID.'].filter(Boolean).join('\n');
  }
  return node;
}

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',
  async complete(request: LLMRequest): Promise<LLMCallResult> {
    const { structuredOutput } = request;
    // Temperature forwarding landed with the first temperature-sensitive
    // Anthropic task (#628); it knowingly changes the fallback temperature of
    // every registered task from the SDK default to its LLM_TASKS value —
    // pinned by __tests__/anthropic-provider.test.ts.
    const response = await getClient().messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      // Key absent for unstructured tasks: their request stays byte-identical.
      ...(structuredOutput ? { output_config: { format: outputFormatFor(structuredOutput) } } : {}),
    });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } & typeof b => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const usage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    };

    if (structuredOutput) {
      // Billed either way — see openai-provider.ts. A refusal's text is dropped.
      const incomplete: LLMCallResult['incomplete'] =
        response.stop_reason === 'refusal'
          ? 'refused'
          : response.stop_reason === 'max_tokens'
            ? 'truncated'
            : undefined;
      return {
        text: incomplete === 'refused' ? '' : text,
        provider: 'anthropic',
        model: request.model,
        usage,
        ...(incomplete ? { incomplete } : {}),
      };
    }

    if (!text) {
      throw new Error('Anthropic returned empty response');
    }

    return { text, provider: 'anthropic', model: request.model, usage };
  },
};
