// scripts/ci/outbox-seam-audit.ts
//
// STRICT (no-baseline) guard for invariant #2's helper-ownership carve-outs.
//
// #568 asked whether `src/lib/shared/job-outbox-helpers.ts` is the single owner
// of `job_outbox` writes, or whether some categories legitimately bypass it.
// The answer CLAUDE.md records — and this audit enforces — is the second one,
// with a precise boundary:
//
//   VIOLATION  a SINGLE-ROW raw `INSERT INTO job_outbox` for a topic that HAS a
//              typed enqueue helper. The helper exists; use it.
//   LEGAL      set-based `INSERT … SELECT … FROM` fan-out. A helper whose
//              signature takes one aggregate id cannot express "one row per
//              business matching this predicate" — DrainOwnerConnectWorker
//              fans out publish_response, a helper-owned topic, and is correct.
//   LEGAL      any shape for a topic with NO helper. CLAUDE.md's "do not
//              backfill on spec".
//
// Helper coverage is DERIVED from job-outbox-helpers.ts (see
// deriveHelperTopicKeys), never hand-listed. That is the load-bearing choice: a
// hand-list would drift, and worse, would let someone add `enqueueNotifyAdmin`
// while five raw NOTIFY_ADMIN sites keep writing their own INSERT — two live
// owners for one topic, which is the exact failure #568 was opened about.
// Deriving means the moment a helper lands, every raw site for its topic goes
// red in the SAME PR. That is a deliberate accepted cost, not an oversight.
//
// Detection keys on the two STABLE seams, per the #592/#604 corollary that a
// detector keyed on a literal the codebase's own helpers abstract away is blind
// and reports success:
//   - helper coverage: parsed out of the helper module's own INSERTs;
//   - INSERT shape + topic: extracted per-INSERT from the AST, not by regex.
//
// Two shape traps this classifier exists to avoid, both of which a plausible
// regex walks straight into:
//
//   1. SHAPE IS NOT "does it contain SELECT". `enqueueValidatePlaceId` — a
//      typed helper — is itself an `INSERT … SELECT … WHERE NOT EXISTS`, and
//      inserts at most one row. So do the ZERNIO_INITIAL_BACKFILL resume in
//      worker/ingress/stripe/shared.ts and the failover requeue in
//      NotificationFailoverPoller. Fan-out requires a row-producing top-level
//      FROM. Treating SELECT as fan-out sanctions every guarded single-row
//      insert in the tree — measured, that is the difference between 5 real
//      fan-out sites and 9 apparent ones.
//   2. TOPIC IS NOT "the first quoted literal". The topic is read POSITIONALLY:
//      the column list names the columns, the row source supplies expressions,
//      and the topic is whichever expression sits at the `topic` column's
//      index. A heuristic that mis-attributes a topic fails silently in the
//      direction of passing.
//
// An INSERT whose topic or shape cannot be read is a FINDING, not a pass.
// Silence on an unrecognized shape is how a guard becomes decorative.
//
// Topics that are NOT QUEUE_NAMES values (the legacy `notify_owner_reconnect` /
// `notify_owner_connection_lost` aliases that worker/queues.ts routes to
// sendOwnerEmail) are read fine and are simply not helper-owned, so they are
// legal here. Whether those aliases should exist at all is ci:outbox-topics's
// question, not this audit's.
//
// SCOPE: src/lib + src/app + worker, matching ci:outbox-topics — everywhere
// application code writes job_outbox rows. The helper module self-excludes: it
// contains these INSERTs by definition (static-policy-audit.ts's SELF is the
// precedent).
//
// Per-LINE escape pragma: `-- outbox-seam-ignore: <reason>` (SQL, trailing) or
// `// outbox-seam-ignore: <reason>` (TS, same or preceding line), matching
// ci:outbox-status / ci:outbox-topics / ci:reviews-status / ci:response-status.
// It exists because without a deferral the rational move becomes "don't write
// the helper", which freezes every unhelpered topic permanently and makes the
// seam strictly worse. Ships with no baseline and exactly ONE use — the
// all-deliveries-failed arm of NotificationFailoverPoller, which runs outside
// any transaction and so cannot take a helper's TransactionSql at all.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { QUEUE_NAMES } from '../../src/lib/shared/queue-names';
import { isSqlTaggedTemplate, lineHasPragma } from './lib/sql-tag-scan';
import { walk } from './lib/ratchet-harness';

const SCAN_DIRS = ['src/lib', 'src/app', 'worker'] as const;
const IGNORE_PRAGMA = 'outbox-seam-ignore';

/** The helper module owns these INSERTs by definition — it is the seam itself. */
export const HELPER_MODULE = 'src/lib/shared/job-outbox-helpers.ts';

