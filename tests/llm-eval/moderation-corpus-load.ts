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

/** Parse JSONL corpus rows. Validates shape, uniqueness, and label/bucket agreement. */
export function parseModerationCorpus(jsonl: string): ModerationCorpusRow[] {
  const rows: ModerationCorpusRow[] = [];
  const ids = new Set<string>();

  for (const { lineNumber, value: raw } of parseJsonLines(jsonl, LABEL)) {
    if (!isRecord(raw)) {
      throw new Error(`${LABEL} line ${lineNumber} must be a JSON object`);
    }
    if (typeof raw.id !== 'string' || raw.id.trim() === '') {
      throw new Error(`${LABEL} line ${lineNumber} id must be a non-empty string`);
    }
    if (raw.label !== 'safe' && raw.label !== 'unsafe') {
      throw new Error(`${LABEL} line ${lineNumber} label must be "safe" or "unsafe"`);
    }
    if (!isBucket(raw.bucket)) {
      throw new Error(`${LABEL} line ${lineNumber} bucket is not a known bucket`);
    }
    if (typeof raw.description !== 'string' || raw.description.trim() === '') {
      throw new Error(`${LABEL} line ${lineNumber} description must be a non-empty string`);
    }
    if (typeof raw.text !== 'string' || raw.text.trim() === '') {
      throw new Error(`${LABEL} line ${lineNumber} text must be a non-empty string`);
    }
    if (typeof raw.expectProviderFlag !== 'boolean') {
      throw new Error(`${LABEL} line ${lineNumber} expectProviderFlag must be a boolean`);
    }

    const safeBucket = (SAFE_BUCKETS as readonly string[]).includes(raw.bucket);
    if (raw.label === 'safe' && !safeBucket) {
      throw new Error(`${LABEL} line ${lineNumber} safe row uses unsafe bucket "${raw.bucket}"`);
    }
    if (raw.label === 'unsafe' && safeBucket) {
      throw new Error(`${LABEL} line ${lineNumber} unsafe row uses safe bucket "${raw.bucket}"`);
    }
    if (raw.label === 'safe' && raw.expectProviderFlag) {
      throw new Error(`${LABEL} line ${lineNumber} safe row must not expect a provider flag`);
    }

    const parsed = raw as unknown as ModerationCorpusRow;
    if (ids.has(parsed.id)) {
      throw new Error(`duplicate ${LABEL} row id "${parsed.id}"`);
    }
    ids.add(parsed.id);
    rows.push(parsed);
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
