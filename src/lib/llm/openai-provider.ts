import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { LLM_CLIENT_OPTIONS } from './client-options';
import type { LLMProvider, LLMRequest, LLMCallResult, LLMStructuredOutput } from './types';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI(LLM_CLIENT_OPTIONS);
  return _client;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keys whose value maps NAMES to subschemas. The names are data (a property
 *  may be called `maxLength`) and pass through untouched. */
const SUBSCHEMA_MAP_KEYS: ReadonlySet<string> = new Set(['properties', '$defs', 'definitions']);

/**
 * Zod 4 renders a discriminatedUnion as `oneOf`, which the pinned model
 * rejects (keyed Run C probe: HTTP 400). Its branches carry disjoint literal
 * discriminators, so `anyOf` accepts exactly the same documents. String
 * length bounds are preserved: the same keyed probe confirmed support.
 * Strict validity of the former `oneOf`
 * branches (required = every key, additionalProperties false) is pinned by
 * __tests__/openai-provider.test.ts against every registered schema.
 */
function toStrictModeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictModeNode);
  if (!isJsonObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (SUBSCHEMA_MAP_KEYS.has(key) && isJsonObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, toStrictModeNode(child)]),
      );
      continue;
    }
    out[key === 'oneOf' ? 'anyOf' : key] = toStrictModeNode(value);
  }
  return out;
}

/**
 * The chat-completions `response_format` for a structured task, derived from
 * the registered Zod schema by the installed `zodResponseFormat` (strict: every
 * property required, `additionalProperties: false`). The helper THROWS on an
 * `.optional()` field that is not also `.nullable()` — before any request, so
 * nothing is billed. Built per call: conversion is cheap beside the completion,
 * and a cache would be a second copy of the registry.
 */
function responseFormatFor(structured: LLMStructuredOutput): OpenAI.ResponseFormatJSONSchema {
  const helper = zodResponseFormat(structured.schema, structured.name);
  const schema = toStrictModeNode(helper.json_schema.schema);
  if (!isJsonObject(schema)) {
    throw new Error(`llm: OpenAI response schema for ${structured.name} is not an object`);
  }
  return {
    type: 'json_schema',
    json_schema: { name: helper.json_schema.name, strict: true, schema },
  };
}

function structuredCompletion(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined,
): Pick<LLMCallResult, 'text' | 'incomplete'> {
  // Keep usage in the caller's result, but never return refusal text: it can
  // quote owner or review text. Refusal takes precedence over truncation.
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
    return { text: '', incomplete: 'refused' };
  }
  const text = choice?.message?.content ?? '';
  if (choice?.finish_reason === 'length') return { text, incomplete: 'truncated' };
  return { text };
}

export const openaiProvider: LLMProvider = {
  id: 'openai',
  async complete(request: LLMRequest): Promise<LLMCallResult> {
    const { structuredOutput } = request;
    const response = await getClient().chat.completions.create({
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      // Key absent for unstructured tasks: their request stays byte-identical.
      ...(structuredOutput ? { response_format: responseFormatFor(structuredOutput) } : {}),
    });
    const choice = response.choices[0];
    const usage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    };

    if (structuredOutput) {
      return { ...structuredCompletion(choice), provider: 'openai', model: request.model, usage };
    }

    const text = choice?.message?.content;
    if (!text) throw new Error('OpenAI returned empty response');
    return { text, provider: 'openai', model: request.model, usage };
  },
};