const INSERT_RE = /INSERT\s+INTO\s+job_outbox\b/gi;
const QUEUE_NAME_REF_RE = /QUEUE_NAMES\.([A-Za-z0-9_]+)/;
const STRING_LITERAL_RE = /'([^']*)'/;

/** How many rows an `INSERT INTO job_outbox` can produce. */
export type InsertShape = 'single-row' | 'set-based' | 'unknown';

/**
 * How the topic column's value was written. Kept symbolic rather than resolved
 * so the parser stays pure over source text; `evaluateFindings` resolves both
 * forms against QUEUE_NAMES.
 */
export type TopicRef =
  | { kind: 'queue-names'; key: string }
  | { kind: 'literal'; value: string };

export interface OutboxInsertSite {
  /** null when the topic expression could not be read — reported, never passed. */
  topic: TopicRef | null;
  shape: InsertShape;
  /** 0-indexed line of the `INSERT INTO job_outbox` token. */
  line: number;
}

/**
 * Blanks out the spans of a SQL template that must not be read as SQL syntax —
 * `${…}` interpolations, `-- …` line comments, and `'…'` string literals —
 * preserving length so every offset computed on the mask also indexes the
 * original. Without this, the parens inside `${tx.json(payload as never)}` and
 * the keywords inside a pragma comment both corrupt the depth tracking that
 * the shape and topic parsers depend on.
 */
/** Index one past the `${…}` interpolation starting at `start`. */
function endOfInterpolation(text: string, start: number): number {
  let depth = 0;
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Index one past the `'…'` literal starting at `start`, honoring `''` escapes. */
function endOfStringLiteral(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] !== "'") i += 1;
    else if (text[i + 1] === "'") i += 2;
    else return i + 1;
  }
  return text.length;
}

/** End of the non-SQL span starting at `i`, or null when `i` starts no such span. */
function endOfMaskedSpan(text: string, i: number): number | null {
  if (text[i] === '$' && text[i + 1] === '{') return endOfInterpolation(text, i);
  if (text[i] === '-' && text[i + 1] === '-') {
    const newline = text.indexOf('\n', i);
    return newline === -1 ? text.length : newline;
  }
  if (text[i] === "'") return endOfStringLiteral(text, i);
  return null;
}

export function maskSqlTemplate(region: string): string {
  const out = region.split('');
  let i = 0;
  while (i < region.length) {
    const end = endOfMaskedSpan(region, i);
    if (end === null) {
      i += 1;
      continue;
    }
    for (let k = i; k < end; k += 1) out[k] = ' ';
    i = end;
  }
  return out.join('');
}

interface Span {
  start: number;
  end: number;
}

interface Token {
  /** Uppercased word, or '(' for a paren group opening at depth 0. */
  word: string;
  index: number;
}

/**
 * Words and paren-group openings at parenthesis depth 0 of `masked`. Depth is
 * what separates `SELECT … FROM businesses` (fan-out) from the `FROM` buried
 * in a `WHERE NOT EXISTS (SELECT 1 FROM job_outbox …)` dedup guard.
 */
function topLevelTokens(masked: string, from = 0): Token[] {
  const tokens: Token[] = [];
  const scanner = /[()]|[A-Za-z_][A-Za-z0-9_]*/g;
  scanner.lastIndex = from;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(masked)) !== null) {
    if (match[0] === '(') {
      if (depth === 0) tokens.push({ word: '(', index: match.index });
      depth += 1;
      continue;
    }
    if (match[0] === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) tokens.push({ word: match[0].toUpperCase(), index: match.index });
  }
  return tokens;
}

/** Span between the parens of the group opening at `open`, or null if unbalanced. */
function parenContents(masked: string, open: number): Span | null {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return { start: open + 1, end: i };
    }
  }
  return null;
}

/** Splits `[start, end)` on commas at parenthesis depth 0. */
function splitTopLevel(masked: string, { start, end }: Span): Span[] {
  const parts: Span[] = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') depth -= 1;
    else if (masked[i] === ',' && depth === 0) {
      parts.push({ start: from, end: i });
      from = i + 1;
    }
  }
  parts.push({ start: from, end });
  return parts;
}

/** Trailing clauses that end the row-producing part of the statement. */
const ROW_SOURCE_TERMINATORS = new Set(['ON', 'RETURNING']);
/** Clauses that end a SELECT's projection list without producing rows. */
const SELECT_LIST_TERMINATORS = new Set(['FROM', 'WHERE', 'ON', 'RETURNING']);

interface ParsedInsert {
  shape: InsertShape;
  /** Column names from the INSERT's column list, lowercased. */
  columns: string[];
  /** Row-source expressions, positionally aligned to `columns`. */
  values: Span[];
}

