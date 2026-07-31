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
export const ASK_LINT_VERSION = 'ask_lint_2026-07-30.1';

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

// ---------------------------------------------------------------------------
// Note admissibility (§1.2) — the single largest untrusted-input surface.
// Inadmissible ⇒ the note is OMITTED and generation proceeds on the four
// structured fields: a degradation, never a withhold and never a block.
// ---------------------------------------------------------------------------

export type NoteDisposition = 'admitted' | 'absent' | `rejected:${string}`;

type NoteRejectionRule = 'sentiment_token' | 'contact_channel' | 'imperative_to_model';

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
      /\d{7,}/,
    ],
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
  for (const { rule, patterns } of NOTE_ADMISSIBILITY_RULES) {
    if (patterns.some((pattern) => pattern.test(normalized))) {
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
   * by construction).
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
      /\bcomp(ed|ing)\b/gi,
      /\braffles?\b/gi,
      /\bgiveaways?\b/gi,
      /\bentry\b/gi,
      /\bentered to win\b/gi,
      /\bpoints\b/gi,
      /\brewards?\b/gi,
      /\d+\s*%\s*off/gi,
      /\$\s*\d+\s*off/gi,
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
// behavior it describes.
const MAX_SUBJECT_CODE_POINTS = 80;
const MAX_SUBJECT_EXCLAMATION_MARKS = 1;
const MAX_SUBJECT_EMOJI = 1;
const PII_DIGIT_RUN_LENGTH = 7;
const PII_DIGIT_RUN_PATTERN = new RegExp(`\\d{${PII_DIGIT_RUN_LENGTH},}`);

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
  if (PII_DIGIT_RUN_PATTERN.test(subject.replace(/[\s().-]/g, ''))) return true;

  const lowerSubject = subject.toLowerCase();
  return input.subjectDisallowedValues.some((value) => {
    const needle = value.trim().toLowerCase();
    return needle.length > 0 && lowerSubject.includes(needle);
  });
}

function normalizeToken(token: string): string {
  return token.replace(/’/g, "'").toLowerCase();
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
  const tokenPattern = /[A-Za-z][A-Za-z'’-]*|\d+/g;
  for (const match of text.matchAll(tokenPattern)) {
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
  if (hasUnverifiableFact(`${input.subject}\n${modelAuthoredBody}`, input.interpolationValues)) {
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
      ...NOTE_ADMISSIBILITY_RULES.map(({ rule, patterns }) => ({
        rule,
        patterns: serializePatterns(patterns),
      })),
      { rule: 'length', maxNormalizedLength: MAX_NORMALIZED_NOTE_LENGTH },
    ],
  };
}
