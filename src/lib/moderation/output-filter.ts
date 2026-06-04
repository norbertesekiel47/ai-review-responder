/**
 * Result of moderating one generated response. `source` records which layer
 * produced the flag; `providerStatus` records the external-provider verdict
 * that future auto-approval gates must read; `categories` carries per-rule hit
 * counts (local), provider details, and legacy api_costs metadata.
 */
export type ProviderModerationStatus = 'clean' | 'error' | null;

export type ModerationDecision = {
  flagged: boolean;
  severity: 'low' | 'medium' | 'high';
  reason: string | null;
  categories: Record<string, unknown>;
  score: number | null;
  source: 'local_regex' | 'openai_moderation' | null;
  providerStatus: ProviderModerationStatus;
};

export const SEVERITY_RANK: Record<ModerationDecision['severity'], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

type Severity = 'medium' | 'high';
interface Rule {
  category: string;
  severity: Severity;
  patterns: RegExp[];
}

// High-confidence, word-boundaried patterns. No `g` flag — `.test()` must stay
// stateless. Tuned to avoid false positives on common words (company, complete,
// complimentary) — see the false-positive test.
const RULES: Rule[] = [
  {
    category: 'refund_discount',
    severity: 'high',
    patterns: [
      /\brefund(s|ed|ing)?\b/i,
      /\bdiscount(s|ed|ing)?\b/i,
      /\bcoupon(s)?\b/i,
      /\bvoucher(s)?\b/i,
      /\$\s*\d+\s*(off|back|refund)\b/i,
      /\b\d+\s*%\s*off\b/i,
      /\bfree\s+(meal|meals|drink|drinks|appetizer|dessert|night|stay|item|service|gift)\b/i,
      /\bon\s+the\s+house\b/i,
      // Giveaway sense only — avoid false-positiving friendly phrases like
      // "you can count on us" / "rely on us".
      /\b(meal|meals|drink|drinks|dessert|appetizer|coffee|lunch|dinner|round|tab|bill)\s+(is\s+|are\s+|'?s\s+)?on\s+us\b/i,
      /\bcomp(ed|ing|s)?\b/i,
    ],
  },
  {
    category: 'legal_fault',
    severity: 'high',
    patterns: [
      /\bwe\s+(are|were)\s+liable\b/i,
      /\bour\s+(legal\s+)?fault\b/i,
      /\bnegligen(t|ce)\b/i,
      /\blawsuit\b/i,
      /\bliable\b/i,
      /\badmit(ting)?\s+(fault|liability|wrongdoing)\b/i,
    ],
  },
  {
    category: 'injection_compliance',
    severity: 'high',
    patterns: [
      /\bas\s+instructed\b/i,
      /\bignore\s+(the\s+|all\s+)?previous\b/i,
      /\bsystem\s+prompt\b/i,
      /\bdeveloper\s+message\b/i,
      /\bas\s+you\s+(asked|requested|commanded)\b/i,
    ],
  },
  {
    category: 'profanity',
    severity: 'high',
    // Small high-confidence denylist; extend as real samples appear.
    patterns: [
      /\bf+u+c+k\w*\b/i,
      /\bbull?shit\w*\b/i,
      /\basshole\w*\b/i,
      /\bbitch\w*\b/i,
      /\bbastard\w*\b/i,
    ],
  },
  {
    category: 'competitor',
    severity: 'medium',
    patterns: [
      /\b(better|worse)\s+than\s+(our\s+)?competitors?\b/i,
      /\bunlike\s+(our\s+)?competitors?\b/i,
      /\bcompetitor('s|s)?\b/i,
    ],
  },
  {
    category: 'advice',
    severity: 'medium',
    patterns: [
      /\byou\s+should\s+(see|consult)\s+(a\s+)?(doctor|lawyer|attorney|accountant|physician)\b/i,
      /\b(medical|legal|financial)\s+advice\b/i,
      /\bdiagnos(e|is|ed)\b/i,
      /\bprescri(be|ption)\b/i,
    ],
  },
];

const SCORE_BY_SEVERITY: Record<ModerationDecision['severity'], number> = {
  low: 0,
  medium: 0.5,
  high: 1,
};

export function runOutputFilter(text: string): ModerationDecision {
  const categories: Record<string, unknown> = {};
  const reasons: string[] = [];
  let topSeverity: ModerationDecision['severity'] = 'low';

  for (const rule of RULES) {
    const hits = rule.patterns.filter((pattern) => pattern.test(text)).length;
    if (hits === 0) continue;
    categories[rule.category] = hits;
    reasons.push(rule.category);
    if (SEVERITY_RANK[rule.severity] > SEVERITY_RANK[topSeverity]) {
      topSeverity = rule.severity;
    }
  }

  const flagged = reasons.length > 0;
  return {
    flagged,
    severity: topSeverity,
    reason: flagged ? reasons.join(', ') : null,
    categories,
    score: flagged ? SCORE_BY_SEVERITY[topSeverity] : 0,
    source: flagged ? 'local_regex' : null,
    providerStatus: null,
  };
}
