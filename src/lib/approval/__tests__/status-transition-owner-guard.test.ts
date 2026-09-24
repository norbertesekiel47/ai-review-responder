// src/lib/approval/__tests__/status-transition-owner-guard.test.ts
//
// Guard for #1454: every `responses.status = 'approved'|'superseded'` WRITE
// (a `SET`, not a `WHERE`/`AND` read guard) must route through
// `src/lib/approval/transitions.ts` — this repo's single owner of that
// column list — or carry a reviewed, justified entry in EXCEPTIONS below. A
// NEW hand-spelled write with no owner call and no exception entry fails
// this test; see EXCEPTIONS for why each currently-listed line stays
// hand-spelled (mirrors transitions.ts's own header, which is the primary
// record of the "why").
//
// Scope: `src/` and `worker/` (the ratchet-harness `walk` default already
// skips `__tests__`/`node_modules`/etc., so this file and its fixtures never
// scan themselves). A line is a WRITE candidate when it matches
// `status = 'approved'` or `status = 'superseded'` and is NOT itself a
// `WHERE`/`AND status = ...` READ guard — e.g. `AND status = 'approved'` in
// veto.ts / veto-window-gate.ts, `AND status = 'superseded'` in
// restore-original/route.ts / load-replies.ts are never flagged.
//
// `past-replies/publish/route.ts`'s
// `status = CASE WHEN edited_text IS NOT NULL THEN 'edited' ELSE 'approved' END`
// is the dynamic-CASE exception named in #1454 — it needs no EXCEPTIONS
// entry because the literal never sits directly after `status =`, so the
// regex below naturally never flags it. If a future edit makes it match
// (e.g. the CASE is simplified away), route it through transitions.ts or
// add a reasoned entry here — don't let it pass by accident.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { evaluateAgainstBaseline, normalize, walk } from '../../../../scripts/ci/lib/ratchet-harness';
import { isSqlTaggedTemplate } from '../../../../scripts/ci/lib/sql-tag-scan';

// A full src/+worker/ walk + per-file TS parse (~1000+ files) comfortably
// clears the default 5s test timeout in isolation, but not under
// scripts/verify-gate.sh's full parallel `vitest run` fan-out — same
// rationale as eslint-boundaries.test.ts's cold-start bump.
vi.setConfig({ testTimeout: 30_000 });

/** The single owner this guard is enforcing — never scanned for its own findings. */
const OWNER_FILE = 'src/lib/approval/transitions.ts';

/**
 * file:line -> justification. Every entry here MUST still be a live finding
 * (checked below via `onStale`) — a stale entry (line moved, code deleted,
 * or actually migrated to the owner) fails loudly instead of silently
 * rotting into a dead allowlist.
 */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'worker/jobs/publisher/edit-publish-tx.ts:23',
    "supersedeSibling — the local, multi-caller owner of the guarded-supersede-or-throw " +
      "shape for the edit-publisher DELETE-before-POST flow; it doesn't carry businessId in " +
      'its signature at all (operates on a sibling id under the caller\'s already-established ' +
      'location scope), so routing it through the ResponseTarget-shaped owner would mean ' +
      'reshaping the signature across its several callers for a non-safety-relevant dedup. ' +
      'See transitions.ts header.',
  ],
  [
    'worker/jobs/publisher/edit-publish-errors.ts:155',
    'the mismatch-after-DELETE branch — deliberately NOT routed through this same file\'s ' +
      'own local markCandidateOrThrow helper (its comment: routing it through the shared ' +
      'helper would change the emitted SQL\'s indentation, byte-pinned from a prior fallow ' +
      'complexity dedup); a fortiori not routed through a cross-module owner for the same ' +
      'byte-sensitivity reason.',
  ],
  [
    'worker/jobs/publisher/edit-publish-errors.ts:181',
    'markCandidateOrThrow(setBody: postgres.Fragment) — the dynamic SET-clause composition ' +
      "#1454 explicitly carves out; markCandidateOrThrow is itself the shared, multi-caller " +
      "owner of the guarded-UPDATE-or-throw shape for this flow (also composed with a " +
      "'failed' SET body elsewhere in this file), so it is already the right local owner.",
  ],
  [
    'worker/jobs/zernio/zernio-ingest-shared.ts:406',
    'a bulk `WHERE id = ANY(uuid[])` UPDATE over many response rows from one ' +
      'review-reconciliation pass, with a bulk `RETURNING id` used for a count log — a ' +
      'set-based statement shape with no single businessId, fundamentally different from the ' +
      'per-row ResponseTarget contract every transitions.ts function assumes.',
  ],
]);

// A write candidate: `status = 'approved'` / `status = 'superseded'` not
// immediately preceded (same line) by `AND`/`WHERE` — those are read guards.
const WRITE_RE = /status\s*=\s*'(approved|superseded)'/;
const READ_GUARD_TAIL_RE = /\b(?:AND|WHERE)\s*$/i;

function isWriteLine(line: string): boolean {
  const match = WRITE_RE.exec(line);
  if (!match) return false;
  const before = line.slice(0, match.index);
  return !READ_GUARD_TAIL_RE.test(before);
}

/**
 * Scoped to `sql`/`tx`/`db`/`exec`-tagged template literals (the same
 * SQL_TAG_NAMES precondition response-status-audit.ts and friends rely on) so
 * a plain prose comment or doc-string that happens to mention
 * `status='approved'` (several exist: restore-original/route.ts,
 * draft/[responseId]/route.ts, on-demand-generate.ts) is never mistaken for a
 * write, and an INSERT's `status` column name is never mistaken for a SET.
 */
function findWritesInFile(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTaggedTemplate(node)) {
      const raw = node.getText(source);
      const nodeStart = node.getStart(source);
      const nodeStartLine = source.getLineAndCharacterOfPosition(nodeStart).line;
      raw.split('\n').forEach((line, offset) => {
        if (isWriteLine(line)) found.push(`${file}:${nodeStartLine + offset + 1}`);
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // De-dup: a template spanning a multi-statement fragment could in theory
  // report the same line twice if nested tagged templates overlap it; that
  // never happens in this codebase's SQL, but Set() makes it harmless either way.
  return [...new Set(found)];
}

async function scanForWrites(): Promise<Set<string>> {
  const root = process.cwd();
  const files = await walk(root, { scanDirs: ['src', 'worker'] });
  const found = new Set<string>();
  for (const file of files.sort()) {
    const normalized = normalize(file);
    if (normalized === OWNER_FILE) continue;
    const text = await readFile(resolve(root, file), 'utf8');
    for (const hit of findWritesInFile(normalized, text)) found.add(hit);
  }
  return found;
}

describe('responses.status approve/supersede write ownership (#1454)', () => {
  it('every hand-spelled write routes through transitions.ts or carries a live, justified exception', async () => {
    const found = await scanForWrites();
    const findings = evaluateAgainstBaseline(found, {
      baseline: new Set(EXCEPTIONS.keys()),
      skip: () => false,
      onNew: (file) =>
        `${file}: new hand-spelled responses.status write outside transitions.ts — route it ` +
        'through src/lib/approval/transitions.ts (add a sibling function if none fits), or ' +
        'add a justified entry to EXCEPTIONS in this test file.',
      onStale: (file) =>
        `${file}: stale EXCEPTIONS entry — the write it named is gone (migrated, deleted, or ' +
        'moved lines). Remove or update the entry.`,
    });
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('every EXCEPTIONS entry carries a non-empty justification', () => {
    for (const [key, reason] of EXCEPTIONS) {
      expect(reason.trim().length, `empty justification for ${key}`).toBeGreaterThan(0);
    }
  });
});
