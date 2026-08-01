/**
 * Ask compliance lint: note admissibility (ask-generation design §1.2) and the
 * seven-class fail-closed content lint (§2) run over every solicitation render
 * before it is persisted. A failing render is stored withheld — no fallback
 * send, no fallback template, no automatic regeneration (§2.6).
 *
 * Pure module (restraint-policy.ts conventions): no DB access, no clock reads,
 * no I/O — identical inputs produce identical verdicts. ASK_LINT_VERSION is
 * stored on every render so a verdict stays attributable to the ruleset that
 * produced it; bump it whenever the class table, the admissibility rules, or
 * the matching logic changes. The full rule table is golden-filed
 * (__tests__/ask-lint-classes.golden.json) so tuning is a visible diff.
 *
 * DELIBERATE NON-REUSE of `src/lib/moderation/output-filter.ts` (§2.7): its
 * `refund_discount` rule table looks like class 1 but encodes a DIFFERENT
 * fact. A *reply* must not promise the reviewer compensation; an *ask* must
 * not offer a stranger anything at all, at any rating, per Google's stricter
 * standard (constraints doc §1.2, stricter than FTC § 465.4). Coupling them
 * would let a reply-side false-positive tune silently loosen send-mode
 * compliance. One authoritative owner per fact — these are two facts.
 */

import {
  FOOTER_SEPARATOR,
  REVIEW_LINK_PLACEHOLDER,
  SENDER_IDENTIFICATION_PREFIX,
  UNSUBSCRIBE_LINE_PREFIX,
  UNSUBSCRIBE_URL_PLACEHOLDER,
} from './ask-render';

/**
 * Bump when the class table, admissibility rules, provenance allowlist, or
 * matching logic changes (RESTRAINT_POLICY_VERSION pattern) — a verdict must
 * stay reproducible under the version that produced it.
 */
export const ASK_LINT_VERSION = 'ask_lint_2026-07-31.3';

/**
 * The union of everything that can block a render, so `blocked_reason` has one
 * owner (§2.1). Listed in class order 1–7; `moderation_high` is a member of
 * the vocabulary but is NEVER assigned by the lint — it belongs to the
 * moderation stage (§3).
 */
export const ASK_BLOCK_REASONS = [
  'incentive_language',
  'review_steering',
  'gating_funnel',
  'pressure',
  'deceptive_subject',
  'unverifiable_fact',
  'missing_required_element',
  'moderation_high',
] as const;
export type AskBlockReason = (typeof ASK_BLOCK_REASONS)[number];

/** The seven reasons the lint itself can assign. */
export type AskLintClass = Exclude<AskBlockReason, 'moderation_high'>;

/**
 * The same seven as a runtime value, derived from the vocabulary above so the
 * "block reasons minus moderation_high" fact keeps ONE owner. Consumed by the
 * `lint_detail` read-boundary parser (outreach.ts).
 */
export const ASK_LINT_CLASSES: readonly AskLintClass[] = ASK_BLOCK_REASONS.filter(
  (reason): reason is AskLintClass => reason !== 'moderation_high',
);

// ---------------------------------------------------------------------------
// Note admissibility (§1.2) — the single largest untrusted-input surface.
// Inadmissible ⇒ the note is OMITTED and generation proceeds on the four
// structured fields: a degradation, never a withhold and never a block.
// ---------------------------------------------------------------------------

export type NoteDisposition = 'admitted' | 'absent' | `rejected:${string}`;

type NoteRejectionRule = 'sentiment_token' | 'contact_channel' | 'imperative_to_model';

/**
 * Phone-shaped PII, shared by note admissibility (§1.2 item 2) and class 5 —
 * one owner for the fact "a digit run this long is a phone number", because
 * the two rules protect the same input against the same evasion. A raw
 * `\d{7,}` sees only CONTIGUOUS digits, so every separator scheme a human
 * actually types ("555-123-4567", "(555) 123 4567", "+1 555 123 4567") walks
 * straight past it; both rules therefore test the digit run against the
 * separator-STRIPPED text. No `g` flag — `.test()` must stay stateless.
 *
 * Stripping is deliberately blunt, so a hyphenated date ("2026-07-31") reads
 * as a digit run too. That is the fail-closed side: an inadmissible note is
 * OMITTED and generation proceeds on the four structured fields (a
 * degradation), whereas a leaked phone number reaches a stranger.
 */
