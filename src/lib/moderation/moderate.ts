import OpenAI from 'openai';
import { runOutputFilter, SEVERITY_RANK, type ModerationDecision } from './output-filter';

// Worker-only. Never import from Next.js/Vercel code — moderation is an
// LLM-class external call and belongs on the Railway worker.
const PROVIDER_MODEL = 'omni-moderation-latest';

function providerEnabled(): boolean {
  return process.env.OPENAI_MODERATION_ENABLED === 'true';
}

let cachedClient: OpenAI | null = null;
function client(): OpenAI {
  if (!cachedClient) cachedClient = new OpenAI();
  return cachedClient;
}

function mergeDecisions(a: ModerationDecision, b: ModerationDecision): ModerationDecision {
  const top = SEVERITY_RANK[a.severity] >= SEVERITY_RANK[b.severity] ? a : b;
  const reason = [a.reason, b.reason].filter(Boolean).join(', ');
  return {
    flagged: a.flagged || b.flagged,
    severity: top.severity,
    reason: reason.length > 0 ? reason : null,
    categories: { ...a.categories, ...b.categories },
    score: Math.max(a.score ?? 0, b.score ?? 0),
    source: top.source ?? a.source ?? b.source,
  };
}

/**
 * Always runs the local filter. When OPENAI_MODERATION_ENABLED=true, also calls
 * the OpenAI Moderation API and merges (provider flag → high severity). Never
 * throws: a provider outage falls back to the local decision and records a
 * warning marker in categories, so a moderation failure can never silently
 * approve unsafe text by crashing the generation path.
 */
export async function moderateResponse(text: string): Promise<ModerationDecision> {
  const local = runOutputFilter(text);
  if (!providerEnabled()) return local;

  try {
    const response = await client().moderations.create({ model: PROVIDER_MODEL, input: text });
    const result = response.results?.[0];
    if (!result) return local;

    if (result.flagged !== true) {
      return { ...local, categories: { ...local.categories, openai_moderation: 'clean' } };
    }

    const provider: ModerationDecision = {
      flagged: true,
      severity: 'high',
      reason: 'openai_moderation',
      categories: { openai_categories: result.categories },
      score: 1,
      source: 'openai_moderation',
    };
    return mergeDecisions(local, provider);
  } catch (err) {
    console.error('[moderation] OpenAI moderation failed; using local rules only:', err);
    return { ...local, categories: { ...local.categories, openai_moderation: 'error' } };
  }
}
