// tests/llm-eval/load.ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonLines } from './jsonl';
import type { EvalRow } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVAL_SET_PATH = resolve(HERE, 'eval-set.jsonl');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse JSONL eval rows; validates non-empty id and uniqueness. */
export function parseEvalSet(jsonl: string): EvalRow[] {
  const rows: EvalRow[] = [];
  const ids = new Set<string>();

  for (const { lineNumber, value: raw } of parseJsonLines(jsonl, 'eval-set')) {

    if (!isRecord(raw)) {
      throw new Error(`eval-set line ${lineNumber} must be a JSON object`);
    }

    if (typeof raw.id !== 'string' || raw.id.trim() === '') {
      throw new Error(`eval-set line ${lineNumber} id must be a non-empty string`);
    }
    if (typeof raw.candidate !== 'string') {
      throw new Error(`eval-set line ${lineNumber} candidate must be a string`);
    }

    const expectation = raw.expect;
    if (!isRecord(expectation)) {
      throw new Error(`eval-set line ${lineNumber} is missing object "expect"`);
    }
    if (typeof expectation.maxSeverity !== 'string') {
      throw new Error(`eval-set line ${lineNumber} expect.maxSeverity must be a string`);
    }
    if (!Array.isArray(expectation.forbiddenCategories)) {
      throw new Error(
        `eval-set line ${lineNumber} expect.forbiddenCategories must be an array`,
      );
    }

    const parsed = raw as unknown as EvalRow;
    if (ids.has(parsed.id)) {
      throw new Error(`duplicate eval row id "${parsed.id}"`);
    }
    ids.add(parsed.id);
    rows.push(parsed);
  }

  return rows;
}

export function loadEvalSet(path: string = EVAL_SET_PATH): EvalRow[] {
  return parseEvalSet(readFileSync(path, 'utf8'));
}
