import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { isMockMode } from '@/lib/shared/mock-mode';
import { recordApiCost, calculateCostUsd } from '@/lib/costs/audit';

// ── Public types ────────────────────────────────────────────────────

export interface ReviewForSummary {
  starRating: number;
  reviewText: string | null;
}

export interface SummaryResult {
  summaryText: string;
  provider: 'openai' | 'anthropic' | 'mock';
  costUsd: number;
}

// ── Constants ───────────────────────────────────────────────────────

const MAX_REVIEWS_FOR_SUMMARY = 30;
const MAX_REVIEW_TEXT_LENGTH = 200;
const LLM_MAX_TOKENS = 250;
const LLM_TEMPERATURE = 0.5;

const OPENAI_MODEL = 'gpt-4o-mini';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT =
  'You are a business intelligence analyst summarizing customer reviews for a small business owner. Be concise and actionable.';

// ── LLM client lazy singletons ──────────────────────────────────────

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// ── LLM calls ───────────────────────────────────────────────────────

interface LLMCallResult {
  text: string;
  provider: 'openai' | 'anthropic';
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

async function callOpenAI(userPrompt: string): Promise<LLMCallResult> {
  const client = getOpenAI();
  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: LLM_TEMPERATURE,
    max_tokens: LLM_MAX_TOKENS,
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty response');

  return {
    text,
    provider: 'openai',
    model: OPENAI_MODEL,
    usage: {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

async function callAnthropic(userPrompt: string): Promise<LLMCallResult> {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: LLM_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const block = response.content[0];
  if (!block || block.type !== 'text') {
    throw new Error('Anthropic returned empty response');
  }

  return {
    text: block.text,
    provider: 'anthropic',
    model: ANTHROPIC_MODEL,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}

async function callLLMWithFallback(userPrompt: string): Promise<LLMCallResult> {
  try {
    return await callOpenAI(userPrompt);
  } catch (openaiError) {
    console.error('[review-summary] OpenAI call failed, falling back to Anthropic:', openaiError);
    return callAnthropic(userPrompt);
  }
}

// ── Prompt builder ──────────────────────────────────────────────────

function buildUserPrompt(reviews: ReviewForSummary[]): string {
  const lines = reviews.map((r, i) => {
    const text = r.reviewText
      ? r.reviewText.slice(0, MAX_REVIEW_TEXT_LENGTH)
      : '(no text)';
    return `${i + 1}. [${r.starRating}★] ${text}`;
  });

  return `Here are ${reviews.length} recent customer reviews:\n\n${lines.join('\n')}\n\nProvide a 3-5 sentence brief covering: recurring themes, any new mentions worth noting, overall sentiment trend, and one actionable recommendation.`;
}

// ── Main export ─────────────────────────────────────────────────────

const MOCK_SUMMARY =
  'Overall customer sentiment is positive with recurring praise for service quality and responsiveness. A few reviews mention wait times as an area for improvement. Recommendation: consider streamlining peak-hour workflows to reduce wait times.';

export async function generateReviewSummary(
  reviews: ReviewForSummary[],
  businessId: string,
): Promise<SummaryResult | null> {
  if (reviews.length === 0) return null;

  if (isMockMode()) {
    return { summaryText: MOCK_SUMMARY, provider: 'mock', costUsd: 0 };
  }

  const capped = reviews.slice(0, MAX_REVIEWS_FOR_SUMMARY);
  const userPrompt = buildUserPrompt(capped);

  let result: LLMCallResult;
  try {
    result = await callLLMWithFallback(userPrompt);
  } catch (error) {
    console.error('[review-summary] Both LLM providers failed:', error);
    return null;
  }

  const costUsd = calculateCostUsd(
    result.model,
    result.usage.promptTokens,
    result.usage.completionTokens,
  );

  // Best-effort cost audit — don't fail the summary if this write fails
  try {
    await recordApiCost({
      businessId,
      provider: result.provider,
      endpoint: 'review-summary',
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
      costUsd,
      responseId: null,
    });
  } catch (auditError) {
    console.error('[review-summary] Failed to record cost audit:', auditError);
  }

  return {
    summaryText: result.text,
    provider: result.provider,
    costUsd,
  };
}