/**
 * Parses one `INSERT INTO job_outbox …` statement into its column list, its
 * row-source expressions, and its row cardinality:
 *
 * - `VALUES` with one tuple → single-row; with several → set-based.
 * - `SELECT` with a row-producing top-level `FROM` → set-based fan-out; without
 *   one (a literal projection, optionally guarded by `WHERE NOT EXISTS (…)`) →
 *   single-row.
 * - anything else → unknown, which the caller reports rather than passes.
 *
 * Scanning of the row source stops at `ON CONFLICT` / `RETURNING` so the
 * `ON CONFLICT (topic, aggregate_id)` paren group is not miscounted as a
 * second VALUES tuple.
 */
function parseInsert(masked: string): ParsedInsert {
  const empty: ParsedInsert = { shape: 'unknown', columns: [], values: [] };

  const columnOpen = topLevelTokens(masked).find((token) => token.word === '(');
  if (!columnOpen) return empty;
  const columnSpan = parenContents(masked, columnOpen.index);
  if (!columnSpan) return empty;
  const columns = splitTopLevel(masked, columnSpan).map((span) =>
    masked.slice(span.start, span.end).trim().toLowerCase(),
  );

  const after = topLevelTokens(masked, columnSpan.end + 1);
  const startIndex = after.findIndex((token) => token.word === 'VALUES' || token.word === 'SELECT');
  if (startIndex === -1) return { ...empty, columns };

  const rest = after.slice(startIndex + 1);
  const terminator = rest.findIndex((token) => ROW_SOURCE_TERMINATORS.has(token.word));
  const rowSource = terminator === -1 ? rest : rest.slice(0, terminator);

  if (after[startIndex]?.word === 'VALUES') {
    const tuples = rowSource.filter((token) => token.word === '(');
    if (tuples.length === 0) return { ...empty, columns };
    const tupleSpan = parenContents(masked, tuples[0]!.index);
    if (!tupleSpan) return { ...empty, columns };
    return {
      shape: tuples.length > 1 ? 'set-based' : 'single-row',
      columns,
      values: splitTopLevel(masked, tupleSpan),
    };
  }

  const listEnd = rowSource.find((token) => SELECT_LIST_TERMINATORS.has(token.word));
  const projection: Span = {
    start: after[startIndex]!.index + 'SELECT'.length,
    end: listEnd?.index ?? (terminator === -1 ? masked.length : rest[terminator]!.index),
  };
  return {
    shape: rowSource.some((token) => token.word === 'FROM') ? 'set-based' : 'single-row',
    columns,
    values: splitTopLevel(masked, projection),
  };
}

/** Reads the topic expression at the `topic` column's position. */
function extractTopic(statement: string, parsed: ParsedInsert): TopicRef | null {
  const index = parsed.columns.indexOf('topic');
  const span = index === -1 ? undefined : parsed.values[index];
  if (!span) return null;

  const expression = statement.slice(span.start, span.end);
  const reference = QUEUE_NAME_REF_RE.exec(expression);
  if (reference) return { kind: 'queue-names', key: reference[1]! };
  const literal = STRING_LITERAL_RE.exec(expression);
  if (literal) return { kind: 'literal', value: literal[1]! };
  return null;
}

/**
 * Every `INSERT INTO job_outbox` in `text`, with its topic and row cardinality.
 * Each statement runs from its `INSERT INTO job_outbox` token to the next one
 * (or the end of the template). Pure — unit-tested.
 */
