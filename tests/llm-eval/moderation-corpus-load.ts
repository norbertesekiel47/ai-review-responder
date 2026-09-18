// tests/llm-eval/moderation-corpus-load.ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonLines } from './jsonl';
import {
  SAFE_BUCKETS,
  UNSAFE_BUCKETS,
  type ModerationBucket,
  type ModerationCorpusRow,
} from './moderation-types';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MODERATION_CORPUS_PATH = resolve(HERE, 'moderation-corpus.jsonl');

const LABEL = 'moderation-corpus';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBucket(value: unknown): value is ModerationBucket {
  return (
    typeof value === 'string' &&
    (SAFE_BUCKETS as readonly string[]).concat(UNSAFE_BUCKETS as readonly string[]).includes(value)
  );
}

type FieldCheck = readonly [
  ok: (raw: Record<string, unknown>) => boolean,
  detail: string,
];

/** One row's field contract. Table-driven so the parser stays a loop. */
const FIELD_CHECKS: readonly FieldCheck[] = [
  [(raw) => typeof raw.id === 'string' && raw.id.trim() !== '', 'id must be a non-empty string'],
  [(raw) => raw.label === 'safe' || raw.label === 'unsafe', 'label must be "safe" or "unsafe"'],
  [(raw) => isBucket(raw.bucket), 'bucket is not a known bucket'],
  [
    (raw) => typeof raw.description === 'string' && raw.description.trim() !== '',
    'description must be a non-empty string',
  ],
  [
    (raw) => typeof raw.text === 'string' && raw.text.trim() !== '',
    'text must be a non-empty string',
  ],
  [(raw) => typeof raw.expectProviderFlag === 'boolean', 'expectProviderFlag must be a boolean'],
];

/**
 * A label and its bucket must agree, and only an unsafe row may target the
 * provider. Checked after FIELD_CHECKS, so both fields are known-valid here.
 */
function agreementDetail(raw: Record<string, unknown>): string | null {
  const safeBucket = (SAFE_BUCKETS as readonly string[]).includes(raw.bucket as string);
  if (raw.label === 'safe' && !safeBucket) {
    return `safe row uses unsafe bucket "${String(raw.bucket)}"`;
  }
  if (raw.label === 'unsafe' && safeBucket) {
    return `unsafe row uses safe bucket "${String(raw.bucket)}"`;
  }
  if (raw.label === 'safe' && raw.expectProviderFlag === true) {
    return 'safe row must not expect a provider flag';
  }
  return null;
}

/** Validate one parsed line. Throws with the source line number on the first breach. */
function validateRow(raw: unknown, lineNumber: number): ModerationCorpusRow {
  if (!isRecord(raw)) {
    throw new Error(`${LABEL} line ${lineNumber} must be a JSON object`);
  }
  for (const [ok, detail] of FIELD_CHECKS) {
    if (!ok(raw)) throw new Error(`${LABEL} line ${lineNumber} ${detail}`);
  }
  const disagreement = agreementDetail(raw);
  if (disagreement) throw new Error(`${LABEL} line ${lineNumber} ${disagreement}`);
  return raw as unknown as ModerationCorpusRow;
}

/** Parse JSONL corpus rows. Validates shape, uniqueness, and label/bucket agreement. */
export function parseModerationCorpus(jsonl: string): ModerationCorpusRow[] {
  const rows: ModerationCorpusRow[] = [];
  const ids = new Set<string>();

  for (const { lineNumber, value: raw } of parseJsonLines(jsonl, LABEL)) {
    const row = validateRow(raw, lineNumber);
    if (ids.has(row.id)) {
      throw new Error(`duplicate ${LABEL} row id "${row.id}"`);
    }
    ids.add(row.id);
    rows.push(row);
  }

  if (rows.length === 0) {
    throw new Error(`${LABEL} is empty`);
  }
  return rows;
}

export function loadModerationCorpus(
  path: string = MODERATION_CORPUS_PATH,
): ModerationCorpusRow[] {
  return parseModerationCorpus(readFileSync(path, 'utf8'));
}

/**
 * The safety-mode corpus, in a file of its OWN.
 *
 * These two rows may NOT live in `moderation-corpus.jsonl`. That file is read
 * wholesale by `loadModerationCorpus` above and its length is printed as the
 * report's `total`, so adding rows would make the ordinary command score 55
 * against the 53 the 2026-09-17 evidence records — silently invalidating the
 * evidence this feature exists to supersede, in the same tracer that promises
 * the default mode stays byte-identical. (plan round-2 finding NEW A)
 */
export const SAFETY_CORPUS_PATH = resolve(HERE, 'moderation-corpus-safety.jsonl');

export function loadSafetyCorpus(path: string = SAFETY_CORPUS_PATH): ModerationCorpusRow[] {
  return parseModerationCorpus(readFileSync(path, 'utf8'));
}

/**
 * The ONLY rows whose provider requirement a safety-only catch may satisfy.
 *
 * A NAMED SET, not a predicate. "The provider missed it and the safety pass
 * caught it" is true of EVERY provider-targeted row, so writing the rescue that
 * way would silently absorb a future provider regression on an unrelated row
 * and quietly delete the protection `expectProviderFlag` exists to give.
 * (plan round-2 finding 9)
 *
 * These two are the G4-F1 rows: the recorded run proved
 * `omni-moderation-latest` returns `providerStatus: "clean"` on both. Adding an
 * id here REMOVES that row's provider protection — do it with evidence, never
 * to make a run pass.
 */
export const SAFETY_MODE_RESCUABLE: ReadonlySet<string> = new Set([
  'unsafe-threat-02',
  'unsafe-sexual-01',
]);
