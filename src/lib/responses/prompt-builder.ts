import type { NormalizedReview } from '@/lib/reviews/types';
import type { BusinessContext, VoiceExample, BuiltPrompt } from './types';

// ── Category → tone inference (demo mode) ────────────────────────────

const CATEGORY_TONE_MAP: Record<string, string> = {
  restaurant: 'warm and appreciative',
  cafe: 'friendly and casual',
  coffee: 'friendly and casual',
  hotel: 'professional and gracious',
  motel: 'professional and gracious',
  salon: 'warm and personal',
  spa: 'warm and personal',
  barber: 'warm and personal',
  dental: 'professional and caring',
  medical: 'professional and empathetic',
  clinic: 'professional and empathetic',
  hospital: 'professional and empathetic',
  legal: 'professional and respectful',
  law: 'professional and respectful',
  automotive: 'helpful and straightforward',
  mechanic: 'helpful and straightforward',
  retail: 'friendly and helpful',
  store: 'friendly and helpful',
  gym: 'energetic and encouraging',
  fitness: 'energetic and encouraging',
};

const DEFAULT_TONE = 'professional and friendly';

function inferTone(category: string | null): string {
  if (!category) return DEFAULT_TONE;
  const lower = category.toLowerCase().trim();
  for (const [keyword, tone] of Object.entries(CATEGORY_TONE_MAP)) {
    if (lower.includes(keyword)) return tone;
  }
  return DEFAULT_TONE;
}

// ── ISO 639-1 → human-readable language name ────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  hi: 'Hindi',
  tr: 'Turkish',
  pl: 'Polish',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  nb: 'Norwegian',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ms: 'Malay',
  tl: 'Tagalog',
  uk: 'Ukrainian',
  cs: 'Czech',
  ro: 'Romanian',
  hu: 'Hungarian',
  el: 'Greek',
  he: 'Hebrew',
  fa: 'Persian',
};

function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

// ── Shared helpers ───────────────────────────────────────────────────

const SHORT_TEXT_WORD_THRESHOLD = 20;

/**
 * Build the language directive for the system prompt.
 *
 * For short reviews (<20 words), franc defaults to 'en' regardless of
 * actual language. In that case, we DON'T tell the LLM "Respond in English"
 * — instead we say "Respond in the same language as the review" and let
 * the LLM infer the language from the review text itself.
 */
function languageDirective(review: NormalizedReview): string {
  const wordCount = review.reviewText?.trim().split(/\s+/).length ?? 0;
  if (wordCount < SHORT_TEXT_WORD_THRESHOLD) {
    return 'Respond in the same language as the review';
  }
  const name = languageName(review.detectedLanguage);
  return `Respond in ${name} (the same language as the review)`;
}

function wordLimit(starRating: number): string {
  return starRating >= 4
    ? 'Keep the response under 80 words'
    : 'Keep the response under 120 words';
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function buildUserPrompt(review: NormalizedReview): string {
  const date = formatDate(review.reviewDate);

  if (!review.reviewText) {
    return `${review.starRating}-star rating from ${review.reviewerName} on ${date} (no written review).`;
  }

  return [
    `${review.starRating}-star review from ${review.reviewerName} on ${date}:`,
    '',
    `"${review.reviewText}"`,
  ].join('\n');
}

// ── Demo prompt ──────────────────────────────────────────────────────

export function buildDemoPrompt(
  review: NormalizedReview,
  businessName: string,
  category: string | null,
): BuiltPrompt {
  const tone = inferTone(category);
  const categoryClause = category ? `, a ${category}` : '';

  const rules = [
    `- ${languageDirective(review)}`,
    `- Use a ${tone} tone`,
    `- ${wordLimit(review.starRating)}`,
    '- Address the reviewer by their first name if available',
    '- Reference specific details from their review',
    '- Never use placeholder text like [Business Name] or [specific detail]',
    '- Never invent facts not mentioned in the review',
  ];

  const systemPrompt = [
    `You are a review response assistant for ${businessName}${categoryClause}.`,
    'Write a response to the following Google review.',
    '',
    'Rules:',
    ...rules,
  ].join('\n');

  return { systemPrompt, userPrompt: buildUserPrompt(review) };
}

// ── Production prompt ────────────────────────────────────────────────

export function buildProductionPrompt(
  review: NormalizedReview,
  business: BusinessContext,
  voiceExamples: VoiceExample[],
): BuiltPrompt {
  const categoryClause = business.category ? `, a ${business.category}` : '';

  const rules: string[] = [
    `- ${languageDirective(review)}`,
    `- Use a ${business.tone} tone`,
    `- ${wordLimit(review.starRating)}`,
    '- Address the reviewer by their first name if available',
    '- Reference specific details from their review',
    '- Never use placeholder text like [Business Name] or [specific detail]',
    '- Never invent facts not mentioned in the review',
  ];

  if (business.staffNames.length > 0) {
    rules.push(
      `- Staff members you may reference if the reviewer mentions them: ${business.staffNames.join(', ')}`,
    );
  }

  if (business.productsServices) {
    rules.push(
      `- The business offers: ${business.productsServices}`,
    );
  }

  if (business.avoidFacts.length > 0) {
    rules.push(`- Never mention: ${business.avoidFacts.join(', ')}`);
  }

  if (business.highlightFacts.length > 0) {
    rules.push(
      `- When relevant, highlight: ${business.highlightFacts.join(', ')}`,
    );
  }

  const sections = [
    `You are a review response assistant for ${business.name}${categoryClause}.`,
    'Write a response to the following Google review.',
    '',
    'Rules:',
    ...rules,
  ];

  const selectedExamples = selectVoiceExamples(
    voiceExamples,
    review.starRating,
  );
  if (selectedExamples.length > 0) {
    sections.push('', buildVoiceSection(selectedExamples));
  }

  return {
    systemPrompt: sections.join('\n'),
    userPrompt: buildUserPrompt(review),
  };
}

// ── Voice example selection ──────────────────────────────────────────

const MAX_VOICE_EXAMPLES = 3;

function selectVoiceExamples(
  examples: VoiceExample[],
  currentStarRating: number,
): VoiceExample[] {
  if (examples.length === 0) return [];

  const isPositive = currentStarRating >= 4;

  // Prefer tone-matched examples, fill with others if needed
  const matched = examples.filter(
    (ex) => (ex.reviewStarRating >= 4) === isPositive,
  );
  const unmatched = examples.filter(
    (ex) => (ex.reviewStarRating >= 4) !== isPositive,
  );

  return [...matched, ...unmatched].slice(0, MAX_VOICE_EXAMPLES);
}

function buildVoiceSection(examples: VoiceExample[]): string {
  const lines = [
    'Here are examples of how the owner prefers to write responses. Match their style and tone:',
  ];

  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i]!;
    lines.push(
      '',
      `Example ${i + 1} (response to a ${ex.reviewStarRating}-star review):`,
      `AI draft: "${ex.originalDraft}"`,
      `Owner's preferred version: "${ex.editedVersion}"`,
    );
  }

  return lines.join('\n');
}
