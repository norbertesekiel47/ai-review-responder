// Deterministic register-trait derivation for the Voice Report Card
// (/settings/voice). Pure function over the SAME VoiceExample pairs the
// prompt path few-shots from — the card never claims a pattern the prompt
// isn't using (intake invariant, ticket #540).
//
// Detection bar: a trait renders only when its pattern holds in a strict
// majority of applicable pairs AND >=2 pairs conform. Critical reviews is
// exempted (applicable set = negative pairs, star <=2 per classifySentiment,
// usually size 0-1): it detects at >=1 meaningful negative pair, with claim
// text scoped to its single evidence pair when only one exists.
// Pairs whose edit is identical to the draft are never conforming.

import { classifySentiment } from '@/lib/reviews/sentiment';
import type { VoiceExample } from './types';

export type RegisterTraitKey = 'greeting' | 'length' | 'signoff' | 'point_of_view' | 'critical';

export interface TraitSnippet {
  before: string;
  after: string;
}

export interface RegisterTrait {
  key: RegisterTraitKey;
  name: string;
  claim: string;
  snippet: TraitSnippet;
}

export interface VoiceReportCardData {
  traits: RegisterTrait[];
  /** Most recent pair's evidence; non-null only when examples exist and zero traits detected. */
  fallbackSnippet: TraitSnippet | null;
}

const MIN_CONFORMING_PAIRS = 2;
const SNIPPET_MAX_CHARS = 140;
const LENGTH_CUT_RATIO = 0.75;

const GREETING_RE = /^\s*(hi|hey|hello)\b/i;
const DEAR_RE = /^\s*dear\b/i;
const OWN_LINE_SIGNOFF_RE = /^[—–-]{1,2}\s*(.+)$/;
const TRAILING_SIGNOFF_RE = /[—–]\s*([^—–\n]{1,40})$/;
const FIRST_SINGULAR_RE = /\b(i|i'm|i'll|i've|i'd|my|me|mine)\b/gi;
const FIRST_PLURAL_RE = /\b(we|we're|we'll|we've|we'd|our|us|ours)\b/gi;

function truncate(text: string, max = SNIPPET_MAX_CHARS): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? '';
}

function isMeaningfulEdit(pair: VoiceExample): boolean {
  return pair.originalDraft.trim() !== pair.editedVersion.trim();
}

function clearsBar(conforming: number, applicable: number): boolean {
  return conforming >= MIN_CONFORMING_PAIRS && conforming * 2 > applicable;
}

function mostFrequent(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0] ?? '';
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function deriveGreeting(pairs: VoiceExample[]): RegisterTrait | null {
  const conforming = pairs.filter((p) => isMeaningfulEdit(p) && GREETING_RE.test(p.editedVersion));
  if (!clearsBar(conforming.length, pairs.length)) return null;

  const words = conforming.map((p) => {
    const raw = p.editedVersion.match(GREETING_RE)?.[1] ?? 'hi';
    return raw.toLowerCase();
  });
  const word = mostFrequent(words);
  const cased = word.charAt(0).toUpperCase() + word.slice(1);
  const draftsUsedDear = pairs.some((p) => DEAR_RE.test(p.originalDraft));
  const noEditUsesDear = pairs.every((p) => !DEAR_RE.test(p.editedVersion));
  const claim = draftsUsedDear && noEditUsesDear
    ? `You open with “${cased}” — never “Dear.”`
    : `You open with “${cased}.”`;

  const evidence = conforming.find((p) => p.editedVersion.toLowerCase().trim().startsWith(word)) ?? conforming[0];
  if (!evidence) return null;
  return {
    key: 'greeting',
    name: 'Greeting',
    claim,
    snippet: { before: truncate(firstLine(evidence.originalDraft), 90), after: truncate(firstLine(evidence.editedVersion), 90) },
  };
}

function deriveLength(pairs: VoiceExample[]): RegisterTrait | null {
  const conforming = pairs.filter(
    (p) => isMeaningfulEdit(p) && wordCount(p.editedVersion) <= LENGTH_CUT_RATIO * wordCount(p.originalDraft),
  );
  if (!clearsBar(conforming.length, pairs.length)) return null;

  const average = (values: number[]) => Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
  const avgDraft = average(pairs.map((p) => wordCount(p.originalDraft)));
  const avgEdit = average(pairs.map((p) => wordCount(p.editedVersion)));
  const evidence = conforming[0];
  if (!evidence) return null;
  return {
    key: 'length',
    name: 'Length',
    claim: `You tighten replies: your edits average ${avgEdit} words; drafts average ${avgDraft}.`,
    snippet: {
      before: `${truncate(evidence.originalDraft)} (${wordCount(evidence.originalDraft)} words)`,
      after: `${truncate(evidence.editedVersion)} (${wordCount(evidence.editedVersion)} words)`,
    },
  };
}

