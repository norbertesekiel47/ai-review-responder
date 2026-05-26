// ── Demo-mode business context (minimal) ────────────────────────────

export interface DemoBusinessContext {
  name: string;
  category: string | null;
}

// ── Business context for production prompt building ─────────────────

export interface BusinessContext extends DemoBusinessContext {
  id: string;
  name: string;
  category: string | null;
  tone: string;
  productsServices: string | null;
  staffNames: string[];
  highlightFacts: string[];
  avoidFacts: string[];
  sampleResponses: string[];
  subscriptionTier: 'founders' | 'standard' | 'premium';
}

// ── Voice learning examples ─────────────────────────────────────────

export interface VoiceExample {
  originalDraft: string;
  editedVersion: string;
  reviewStarRating: number;
}

// ── Generation options ──────────────────────────────────────────────

export interface GenerationOptions {
  mode: 'demo' | 'production';
  /** Required in production mode for idempotent caching */
  reviewId?: string;
  /** Response version — 1 for first draft, increments on regeneration */
  version?: number;
  /** Required in production mode for cost reservation */
  businessId?: string;
  /** Billing account ID — recorded on api_costs for business-scoped production calls. */
  accountId?: string;
  /** Required in production mode for tier-aware limits */
  subscriptionTier?: 'founders' | 'standard' | 'premium';
  /** Skip idempotent cache read AND write. Used by avoid-facts retry so a
   *  cached violating response doesn't short-circuit the regeneration. */
  skipCache?: boolean;
}

// ── Generation result ───────────────────────────────────────────────

export interface GenerationResult {
  responseText: string;
  language: string;
  provider: 'openai' | 'anthropic';
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  costUsd: number;
  /** UUID of the api_costs row, if audit write succeeded. Worker uses this to link to the response row. */
  apiCostId: string | null;
}

// ── Built prompt (passed from prompt-builder to generator) ──────────

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
}