export function findOutboxInserts(text: string): OutboxInsertSite[] {
  const source = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.getFullText().split('\n');
  const sites: OutboxInsertSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTaggedTemplate(node)) {
      const raw = node.getText(source);
      const nodeStart = node.getStart(source);

      const starts: number[] = [];
      INSERT_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = INSERT_RE.exec(raw)) !== null) starts.push(match.index);

      starts.forEach((offset, index) => {
        const line = source.getLineAndCharacterOfPosition(nodeStart + offset).line;
        if (lineHasPragma(lines, line, IGNORE_PRAGMA)) return;
        const statement = raw.slice(offset, starts[index + 1] ?? raw.length);
        const parsed = parseInsert(maskSqlTemplate(statement));
        sites.push({ topic: extractTopic(statement, parsed), shape: parsed.shape, line });
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/**
 * QUEUE_NAMES keys that `job-outbox-helpers.ts` owns an enqueue function for —
 * the topic of every `INSERT INTO job_outbox` inside an exported `enqueue*`
 * function declaration. Derived, never hand-listed: this IS the coverage
 * question, and answering it from the module itself is what makes "a topic
 * never has two live enqueue owners" mechanically true. Pure — unit-tested.
 */
export function deriveHelperTopicKeys(helperSource: string): Set<string> {
  const source = ts.createSourceFile('helpers.ts', helperSource, ts.ScriptTarget.Latest, true);
  const keys = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text.startsWith('enqueue') &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const site of findOutboxInserts(node.getText(source))) {
        if (site.topic?.kind === 'queue-names') keys.add(site.topic.key);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}

export interface FileInserts {
  file: string;
  sites: readonly OutboxInsertSite[];
}

/**
 * True when `topic` names one of `helperKeys`. A raw string literal is resolved
 * back through QUEUE_NAMES so `'send_notification'` and
 * `QUEUE_NAMES.SEND_NOTIFICATION` are judged identically — a literal that
 * matches no queue name (the legacy notify_owner_* aliases) is simply not
 * helper-owned.
 */
function isHelperOwned(topic: TopicRef, helperKeys: ReadonlySet<string>): boolean {
  if (topic.kind === 'queue-names') return helperKeys.has(topic.key);
  return [...helperKeys].some((key) => QUEUE_NAMES[key as keyof typeof QUEUE_NAMES] === topic.value);
}

function describeTopic(topic: TopicRef): string {
  return topic.kind === 'queue-names' ? `QUEUE_NAMES.${topic.key}` : `'${topic.value}'`;
}

function unreadableFinding(at: string, site: OutboxInsertSite): string {
  const topic = site.topic === null ? 'unreadable' : describeTopic(site.topic);
  return (
    `${at}: could not classify this INSERT INTO job_outbox (topic=${topic}, shape=${site.shape}) — ` +
    'this audit will not silently pass a statement it cannot read. Name the topic column in ' +
    'the INSERT column list and give it a QUEUE_NAMES.<TOPIC> or literal value, or add ' +
    `-- ${IGNORE_PRAGMA}: <reason> if it is genuinely unclassifiable`
  );
}

function bypassFinding(at: string, topic: TopicRef): string {
  return (
    `${at}: single-row raw INSERT INTO job_outbox for ${describeTopic(topic)}, which has a typed ` +
    'helper in src/lib/shared/job-outbox-helpers.ts — call the helper (invariant #2). Set-based ' +
    'INSERT … SELECT … FROM fan-out is exempt; a dedup or payload variant the helper cannot ' +
    `model gets -- ${IGNORE_PRAGMA}: <reason>`
  );
}

function judgeSite(file: string, site: OutboxInsertSite, helperKeys: ReadonlySet<string>): string[] {
  const at = `${file}:${site.line + 1}`;
  if (site.topic === null || site.shape === 'unknown') return [unreadableFinding(at, site)];
  if (site.shape === 'single-row' && isHelperOwned(site.topic, helperKeys)) {
    return [bypassFinding(at, site.topic)];
  }
  return [];
}

/**
 * One finding per offending INSERT: a single-row raw write for a helper-owned
 * topic, or an INSERT whose topic or shape could not be read at all. STRICT —
 * no baseline. Pure — unit-tested.
 */
export function evaluateFindings(
  files: readonly FileInserts[],
  helperKeys: ReadonlySet<string>,
): string[] {
  return files
    .filter(({ file }) => file !== HELPER_MODULE)
    .flatMap(({ file, sites }) => sites.flatMap((site) => judgeSite(file, site, helperKeys)));
}

export async function collectFileInserts(root: string): Promise<FileInserts[]> {
  const files = await walk(root, { scanDirs: SCAN_DIRS });
  const collected: FileInserts[] = [];
  for (const file of files.sort()) {
    const text = await readFile(resolve(root, file), 'utf8');
    if (!text.includes('job_outbox')) continue;
    const sites = findOutboxInserts(text);
    if (sites.length > 0) collected.push({ file, sites });
  }
  return collected;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const helperKeys = deriveHelperTopicKeys(await readFile(resolve(root, HELPER_MODULE), 'utf8'));
  if (helperKeys.size === 0) {
    // Deriving zero helpers would make every raw INSERT legal and the audit
    // would report success — the #592/#604 blind-detector failure mode exactly.
    console.error(`outbox-seam-audit: fatal — derived 0 enqueue helpers from ${HELPER_MODULE}`);
    process.exit(1);
  }

  const findings = evaluateFindings(await collectFileInserts(root), helperKeys);
  if (findings.length > 0) {
    console.error('outbox-seam-audit: failed');
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log(
    `outbox-seam-audit: passed (${helperKeys.size} helper-owned topics; ` +
      'no single-row raw job_outbox INSERT bypasses its helper)',
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('outbox-seam-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