function signoffOf(text: string): string | null {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const ownLine = last.match(OWN_LINE_SIGNOFF_RE);
  if (ownLine?.[1]) return ownLine[1].trim();
  const trailing = last.match(TRAILING_SIGNOFF_RE);
  return trailing?.[1]?.trim() ?? null;
}

function deriveSignoff(pairs: VoiceExample[]): RegisterTrait | null {
  const withSignoff = pairs.filter((p) => {
    if (!isMeaningfulEdit(p)) return false;
    const edited = signoffOf(p.editedVersion);
    if (!edited) return false;
    return edited.toLowerCase() !== (signoffOf(p.originalDraft) ?? '').toLowerCase();
  });
  if (withSignoff.length === 0) return null;

  const majority = mostFrequent(withSignoff.map((p) => (signoffOf(p.editedVersion) ?? '').toLowerCase()));
  const conforming = withSignoff.filter((p) => (signoffOf(p.editedVersion) ?? '').toLowerCase() === majority);
  if (!clearsBar(conforming.length, pairs.length)) return null;

  const evidence = conforming[0];
  if (!evidence) return null;
  const display = signoffOf(evidence.editedVersion) ?? majority;
  const draftSignoff = signoffOf(evidence.originalDraft);
  return {
    key: 'signoff',
    name: 'Sign-off',
    claim: `You sign as “— ${display}.”`,
    snippet: {
      before: draftSignoff ? `— ${draftSignoff}` : truncate(evidence.originalDraft, 90),
      after: `— ${display}`,
    },
  };
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function derivePointOfView(pairs: VoiceExample[]): RegisterTrait | null {
  const conforming = pairs.filter((p) => {
    if (!isMeaningfulEdit(p)) return false;
    const editedSingular = countMatches(p.editedVersion, FIRST_SINGULAR_RE) > countMatches(p.editedVersion, FIRST_PLURAL_RE);
    const draftPlural = countMatches(p.originalDraft, FIRST_PLURAL_RE) > countMatches(p.originalDraft, FIRST_SINGULAR_RE);
    return editedSingular && draftPlural;
  });
  if (!clearsBar(conforming.length, pairs.length)) return null;

  const evidence = conforming[0];
  if (!evidence) return null;
  return {
    key: 'point_of_view',
    name: 'Point of view',
    claim: 'You write as “I,” not “we.”',
    snippet: { before: truncate(evidence.originalDraft, 110), after: truncate(evidence.editedVersion, 110) },
  };
}

function deriveCritical(pairs: VoiceExample[]): RegisterTrait | null {
  const negative = pairs.filter((p) => classifySentiment(p.reviewStarRating).label === 'negative');
  const conforming = negative.filter(isMeaningfulEdit);
  if (conforming.length === 0) return null;

  const evidence = conforming[0];
  if (!evidence) return null;
  const draftWords = wordCount(evidence.originalDraft);
  const editWords = wordCount(evidence.editedVersion);
  const generalized = conforming.length >= MIN_CONFORMING_PAIRS && conforming.length * 2 > negative.length;

  let claim: string;
  if (generalized) {
    claim = 'On critical reviews you rewrite the draft in your own words.';
  } else if (editWords < draftWords) {
    claim = `On your ${evidence.reviewStarRating}-star review you cut the draft's ${draftWords} words to ${editWords} of your own.`;
  } else {
    claim = `On your ${evidence.reviewStarRating}-star review you replaced the draft with your own words.`;
  }

  return {
    key: 'critical',
    name: 'Critical reviews',
    claim,
    snippet: { before: truncate(evidence.originalDraft), after: truncate(evidence.editedVersion) },
  };
}

const TRAIT_DERIVERS = [deriveGreeting, deriveLength, deriveSignoff, derivePointOfView, deriveCritical];

export function deriveVoiceReportCard(examples: VoiceExample[]): VoiceReportCardData {
  const [mostRecent] = examples;
  if (!mostRecent) {
    return { traits: [], fallbackSnippet: null };
  }

  const traits = TRAIT_DERIVERS
    .map((derive) => derive(examples))
    .filter((trait): trait is RegisterTrait => trait !== null);
  const fallbackSnippet = traits.length === 0
    ? { before: truncate(mostRecent.originalDraft), after: truncate(mostRecent.editedVersion) }
    : null;

  return { traits, fallbackSnippet };
}
