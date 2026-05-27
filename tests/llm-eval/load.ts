// tests/llm-eval/load.ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalRow } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVAL_SET_PATH = resolve(HERE, 'eval-set.jsonl');

/** Parse JSONL eval rows; validates non-empty id and uniqueness. */
export function parseEvalSet(jsonl: string): EvalRow[] {
  const rows: EvalRow[] = [];
  const ids = new Set<string>();

  for (const [index, line] of jsonl.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: EvalRow;
    try {
      parsed = JSON.parse(trimmed) as EvalRow;
    } catch (err) {
      throw new Error(
        `eval-set line ${index + 1} is not valid JSON: ${(err as Error).message}`,
      );
    }

    if (!parsed.id) {
      throw new Error(`eval-set line ${index + 1} is missing "id"`);
    }
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
