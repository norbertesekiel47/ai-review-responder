import type { NormalizedReview } from '@/lib/reviews/types';
import type {
  BusinessContext,
  DemoBusinessContext,
  VoiceExample,
  GenerationOptions,
  GenerationResult,
} from './types';

// ── Response templates ────────────────────────────────────────────────

const TEMPLATES = {
  positive: {
    en: [
      'Thank you so much, {name}! We\'re thrilled to hear you had a wonderful experience. Your kind words mean the world to us and motivate our team to keep delivering our best.',
      'We really appreciate your kind feedback, {name}! It\'s always a pleasure to hear when our guests leave happy. We look forward to welcoming you back soon!',
    ],
    es: [
      '¡Muchas gracias, {name}! Nos alegra mucho saber que tuvo una experiencia positiva. Sus palabras son una gran motivación para nuestro equipo. ¡Esperamos verle pronto!',
    ],
    fr: [
      'Merci infiniment, {name}! Nous sommes ravis que votre expérience ait été à la hauteur de vos attentes. Votre avis nous encourage à continuer sur cette voie. À bientôt!',
    ],
    de: [
      'Herzlichen Dank, {name}! Es freut uns sehr, dass Sie mit uns zufrieden waren. Ihr Feedback motiviert unser Team sehr. Wir freuen uns auf Ihren nächsten Besuch!',
    ],
  },
  negative: {
    en: [
      'Thank you for sharing your experience, {name}. We\'re truly sorry to hear that things didn\'t meet your expectations. This is not the standard we hold ourselves to, and we\'d love the opportunity to make it right. Please reach out to us directly so we can address your concerns.',
      'We sincerely apologize for the experience you described, {name}. Your feedback is important to us and has been shared with our team. We take every concern seriously and would like to make this right. Please contact us at your convenience.',
    ],
    es: [
      'Lamentamos mucho su experiencia, {name}. Esto no refleja los estándares que nos hemos fijado y nos gustaría tener la oportunidad de remediar la situación. Por favor, póngase en contacto con nosotros directamente.',
    ],
    fr: [
      'Nous vous présentons nos sincères excuses, {name}. Votre expérience ne correspond pas aux standards que nous nous sommes fixés. Nous aimerions avoir l\'opportunité de corriger cela. N\'hésitez pas à nous contacter directement.',
    ],
    de: [
      'Wir entschuldigen uns aufrichtig für Ihre Erfahrung, {name}. Dies entspricht nicht unseren Qualitätsstandards. Wir würden uns freuen, wenn Sie uns die Möglichkeit geben, die Situation zu bereinigen. Bitte kontaktieren Sie uns direkt.',
    ],
  },
  neutral: {
    en: [
      'Thank you for taking the time to leave a review, {name}. We appreciate your feedback and will use it to continue improving our service. We hope to exceed your expectations on your next visit.',
    ],
    es: [
      'Gracias por su valoración, {name}. Apreciamos su opinión y la utilizaremos para seguir mejorando. Esperamos poder superar sus expectativas en su próxima visita.',
    ],
    fr: [
      'Merci pour votre avis, {name}. Nous apprécions vos retours et les utiliserons pour continuer à nous améliorer. Nous espérons vous offrir une meilleure expérience lors de votre prochaine visite.',
    ],
    de: [
      'Vielen Dank für Ihre Bewertung, {name}. Wir schätzen Ihr Feedback und werden es nutzen, um unsere Leistungen weiter zu verbessern. Wir hoffen, Sie bei Ihrem nächsten Besuch begeistern zu können.',
    ],
  },
} as const;

type SentimentKey = keyof typeof TEMPLATES;
type LanguageKey = 'en' | 'es' | 'fr' | 'de';

// ── Helpers ───────────────────────────────────────────────────────────

function pickTemplate(
  sentiment: SentimentKey,
  language: string,
): { text: string; language: LanguageKey } {
  const langKey: LanguageKey =
    language === 'es' || language === 'fr' || language === 'de'
      ? (language as LanguageKey)
      : 'en';

  const pool = TEMPLATES[sentiment][langKey] as readonly string[];
  const text = pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!;
  return { text, language: langKey };
}

function classifySentiment(starRating: number): SentimentKey {
  if (starRating >= 4) return 'positive';
  if (starRating <= 2) return 'negative';
  return 'neutral';
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Mock generator ────────────────────────────────────────────────────

export async function generateMockResponse(
  review: NormalizedReview,
  _businessContext: DemoBusinessContext | BusinessContext,
  _voiceExamples: VoiceExample[],
  _options: GenerationOptions,
): Promise<GenerationResult> {
  await new Promise((resolve) =>
    setTimeout(resolve, randomInt(100, 300)),
  );

  const sentiment = classifySentiment(review.starRating);
  const picked = pickTemplate(sentiment, review.detectedLanguage);
  const responseText = picked.text.replace('{name}', review.reviewerName);

  return {
    responseText,
    language: picked.language,
    provider: 'openai',
    model: 'mock-gpt-4o-mini',
    usage: {
      promptTokens: randomInt(150, 250),
      completionTokens: randomInt(50, 100),
    },
    costUsd: 0,
    apiCostId: null,
  };
}
