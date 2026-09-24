import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1373 regression guard: no API route may embed a Zod `SafeParseError`'s raw
 * issues (field paths, messages, enum members — internal schema shape) in a
 * JSON response body. Every route must go through
 * `invalidBodyResponse()` (src/lib/shared/invalid-body-response.ts) instead,
 * which deliberately discards that data.
 *
 * A guard TEST rather than a `ci:*` script — same reason as
 * reference-shape.test.ts / claude-md-shape.test.ts: removing it is a
 * visible deletion (fails `pnpm test`), not a silently unwired audit.
 *
 * Two literal patterns, not a general "never call `.issues`" ban — several
 * routes legitimately read `parsed.error.issues[0]?.message` to build a
 * single-string `error` code (never the raw array) and that's out of this
 * issue's scope:
 *
 *   1. `issues: <expr>.error.issues` — the exact shape the 13 routes in
 *      #1373 used to return (an `issues` KEY assigned the whole array).
 *   2. `.error.flatten()` — the second dialect four routes used
 *      (`details: parsed.error.flatten()` / `.flatten().fieldErrors`).
 *
 * Both were verified against every route before the #1373 migration: they
 * matched exactly the 17 offending lines and nothing else (no false
 * positives against the `.issues[0]?.message` pattern, which has no `issues:`
 * key at all).
 */
const RAW_ISSUES_KEY = /\bissues\s*:\s*[\w.]*\.error\.issues\b/;
const FLATTEN_CALL = /\.error\.flatten\(\)/;

const ROOT = resolve(process.cwd());
const SKIP_DIRS = new Set(['node_modules', '__tests__', '.next', 'coverage']);

/** Every `.ts`/`.tsx` file under `dir` (repo-relative, forward-slashed), skipping test dirs. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...tsFiles(`${dir}/${entry.name}`));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name)) {
      out.push(`${dir}/${entry.name}`);
    }
  }
  return out;
}

describe('no raw Zod issues/flatten() in an API response body (#1373)', () => {
  it('src/app/api has no route embedding parsed.error.issues or parsed.error.flatten()', () => {
    const files = tsFiles('src/app/api');
    // Guards against a vacuously green assertion if the walk ever scans zero
    // files (renamed root, empty skip-dir mistake, etc.).
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];

    for (const file of files) {
      const content = readFileSync(join(ROOT, file), 'utf8');
      if (RAW_ISSUES_KEY.test(content)) {
        offenders.push(`${file}: raw \`issues: <expr>.error.issues\` — use invalidBodyResponse(parsed.error) instead`);
      }
      if (FLATTEN_CALL.test(content)) {
        offenders.push(`${file}: raw \`.error.flatten()\` — use invalidBodyResponse(parsed.error) instead`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // The guard's own patterns must actually fire — proves the regexes aren't
  // silently defeated by formatting (e.g. a wrapped `issues:` line), and that
  // the safe `.issues[0]?.message` idiom used elsewhere in the repo is not a
  // false positive.
  it('the guard patterns match the exact anti-patterns they exist to catch', () => {
    expect(RAW_ISSUES_KEY.test("{ error: 'invalid_body', issues: parsed.error.issues }")).toBe(true);
    expect(RAW_ISSUES_KEY.test('{ error: "invalid_body", issues: authBody.error.issues }')).toBe(true);
    expect(RAW_ISSUES_KEY.test('issues:\n      parsed.error.issues,')).toBe(true);
    expect(FLATTEN_CALL.test("{ error: 'invalid_body', details: parsed.error.flatten() }")).toBe(true);
    expect(FLATTEN_CALL.test("{ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }")).toBe(true);
  });

  it('does not flag the sanctioned single-message idiom (no raw array, no `issues:` key)', () => {
    expect(RAW_ISSUES_KEY.test("{ error: parsed.error.issues[0]?.message ?? 'Invalid input' }")).toBe(false);
    expect(FLATTEN_CALL.test("{ error: parsed.error.issues[0]?.message ?? 'Invalid input' }")).toBe(false);
  });
});
