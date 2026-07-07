// scripts/ci/reviews-status-audit.ts
//
// Strict guard for reviews.status literals — the reviews-table sibling of
// response-status-audit.ts. src/lib/reviews/status.ts is the single owner of
// the reviews.status vocabulary (REVIEW_STATUS); this guard FAILS on ANY
// reviews-table SQL that compares status to a raw quoted literal instead of
// importing from there. There is no baseline: every offending file is a
// failure, and the only escape is the per-line `review-status-ignore` pragma
// for an intentionally-inline state-transition write guard. (Stage-2 adopted
// the constant across the last two baselined files in sweep 2f-D and removed
// the ratchet — the guard is now absolute.)
//
// Detection technique is borrowed from response-status-audit.ts: walk the
// AST for tagged templates whose tag identifier is `sql`, `tx`, or `db` —
// including the `sql<Type[]>` typed-tagged-template form (shared tag set +
// helper: scripts/ci/lib/sql-tag-scan.ts) — then pattern-match the
// template's raw text.
//
// SCOPE: src/lib + src/app + worker (broader than response-status-audit's
// `src/` and explicitly INCLUDES worker/**, unlike response-status-audit
// which deferred worker to a later stage). reviews.status is written from a
// worker poller TODAY — ZernioRecentReviewPoller.ts soft-deletes a review by
// writing status = 'deleted' — so excluding worker would leave the
// highest-risk write path (the soft-delete transition) unguarded. src/app is
// included because API routes can carry inline SQL too (none currently touch
// reviews.status, but nothing structurally prevents it); src/components is
// excluded — UI code has no SQL.
//
// A template COUNTS when its raw text mentions `reviews` (a table-mention
// scoping heuristic — keeps generic words like 'new'/'failed' from
// false-firing on other tables' predicates, e.g. channel_enrollments.status)
// AND contains a status comparison to a quoted literal from the
// REVIEW_STATUS vocabulary. EVERY status-predicate match in a template is
// walked with its own qualifier + pragma check (mirroring the
// outbox-topics-audit's every-occurrence walk) — a pragma on the first
// predicate must not fail-open the rest of the template.
//
// Column attribution: a match qualified by an alias that is NOT a reviews
// alias (e.g. `resp.status = 'pending_approval'` in a query that also
// `JOIN reviews r`) is SKIPPED — it is another table's status column riding
// along in a reviews JOIN, not a reviews.status literal (see
// REVIEWS_ALIAS_ALLOWLIST below). Known remaining boundary: the operand scan
// between the `status` token and its quoted literal is lazy across lines, so
// a parameterized predicate followed by a later literal can still attribute
// coarsely — full SQL parsing is disproportionate complexity for a
// maintainability guard; new entries route through review at PR time.
//
// Per-LINE escape pragma: `-- review-status-ignore` (SQL, trailing comment)
// or `// review-status-ignore` (TS, same or preceding line) exempts that
// match — for state-transition write guards and one-off subsets that must
// stay inline, mirroring response-status-audit's `status-audit-ignore`.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { REVIEW_STATUS } from '../../src/lib/reviews/status';
import { escapeRegExp, isSqlTaggedTemplate, lineHasPragma } from './lib/sql-tag-scan';
import { walk } from './lib/ratchet-harness';

const SCAN_DIRS = ['src/lib', 'src/app', 'worker'] as const;
const IGNORE_PRAGMA = 'review-status-ignore';

// Group 1 captures the optional `<qualifier>.` prefix so each match can be
// attributed to (or excluded from) the reviews table — see
// REVIEWS_ALIAS_ALLOWLIST. Global flag: every occurrence is walked, each with
// its own qualifier + pragma check.
const STATUS_PREDICATE_RE = new RegExp(
  `(?:\\b(\\w+)\\.)?\\bstatus\\b\\s*(?:=|<>|!=|\\bIN\\b|\\bNOT\\s+IN\\b)[^\`]*?'(?:${Object.values(
    REVIEW_STATUS,
  )
    .map(escapeRegExp)
    .join('|')})'`,
  'gi',
);

