// scripts/ci/outbox-topics-audit.ts
//
// STRICT (no-baseline) guard for job_outbox `topic` column literals.
// src/lib/shared/queue-names.ts (QUEUE_NAMES) is the single owner of every
// BullMQ queue name / job_outbox topic value in this codebase — worker/queues.ts
// instantiates BullMQ Queues from it and the Vercel admin API reads queue
// health through it. A+ Q1 already swept every pre-existing raw job_outbox
// topic literal onto QUEUE_NAMES, so this guard ships STRICT from day one:
// any new raw literal fails CI immediately, no baseline ratchet.
//
// Detection technique mirrors reviews-status-audit.ts: walk the AST for
// tagged templates whose tag identifier is `sql`, `tx`, or `db` (shared tag
// set + helper: scripts/ci/lib/sql-tag-scan.ts — the Postgres.js client, a
// `sql.begin(tx => …)` transaction scope, and the `db`-named `SqlExecutor`
// parameter convention — `type SqlExecutor = typeof sql |
// postgres.TransactionSql`, used by helpers that accept either the
// top-level client or a transaction handle, e.g.
// worker/jobs/zernio/zernio-ingest-shared.ts), including the typed
// `sql<Type[]>` form; then pattern-match the template's raw text. The
// `exec`-named SqlExecutor spelling is NOT scanned (no job_outbox topic
// write uses it today; widen if one appears).
//
// SCOPE: src/lib + src/app + worker — everywhere application code writes or
// queries job_outbox rows. src/components is excluded (UI code has no SQL).
//
// A template COUNTS when its raw text mentions `job_outbox` AND contains a
// quoted literal equal to ANY value of ALL_QUEUE_NAMES, on a line WITHOUT a
// trailing `-- topic-audit-ignore` (SQL) / `// topic-audit-ignore` (TS)
// pragma. This walks EVERY quoted-literal occurrence and checks each one's
// own line for the pragma (reviews-status-audit.ts walks every match the
// same way) — necessary because a single job_outbox statement here routinely
// mixes a converted `${QUEUE_NAMES.X}` INSERT value with a sanctioned raw
// literal in an `ON CONFLICT ... WHERE` partial-unique-index predicate (a
// bind parameter breaks index inference there — see job-outbox-helpers.ts's
// enqueuePublishResponse/enqueueAutoPostNotice for the canonical example).
//
// Per-LINE escape pragma: `-- topic-audit-ignore` (SQL, trailing comment) or
// `// topic-audit-ignore` (TS, same or preceding line) exempts that specific
// literal — reserved for ON CONFLICT / partial-unique-index predicates that
// must stay literal, mirroring how response-status-audit / reviews-status-audit
// use explicit, reviewed escape hatches.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ALL_QUEUE_NAMES } from '../../src/lib/shared/queue-names';
import { escapeRegExp, isSqlTaggedTemplate, lineHasPragma } from './lib/sql-tag-scan';
import { walk } from './lib/ratchet-harness';

const SCAN_DIRS = ['src/lib', 'src/app', 'worker'] as const;
const IGNORE_PRAGMA = 'topic-audit-ignore';

const TOPIC_LITERAL_RE = new RegExp(
  `(['"])(${ALL_QUEUE_NAMES.map(escapeRegExp).join('|')})\\1`,
  'g',
);

/**
 * True when the tagged template mentions job_outbox AND has at least one
 * quoted QUEUE_NAMES-value literal on a line without the escape pragma.
 * Walks EVERY match (not just the first) — see module docblock for why.
 */
function templateHasUnignoredTopicLiteral(
  node: ts.TaggedTemplateExpression,
  source: ts.SourceFile,
): boolean {
  const raw = node.getText(source);
  if (!/\bjob_outbox\b/.test(raw)) return false;

  const nodeStart = node.getStart(source);
  const lines = source.getFullText().split('\n');
  TOPIC_LITERAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOPIC_LITERAL_RE.exec(raw)) !== null) {
    const matchOffset = nodeStart + match.index;
    const lineIndex = source.getLineAndCharacterOfPosition(matchOffset).line;
    if (!lineHasPragma(lines, lineIndex, IGNORE_PRAGMA)) return true;
  }
  return false;
}

/**
 * True if the file's text contains an un-pragma'd job_outbox SQL/tx tagged
 * template with a raw QUEUE_NAMES-value literal. Pure — unit-tested. Mirrors
 * reviews-status-audit's fileHasRawReviewStatusPredicate shape.
 */
export function fileHasRawOutboxTopicLiteral(text: string): boolean {
  const source = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTaggedTemplateExpression(node) && isSqlTaggedTemplate(node)) {
      if (templateHasUnignoredTopicLiteral(node, source)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const FINDING_DETAIL =
  'raw outbox topic literal — import QUEUE_NAMES from src/lib/shared/queue-names ' +
  '(ON CONFLICT index-inference predicates that must stay literal get a trailing ' +
  '-- topic-audit-ignore)';

/** STRICT: every matching file is a finding — no baseline. Pure — unit-tested. */
export function evaluateFindings(matchingFiles: readonly string[]): string[] {
  return matchingFiles.map((file) => `${file}: ${FINDING_DETAIL}`);
}

export async function collectMatchingFiles(root: string): Promise<string[]> {
  const files = await walk(root, { scanDirs: SCAN_DIRS });
  const matching: string[] = [];
  for (const file of files.sort()) {
    if (fileHasRawOutboxTopicLiteral(await readFile(resolve(root, file), 'utf8'))) {
      matching.push(file);
    }
  }
  return matching;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const matching = await collectMatchingFiles(root);
  const findings = evaluateFindings(matching);
  if (findings.length > 0) {
    console.error('outbox-topics-audit: failed');
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log('outbox-topics-audit: passed (no raw job_outbox topic literals in src/lib + src/app + worker)');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('outbox-topics-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