const PII_DIGIT_RUN_LENGTH = 7;
const PII_DIGIT_RUN_PATTERN = new RegExp(`\\d{${PII_DIGIT_RUN_LENGTH},}`);
const PHONE_SEPARATOR_PATTERN = /[\s().+-]/g;

function stripPhoneSeparators(text: string): string {
  return text.replace(PHONE_SEPARATOR_PATTERN, '');
}

/** §1.2 item 4: normalized (whitespace-collapsed) notes longer than this are rejected. */
const MAX_NORMALIZED_NOTE_LENGTH = 200;

/**
 * §1.2 items 1–3, first-hit-wins in listed order. Patterns are tested against
 * the whitespace-NORMALIZED note so multi-word tokens cannot be split across
 * line breaks. No `g` flags — `.test()` must stay stateless.
 */
const NOTE_ADMISSIBILITY_RULES: ReadonlyArray<{
  rule: NoteRejectionRule;
  patterns: readonly RegExp[];
  /** Tested against the separator-stripped note (see `stripPhoneSeparators`). */
  separatorStrippedPatterns?: readonly RegExp[];
}> = [
  {
    // Item 1 — sentiment / rating tokens: a note carrying sentiment drags the
    // copy toward conditional-sentiment phrasing (the gating funnel), and
    // selection is sentiment-blind by ADR 0012.
    rule: 'sentiment_token',
    patterns: [
      /\bloved\b/i,
      /\blove(s|d)?\s+it\b/i,
      /\bthrilled\b/i,
      /\bdelighted\b/i,
      /\bhappy\b/i,
      /\bunhappy\b/i,
      /\bangry\b/i,
      /\bupset\b/i,
      /\bcomplained\b/i,
      /\bcomplaints?\b/i,
      /\brefund/i,
      /\bapolog/i,
      /\b[1-5]\s*star/i,
      /★/,
      /\bgreat customer\b/i,
      /\bdifficult customer\b/i,
      /\bhated\b/i,
    ],
  },
  {
    // Item 2 — contact channels: third-party PII and off-platform routing.
    rule: 'contact_channel',
    patterns: [
      /https?:\/\//i,
      /\bwww\./i,
      /\b[a-z0-9-]+\.(?:com|net|org|io|co|us|info|biz|app|dev)\b/i,
      /@/,
    ],
    // The domain patterns above depend on the separators (`.` carries the
    // TLD), so only the digit run moves to the stripped text — the same split
    // class 5 makes (codex round-4 finding 2: "555-123-4567" was admissible).
    separatorStrippedPatterns: [PII_DIGIT_RUN_PATTERN],
  },
  {
    // Item 3 — imperative-to-model shapes (prompt injection). The prompt's
    // fencing (§1.3) is defence in depth; this is the primary gate.
    rule: 'imperative_to_model',
    patterns: [
      /ignore\s+(?:the\s+)?(?:above|previous)/i,
      /\byou are\b/i,
      /\bsystem:/i,
      /\bassistant:/i,
      /\binstructions?:/i,
      /\brespond with\b/i,
      /```/,
    ],
  },
];

/**
 * Decide whether an owner-pasted visit note may reach the prompt. `admissible`
 * is true exactly when `disposition === 'admitted'`; a null/blank note is
 * `absent` (nothing to admit), so "no note on file" and "note rejected" stay
 * distinguishable in `interpolation_inputs` (§5.3).
 */
export function assessNoteAdmissibility(note: string | null): {
  admissible: boolean;
  disposition: NoteDisposition;
} {
  if (note === null || note.trim().length === 0) {
    return { admissible: false, disposition: 'absent' };
  }

  const normalized = note.trim().replace(/\s+/g, ' ');
  const separatorStripped = stripPhoneSeparators(normalized);
  for (const { rule, patterns, separatorStrippedPatterns } of NOTE_ADMISSIBILITY_RULES) {
    if (
      patterns.some((pattern) => pattern.test(normalized)) ||
      separatorStrippedPatterns?.some((pattern) => pattern.test(separatorStripped))
    ) {
      return { admissible: false, disposition: `rejected:${rule}` };
    }
  }
  if (normalized.length > MAX_NORMALIZED_NOTE_LENGTH) {
    return { admissible: false, disposition: 'rejected:length' };
  }
  return { admissible: true, disposition: 'admitted' };
}

// ---------------------------------------------------------------------------
// The class table (§2.3, class 5 as amended by AMEND B5).
// ---------------------------------------------------------------------------

export interface AskLintInput {
  subject: string;
  /** The ASSEMBLED body — `assembleAskBody` output, footer included. */
  body: string;
  /**
   * Every §1.1 allowlisted value the prompt saw (first name, business name,
   * visit bucket, vertical, admitted note). Powers the classes 1–4 exemption
   * (§2.5) and the class 6 provenance corpus (§2.4).
   */
  interpolationValues: readonly string[];
  /**
   * The subset of `interpolationValues` NOT permitted to appear in the subject
   * (B5: "no PII beyond the contact's first name") — today: the admitted visit
   * note. The bucket and vertical are closed vocabularies, definitionally not
   * PII, and must NOT be listed here; first name and business name are
   * subject-safe by B5. Required so the caller decides explicitly (fail-closed
   * by construction). Enforcement is FRAGMENT-LEVEL, not whole-value: any
   * content token of a listed value blocks the subject (see
   * `subjectCarriesDisallowedFragment`), so "discussed HIV treatment" also
   * bans "HIV" and "treatment" from the subject line.
   */
  subjectDisallowedValues: readonly string[];
}

export interface AskLintVerdict {
  /** First-hit-wins across classes 1–7; null when clean. */
  blockedReason: AskLintClass | null;
  /** Every class that matched, in class order — stored in `lint_detail` so tuning has data. */
  matches: AskLintClass[];
}

/**
 * Classes 1–4: pattern classes over `subject + '\n' + body`, subject to the
 * interpolated-value exemption (§2.5). `g` flags are required for matchAll
 * span extraction; matchAll clones the regex, so shared state never leaks
 * between evaluations.
 */
const CONTENT_CLASSES: ReadonlyArray<{ reason: AskLintClass; patterns: readonly RegExp[] }> = [
  {
    // §5 row 2 — an ask must not offer a stranger anything at all.
    reason: 'incentive_language',
    patterns: [
      /\bdiscount(s|ed)?\b/gi,
      /\bcoupons?\b/gi,
      /\bvouchers?\b/gi,
      /\bgift cards?\b/gi,
      // "free <noun>" — (?!to\b) keeps the idiom "feel free to …" (near-certain
      // in polite ask copy) from blocking every render; "free coffee" still hits.
      /\bfree\s+(?!to\b)[a-z]/gi,
      /\bon us\b/gi,
      /\bon the house\b/gi,
      /\bcomp(ed|ing)\b/gi,
      /\bcomplimentary\b/gi,
      /\braffles?\b/gi,
      /\bgiveaways?\b/gi,
      /\bsweepstakes?\b/gi,
      /\bentry\b/gi,
      /\bentered to win\b/gi,
      // "chance/opportunity to win", "win a prize", "one of five winners" —
      // the consideration is the CHANCE, not a guaranteed good (codex round-3
      // finding 3: "complimentary" and "chance to win" sailed through).
      /\b(?:chance|opportunity|drawing) to win\b/gi,
      /\bwin (?:a|an|one of)\b/gi,
      /\bprizes?\b/gi,
      /\bwinners?\b/gi,
      /\bcash ?back\b/gi,
      /\bstore credit\b/gi,
      /\bpoints\b/gi,
      /\brewards?\b/gi,
      /\d+\s*%\s*off/gi,
      /\$\s*\d+\s*off/gi,
      // Written-out percentages: the numeric forms above cannot see "ten
      // percent off" (codex round-4 finding 3). Matching the "… off" SHAPE
      // rather than enumerating written numbers subsumes every one of them,
      // and "fifty percent discount" is already class 1 via /discount/.
      /\b(?:percent|per\s?cent)\s+off\b/gi,
      /\bhalf[\s-]?(?:off|price)\b/gi,
      /\bin exchange for\b/gi,
    ],
  },
  {
    // §5 row 3 — no review wording, keywords, star counts, or talking points.
    reason: 'review_steering',
    patterns: [
      /\b5[- ]star/gi,
      /\bfive[- ]star/gi,
      /★/g,
      /\bpositive review/gi,
      /\bglowing\b/gi,
      /\bgreat review/gi,
      /\bmention (the|our|that)\b/gi,
      /\bsay that\b/gi,
      /\btell them (about|how)\b/gi,
      /\bwrite that\b/gi,
      /\binclude .{0,80} in your review/gi,
      /\brate us\b/gi,
    ],
  },
  {
    // §5 row 1 (indirect) — conditional-sentiment openers + the private-escape half.
    reason: 'gating_funnel',
    patterns: [
      /\bif you (loved|enjoyed|liked|were happy|had a (great|good) )/gi,
      /\bif (anything|something) (was|went) wrong[\s\S]{0,60}?(contact|reply|let us know|reach out)/gi,
      /\bbefore you leave a review, /gi,
    ],
  },
  {
    // §5 row 4 — never required or expected.
    reason: 'pressure',
    patterns: [
      /\brequired\b/gi,
      /\byou must\b/gi,
      /\bwe need you to\b/gi,
      /\bbefore you can\b/gi,
      // ['’] accepts the typographic apostrophe U+2019 — LLM copy routinely
      // emits curly quotes, and a straight-only pattern is a trivial evasion.
      /\bwon['’]?t be able to\b/gi,
      /\bexpected of\b/gi,
    ],
  },
];

/**
 * Class 5 pattern rules — SUBJECT ONLY, no interpolated-value exemption.
 * Deception patterns (CAN-SPAM req. 2), URLs, and the email-shaped PII check.
 * No `g` flags — `.test()` must stay stateless.
 */
const SUBJECT_PATTERN_RULES: readonly RegExp[] = [
  /^\s*(re|fwd?|fw)\s*:/i,
  /\baction required\b/i,
  /\burgent\b/i,
  /\baccount (suspended|closed)\b/i,
  /\byou (won|have won)\b/i,
  /\bfinal notice\b/i,
  /https?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+\.(?:com|net|org|io|co|us|info|biz|app|dev)\b/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
];

// Class 5 numeric bounds (B5). Each is used by BOTH the check in
// `deceptiveSubject` and its golden-filed rule name below, so changing a
// bound forces a visible golden diff — the name can never drift from the
// behavior it describes. The digit-run bound lives with the shared
// phone-shaped-PII block above (note admissibility enforces the same fact).
const MAX_SUBJECT_CODE_POINTS = 80;
const MAX_SUBJECT_EXCLAMATION_MARKS = 1;
const MAX_SUBJECT_EMOJI = 1;

/**
 * Class 5 structural bounds (B5): names only — the behavior lives in
 * `deceptiveSubject` below; the golden file pins these names so a structural
 * change is still a visible diff.
 */
const SUBJECT_STRUCTURAL_RULES: readonly string[] = [
  'non_empty',
  `max_${MAX_SUBJECT_CODE_POINTS}_code_points`,
  `max_${MAX_SUBJECT_EXCLAMATION_MARKS}_exclamation_mark`,
  'not_all_caps',
  `max_${MAX_SUBJECT_EMOJI}_emoji`,
  `no_digit_run_of_${PII_DIGIT_RUN_LENGTH}_plus_ignoring_phone_separators`,
  'no_disallowed_interpolated_value_in_subject',
  'no_note_derived_content_token_in_subject',
];

/**
 * Tokens that cannot, alone, leak note content into a subject line: English
 * function words plus the handful of scaffolding words ubiquitous in ask copy
 * ("How was your visit to …?"). Everything else that a disallowed value
 * contributes is a CONTENT token and bans itself from the subject — the
 * fail-closed side of the fragment-level check (a withheld render is the
 * recoverable outcome; a leaked medical fragment is not). Golden-filed so
 * tuning is a visible diff.
 */
const SUBJECT_NOTE_TOKEN_ALLOWLIST: readonly string[] = [
  // Articles, determiners, quantifiers.
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'any', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
  // Conjunctions and connectives.
  'and', 'or', 'but', 'if', 'so', 'as', 'than', 'then', 'too', 'also', 'not',
  'no', 'nor',
  // Prepositions.
  'at', 'by', 'for', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out',
  'over', 'to', 'up', 'with', 'about', 'after', 'before', 'during', 'since',
  'until', 'again', 'once', 'here', 'there',
  // Question words.
  'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom',
  // Pronouns.
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'yours', 'he', 'him',
  'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their', 'theirs',
  // Auxiliaries and copulas.
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'have', 'has', 'had', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must', 'very', 'just',
  // Ask-copy scaffolding: every ask is about a visit, so these leak nothing.
  'visit', 'time', 'day', 'week', 'month', 'year', 'today', 'yesterday',
  'recent', 'recently', 'last', 'next', 'thanks', 'thank', 'question', 'quick',
  'hello', 'hi', 'hey', 'came', 'come', 'stopped', 'stopping', 'went', 'get',
  'got', 'service',
];

/** One emoji = one pictographic ZWJ sequence or one regional-indicator flag pair. */
const EMOJI_PATTERN =
  /\p{Regional_Indicator}\p{Regional_Indicator}|\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

/**
 * Class 6 (§2.4): the closed scaffolding allowlist — greetings/sign-offs,
 * weekday and month words, the pronoun "I" family, and the fixed template
 * scaffolding tokens from ask-render's CTA line and footer. The spec names
 * these categories without enumerating tokens; this table is the enumeration
 * (golden-filed). Entries are lowercase with curly apostrophes normalized.
 */
const PROVENANCE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Greetings and sign-offs.
  'hi',
  'hello',
  'hey',
  'dear',
  'thanks',
  'thank',
  'cheers',
  'best',
  'regards',
  'warmly',
  'sincerely',
  // The pronoun "I" family — capitalized mid-sentence by English grammar.
  'i',
  "i'm",
  "i'd",
  "i'll",
  "i've",
  // Weekdays.
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  // Months.
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  // Fixed template scaffolding (ask-render CTA + footer bytes).
  'repworth',
  'sent',
  'unsubscribe',
  'leave',
]);

/**
 * Class 6 pattern arm (codex round-3 finding 4): the capitalized-token /
 * digit-run provenance heuristic cannot see LOWERCASE invented facts ("we
 * have proudly served the neighborhood for years"). These are the
 * deterministic shapes of self-asserted history/reputation claims a review
 * ask has no business making unless the owner's own inputs carry them —
 * subject to the §2.5 interpolated-value exemption for exactly that reason.
 * Deliberately NOT a semantic verifier: judging arbitrary factual claims is
 * the ask-Judge decision deferred to #631 (intake non-goal); this arm is the
 * strongest enforcement the deterministic lint can honestly give.
 * `g` flags required for matchAll span extraction (CONTENT_CLASSES rules).
 */
const UNVERIFIABLE_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:served?|serving)\b[^.!?\n]{0,40}\b(?:neighborhood|community|area|town|city|families|customers|clients)\b/gi,
  /\bfor (?:many |over |more than )?(?:years|decades|generations)\b/gi,
  /\baward[- ]winning\b/gi,
  /\bfamily[- ](?:owned|run|operated)\b/gi,
  /\blocally[- ]owned\b/gi,
  /\bwoman[- ]owned\b/gi,
  /\bveteran[- ]owned\b/gi,
  /\bvoted (?:best|#?\s?1|number one)\b/gi,
  /\b(?:best|top|highest)[- ]rated\b/gi,
  /\btrusted by\b/gi,
  /\b(?:thousands|hundreds|millions) of\b/gi,
  /\blongest[- ](?:running|serving|standing)\b/gi,
  /\bproudly (?:serv|support)/gi,
];

/**
 * The assembly-produced footer anchor. Everything from its LAST occurrence
 * onward is mechanical scaffolding plus the owner-attested postal address —
 * validated data, not model output — so class 6 excludes it: the address's
 * digit runs and capitalized street/city tokens are not §1.1 interpolation
 * values and would otherwise block every render. lastIndexOf means a model
 * that emits the anchor itself only moves more of its own text INTO the
 * checked region, never out of it.
 */
const FOOTER_ANCHOR = `\n\n${FOOTER_SEPARATOR}\n\n${SENDER_IDENTIFICATION_PREFIX}`;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** [start, end) spans of every case-insensitive interpolated-value occurrence. */
function interpolatedValueSpans(
  text: string,
  values: readonly string[],
): ReadonlyArray<readonly [number, number]> {
  // Known limitation: span offsets are computed against `text.toLowerCase()`,
  // and a length-CHANGING case fold (e.g. U+0130 İ → "i" + combining dot)
  // shifts every subsequent offset relative to the original text, so an
  // exemption span could misalign. Acceptable for US-SMB inputs (ASCII-ish
  // names and notes); revisit with a fold-aware mapping if i18n lands.
  const lowerText = text.toLowerCase();
  const spans: Array<readonly [number, number]> = [];
  for (const value of values) {
    const needle = value.trim().toLowerCase();
    if (needle.length === 0) continue;
    let searchFrom = 0;
    for (;;) {
      const at = lowerText.indexOf(needle, searchFrom);
      if (at === -1) break;
      spans.push([at, at + needle.length] as const);
      searchFrom = at + 1;
    }
  }
  return spans;
}

/** §2.5: a match is exempt only when it falls ENTIRELY inside a value occurrence. */
function hasNonExemptMatch(
  text: string,
  patterns: readonly RegExp[],
  exemptSpans: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const exempt = exemptSpans.some(([spanStart, spanEnd]) => start >= spanStart && end <= spanEnd);
      if (!exempt) return true;
    }
  }
  return false;
}

function countEmoji(text: string): number {
  return [...text.matchAll(EMOJI_PATTERN)].length;
}

function deceptiveSubject(input: AskLintInput): boolean {
  const subject = input.subject;
  if (subject.trim().length === 0) return true;
  if ([...subject].length > MAX_SUBJECT_CODE_POINTS) return true;
  if ((subject.match(/!/g) ?? []).length > MAX_SUBJECT_EXCLAMATION_MARKS) return true;
  // ALL-CAPS per B5's wording: has uppercase letters and no lowercase anywhere.
  if (/\p{Lu}/u.test(subject) && !/\p{Ll}/u.test(subject)) return true;
  if (countEmoji(subject) > MAX_SUBJECT_EMOJI) return true;
  if (SUBJECT_PATTERN_RULES.some((pattern) => pattern.test(subject))) return true;
  // Phone-shaped PII: a digit run of ≥PII_DIGIT_RUN_LENGTH once phone
  // separators are stripped.
  if (PII_DIGIT_RUN_PATTERN.test(stripPhoneSeparators(subject))) return true;

  // Whole-value containment: catches a disallowed value made entirely of
  // allowlisted tokens, which the fragment check below cannot see.
  const lowerSubject = subject.toLowerCase();
  const wholeValueHit = input.subjectDisallowedValues.some((value) => {
    const needle = value.trim().toLowerCase();
    return needle.length > 0 && lowerSubject.includes(needle);
  });
  if (wholeValueHit) return true;

  return subjectCarriesDisallowedFragment(input);
}

function normalizeToken(token: string): string {
  return token.replace(/’/g, "'").toLowerCase();
}

/** Shared token shape for classes 5 and 6: word (apostrophes/hyphens kept) or digit run. */
const TOKEN_PATTERN = /[A-Za-z][A-Za-z'’-]*|\d+/g;

/**
 * Comparison form for the fragment check: normalized, possessive `'s`
 * stripped, and a single trailing plural `s` folded (length ≥ 4 only, so
 * "was"/"his" survive) — "treatments" in a subject must not slip past a note
 * that said "treatment".
 */
function foldToken(token: string): string {
  const normalized = normalizeToken(token).replace(/'s$/, '');
  return normalized.length >= 4 && normalized.endsWith('s')
    ? normalized.slice(0, -1)
    : normalized;
}

function foldedTokensOf(text: string): string[] {
  return [...text.matchAll(TOKEN_PATTERN)].map((match) => foldToken(match[0]));
}

const FOLDED_SUBJECT_NOTE_TOKEN_ALLOWLIST: ReadonlySet<string> = new Set(
  SUBJECT_NOTE_TOKEN_ALLOWLIST.map(foldToken),
);

/**
 * Fragment-level side of the B5 subject rule: a subject is blocked when it
 * carries ANY content token of a disallowed value — not merely the value as
 * one contiguous substring. "Discussed HIV treatment" admitted as a note must
 * ban "HIV" and "treatment" from the subject individually; the class 6
 * provenance corpus deliberately admits note tokens (they ARE verifiable), so
 * without this check the note would launder its own fragments into the
 * subject. Tokens are exempt only when they are closed-set function/
 * scaffolding words or also appear in a subject-SAFE interpolation value
 * (first name, business name, bucket, vertical) — the same
 * admitted-via-a-safe-channel logic as §2.5.
 */
function subjectCarriesDisallowedFragment(input: AskLintInput): boolean {
  if (input.subjectDisallowedValues.length === 0) return false;

  const disallowedValues = new Set(input.subjectDisallowedValues);
  const subjectSafeTokens = new Set(
    input.interpolationValues
      .filter((value) => !disallowedValues.has(value))
      .flatMap(foldedTokensOf),
  );
  const disallowedTokens = new Set(
    input.subjectDisallowedValues
      .flatMap(foldedTokensOf)
      .filter(
        (token) =>
          !FOLDED_SUBJECT_NOTE_TOKEN_ALLOWLIST.has(token) && !subjectSafeTokens.has(token),
      ),
  );
  if (disallowedTokens.size === 0) return false;

  return foldedTokensOf(input.subject).some((token) => disallowedTokens.has(token));
}

/**
 * True when the character run before `index` says the token opens a sentence:
 * start of text/line, or a sentence terminator (`.`, `!`, `?`, `:`) with only
 * whitespace and opening quotes/brackets in between.
 */
function isSentenceInitial(text: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = text[cursor]!;
    if (char === '\n') return true;
    if (char === ' ' || char === '\t' || char === '"' || char === '“' || char === '‘' || char === '(') {
      continue;
    }
    return char === '.' || char === '!' || char === '?' || char === ':';
  }
  return true;
}

/**
 * §2.4 provenance: every capitalized non-sentence-initial token and every
 * digit run must appear in an interpolated value or the closed allowlist.
 */
function hasUnverifiableFact(text: string, values: readonly string[]): boolean {
  const normalizedValues = values.map((value) => normalizeToken(value));
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (/^\d/.test(token)) {
      if (!normalizedValues.some((value) => value.includes(token))) return true;
      continue;
    }
    if (!/^[A-Z]/.test(token)) continue;
    if (isSentenceInitial(text, match.index)) continue;
    const normalized = normalizeToken(token);
    if (PROVENANCE_ALLOWLIST.has(normalized)) continue;
    if (!normalizedValues.some((value) => value.includes(normalized))) return true;
  }
  return false;
}

/** Class 7 required elements, asserted against ask-render's own bytes. */
const REQUIRED_ELEMENT_RULES: readonly string[] = [
  'review_link_placeholder_exactly_once',
  'unsubscribe_placeholder_exactly_once',
  'postal_address_block_between_identification_and_unsubscribe_lines',
];

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Class 7 (§5 row 6): both placeholders EXACTLY once (a duplicate — e.g. the
 * LLM body emitting a placeholder itself — would make #630's dispatch-time
 * substitution ambiguous, so it fails the render), plus the postal-address
 * block: at least one non-blank line strictly between the identification line
 * and the unsubscribe line of the assembled footer.
 */
function missingRequiredElement(body: string): boolean {
  if (countOccurrences(body, REVIEW_LINK_PLACEHOLDER) !== 1) return true;
  if (countOccurrences(body, UNSUBSCRIBE_URL_PLACEHOLDER) !== 1) return true;

  const anchorIndex = body.lastIndexOf(FOOTER_ANCHOR);
  if (anchorIndex === -1) return true;
  const footerLines = body.slice(anchorIndex + FOOTER_ANCHOR.length).split('\n');
  const unsubscribeLineIndex = footerLines.findIndex(
    (line, index) => index >= 1 && line.startsWith(UNSUBSCRIBE_LINE_PREFIX),
  );
  if (unsubscribeLineIndex === -1) return true;
  return !footerLines
    .slice(1, unsubscribeLineIndex)
    .some((line) => line.trim().length > 0);
}

/**
 * Run all seven classes; `blockedReason` is the earliest matching class
 * (first-hit-wins, §2.3) and `matches` records every class that matched.
 */
export function lintAsk(input: AskLintInput): AskLintVerdict {
  const combined = `${input.subject}\n${input.body}`;
  const exemptSpans = interpolatedValueSpans(combined, input.interpolationValues);

  const matches: AskLintClass[] = [];
  for (const contentClass of CONTENT_CLASSES) {
    if (hasNonExemptMatch(combined, contentClass.patterns, exemptSpans)) {
      matches.push(contentClass.reason);
    }
  }

  if (deceptiveSubject(input)) matches.push('deceptive_subject');

  const footerIndex = input.body.lastIndexOf(FOOTER_ANCHOR);
  const modelAuthoredBody = footerIndex === -1 ? input.body : input.body.slice(0, footerIndex);
  const subjectAndModelBody = `${input.subject}\n${modelAuthoredBody}`;
  // `subjectAndModelBody` is a PREFIX of `combined`, so the exemption spans
  // computed above stay positionally valid for the claim-pattern arm.
  if (
    hasUnverifiableFact(subjectAndModelBody, input.interpolationValues) ||
    hasNonExemptMatch(subjectAndModelBody, UNVERIFIABLE_CLAIM_PATTERNS, exemptSpans)
  ) {
    matches.push('unverifiable_fact');
  }

  if (missingRequiredElement(input.body)) matches.push('missing_required_element');

  return { blockedReason: matches[0] ?? null, matches: [...matches] };
}

// ---------------------------------------------------------------------------
// Golden-file serialization — the tuning surface, byte-pinned by
// __tests__/ask-lint-classes.golden.json.
// ---------------------------------------------------------------------------

function serializePatterns(patterns: readonly RegExp[]): string[] {
  return patterns.map((pattern) => pattern.toString());
}

/** JSON-able snapshot of the full rule table; any change here is a version bump. */
export function askLintGoldenTable(): Record<string, unknown> {
  return {
    version: ASK_LINT_VERSION,
    blockReasons: [...ASK_BLOCK_REASONS],
    classes: [
      ...CONTENT_CLASSES.map((contentClass, index) => ({
        class: index + 1,
        reason: contentClass.reason,
        scope: 'subject_and_body',
        interpolatedValueExemption: true,
        patterns: serializePatterns(contentClass.patterns),
      })),
      {
        class: 5,
        reason: 'deceptive_subject',
        scope: 'subject_only',
        interpolatedValueExemption: false,
        patterns: serializePatterns(SUBJECT_PATTERN_RULES),
        structural: [...SUBJECT_STRUCTURAL_RULES],
        subjectNoteTokenAllowlist: [...SUBJECT_NOTE_TOKEN_ALLOWLIST].sort(),
      },
      {
        class: 6,
        reason: 'unverifiable_fact',
        scope: 'subject_and_model_authored_body_excluding_footer',
        interpolatedValueExemption: false,
        structural: [
          'capitalized_non_sentence_initial_tokens_must_appear_in_interpolation_values_or_allowlist',
          'digit_runs_must_appear_in_interpolation_values',
        ],
        claimPatterns: serializePatterns(UNVERIFIABLE_CLAIM_PATTERNS),
        allowlist: [...PROVENANCE_ALLOWLIST].sort(),
      },
      {
        class: 7,
        reason: 'missing_required_element',
        scope: 'body_only',
        interpolatedValueExemption: false,
        structural: [...REQUIRED_ELEMENT_RULES],
      },
    ],
    noteAdmissibility: [
      ...NOTE_ADMISSIBILITY_RULES.map(({ rule, patterns, separatorStrippedPatterns }) => ({
        rule,
        patterns: serializePatterns(patterns),
        ...(separatorStrippedPatterns
          ? { separatorStrippedPatterns: serializePatterns(separatorStrippedPatterns) }
          : {}),
      })),
      { rule: 'length', maxNormalizedLength: MAX_NORMALIZED_NOTE_LENGTH },
    ],
  };
}