/**
 * Qualifiers that attribute a `status` column to the reviews table. Basis:
 * `rg 'FROM reviews|JOIN reviews|UPDATE reviews'` over src/ + worker/ — the
 * reviews table is aliased exclusively as `r` (dominant), `rev`
 * (src/lib/dashboard/service.ts), and `r2` (src/lib/reviews/process-review.ts
 * subquery), or referenced unaliased (`reviews.status`, or bare `status` in a
 * single-table statement — an UNQUALIFIED match always counts). Any OTHER
 * qualifier (`resp.`, `jo.`, `fr.`, `zc.`, …) is a different table's status
 * column riding along in a reviews JOIN and is skipped. Grow this set if a
 * new reviews alias convention appears in SQL.
 */
const REVIEWS_ALIAS_ALLOWLIST: ReadonlySet<string> = new Set(['r', 'rev', 'r2', 'reviews']);

/**
 * True when the tagged template counts as a raw review-status predicate: its
 * raw text mentions `reviews` AND contains at least one status comparison to
 * a quoted REVIEW_STATUS literal that is (a) attributable to the reviews
 * table (unqualified, or qualified by a REVIEWS_ALIAS_ALLOWLIST alias) and
 * (b) on a line that does not carry the escape pragma. EVERY match is walked
 * — a pragma or foreign qualifier on one predicate never exempts the others.
 * Pragma is checked at the line where the match starts (not the whole
 * template) so a pragma trailing the offending line exempts it without
 * requiring the entire template to be pragma'd.
 */
function templateHasUnignoredPredicate(node: ts.TaggedTemplateExpression, source: ts.SourceFile): boolean {
  const raw = node.getText(source);
  if (!/\breviews\b/.test(raw)) return false;

  const nodeStart = node.getStart(source);
  const lines = source.getFullText().split('\n');
  for (const match of raw.matchAll(STATUS_PREDICATE_RE)) {
    const qualifier = match[1]?.toLowerCase();
    if (qualifier !== undefined && !REVIEWS_ALIAS_ALLOWLIST.has(qualifier)) continue;
    const matchOffset = nodeStart + (match.index ?? 0);
    const lineIndex = source.getLineAndCharacterOfPosition(matchOffset).line;
    if (!lineHasPragma(lines, lineIndex, IGNORE_PRAGMA)) return true;
  }
  return false;
}

/**
 * True if the file's text contains an un-pragma'd reviews-table SQL/tx
 * tagged template comparing status to a raw REVIEW_STATUS literal. Pure —
 * unit-tested. A single boolean predicate over the file's full text.
 */
export function fileHasRawReviewStatusPredicate(text: string): boolean {
  const source = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTaggedTemplateExpression(node) && isSqlTaggedTemplate(node)) {
      if (templateHasUnignoredPredicate(node, source)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export interface EvaluateInput {
  matchingFiles: ReadonlySet<string>;
}

/**
 * Strict evaluation: every file with a raw reviews.status literal is a
 * failure. No baseline — the only escape is the per-line pragma (already
 * applied before a file reaches `matchingFiles`). Pure — unit-tested.
 */
export function evaluateFindings(input: EvaluateInput): string[] {
  const findings: string[] = [];
  for (const file of input.matchingFiles) {
    findings.push(
      `${file} has a raw reviews.status literal — import REVIEW_STATUS from ` +
        `src/lib/reviews/status.ts instead of a raw literal, or add a trailing ` +
        `'-- review-status-ignore' / '// review-status-ignore' pragma for an ` +
        `intentionally-inline state-transition write guard`,
    );
  }
  return findings;
}

export async function collectMatchingFiles(root: string): Promise<Set<string>> {
  const files = await walk(root, { scanDirs: SCAN_DIRS });
  const matching = new Set<string>();
  for (const file of files) {
    if (fileHasRawReviewStatusPredicate(await readFile(resolve(root, file), 'utf8'))) matching.add(file);
  }
  return matching;
}

async function main(): Promise<void> {
  const root = process.cwd();

  const matching = await collectMatchingFiles(root);
  const findings = evaluateFindings({ matchingFiles: matching });
  if (findings.length > 0) {
    console.error('reviews-status-audit: failed');
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log('reviews-status-audit: passed (no raw reviews.status literals)');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('reviews-status-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
