import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALLOWLIST_BASELINE,
  CATEGORY_PATH_RULES,
  tenantScopeAllowlist,
  type TenantScopeAllowlistEntry,
} from './tenant-scope-allowlist';
import {
  TENANT_SCOPE_COLUMNS,
  TENANT_TABLES,
  type TenantScopeColumn,
  type TenantTable,
} from './tenant-tables';

export interface TenantScopeFinding {
  file: string;
  table: string;
  reason: string;
  /** Stable identity for one physical table binding. Integrity findings omit it. */
  sqlIdentity?: string;
}

export interface ExtractedSqlTemplate {
  tag: string;
  sqlText: string;
}

interface IndexedSqlTemplate extends ExtractedSqlTemplate {
  sourceIndex: number;
}

interface NamedSqlTemplate {
  name: string;
  sqlText: string;
  index: number;
  declarationKind: 'const' | 'let' | 'var';
  scopePath: readonly number[];
  functionScopePath: readonly number[];
}

const SCANNED_ROOTS = ['src', 'worker'] as const;
const UNSCOPED_REASON = 'missing account_id or business_id scope';
const DUPLICATE_ALLOWLIST_REASON = 'duplicate tenant scope allowlist entry';
const UNUSED_ALLOWLIST_REASON = 'unused tenant scope allowlist entry';

function normalizePath(file: string): string {
  return file.split(sep).join('/');
}

function normalizeSql(sqlText: string): string {
  return sqlText.replace(/\s+/g, ' ').trim();
}

function maskCharacters(chars: string[], start: number, end: number): void {
  for (let index = start; index <= end; index++) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}

function findJsExpressionEnd(sourceText: string, expressionStart: number): number | null {
  return scanJsExpressionEnd(sourceText, expressionStart);
}

interface SqlLexicalView {
  /** Strings, comments, dollar quotes, and template expressions cannot supply SQL evidence. */
  masked: string;
  /** `masked` plus quoted identifiers, for quote-aware structural keyword discovery. */
  structureMasked: string;
  /** Exact SQL with only comments masked, used by exact allowlist normalization. */
  commentsRemoved: string;
}

/**
 * One PostgreSQL-aware lexical pass feeds every structural decision below.
 * Both outputs preserve source length, which keeps child-block ranges stable.
 */
function lexSql(sqlText: string): SqlLexicalView {
  const masked = sqlText.split('');
  const structureMasked = sqlText.split('');
  const commentsRemoved = sqlText.split('');

  for (let index = 0; index < sqlText.length; index++) {
    const current = sqlText[index];
    const next = sqlText[index + 1];

    if (current === '-' && next === '-') {
      let end = index + 2;
      while (end < sqlText.length && sqlText[end] !== '\n') end++;
      maskCharacters(masked, index, end - 1);
      maskCharacters(structureMasked, index, end - 1);
      maskCharacters(commentsRemoved, index, end - 1);
      index = end - 1;
      continue;
    }

    if (current === '/' && next === '*') {
      let depth = 1;
      let end = index + 2;
      while (end < sqlText.length && depth > 0) {
        if (sqlText[end] === '/' && sqlText[end + 1] === '*') {
          depth++;
          end += 2;
          continue;
        }
        if (sqlText[end] === '*' && sqlText[end + 1] === '/') {
          depth--;
          end += 2;
          continue;
        }
        end++;
      }
      maskCharacters(masked, index, end - 1);
      maskCharacters(structureMasked, index, end - 1);
      maskCharacters(commentsRemoved, index, end - 1);
      index = end - 1;
      continue;
    }

    if (current === '"') {
      const start = index;
      index++;
      while (index < sqlText.length) {
        if (sqlText[index] === '"' && sqlText[index + 1] === '"') {
          index++;
        } else if (sqlText[index] === '"') {
          break;
        }
        index++;
      }
      maskCharacters(structureMasked, start, Math.min(index, sqlText.length - 1));
      continue;
    }

    if (current === "'") {
      const escaped = index > 0
        && /[eE]/.test(sqlText[index - 1] ?? '')
        && (index < 2 || !/[\w$]/.test(sqlText[index - 2] ?? ''));
      let end = index + 1;
      while (end < sqlText.length) {
        if (escaped && sqlText[end] === '\\') {
          end += 2;
          continue;
        }
        if (sqlText[end] === "'" && sqlText[end + 1] === "'") {
          end += 2;
          continue;
        }
        if (sqlText[end] === "'") break;
        end++;
      }
      maskCharacters(masked, index, Math.min(end, sqlText.length - 1));
      maskCharacters(structureMasked, index, Math.min(end, sqlText.length - 1));
      index = end;
      continue;
    }

    if (current === '$' && next === '{') {
      const end = findJsExpressionEnd(sqlText, index + 2);
      if (end === null) {
        maskCharacters(masked, index, sqlText.length - 1);
        break;
      }
      maskCharacters(masked, index, end);
      maskCharacters(structureMasked, index, end);
      masked[index] = '$';
      if (index + 1 <= end) masked[index + 1] = '1';
      structureMasked[index] = '$';
      if (index + 1 <= end) structureMasked[index + 1] = '1';
      index = end;
      continue;
    }

    if (current === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sqlText.slice(index))?.[0];
      if (!delimiter) continue;
      const endStart = sqlText.indexOf(delimiter, index + delimiter.length);
      const end = endStart < 0 ? sqlText.length - 1 : endStart + delimiter.length - 1;
      maskCharacters(masked, index, end);
      maskCharacters(structureMasked, index, end);
      index = end;
    }
  }

  return {
    masked: masked.join(''),
    structureMasked: structureMasked.join(''),
    commentsRemoved: commentsRemoved.join(''),
  };
}

function stripSqlComments(sqlText: string): string {
  return lexSql(sqlText).commentsRemoved;
}

function setOperatorMatch(sqlText: string, index: number): RegExpExecArray | null {
  const match = /^(?:union(?:\s+all)?|except|intersect)\b/i.exec(sqlText.slice(index));
  if (!match) return null;

  const before = sqlText[index - 1];
  if (before !== undefined && /[\w$]/.test(before)) return null;
  return match;
}

function splitTopLevelStatements(sqlText: string): string[] {
  const masked = lexSql(sqlText).structureMasked;
  const statements: string[] = [];
  let start = 0;
  let depth = 0;

  for (let index = 0; index < masked.length; index++) {
    const char = masked[index];
    if (char === '(') depth++;
    if (char === ')' && depth > 0) depth--;
    if (depth !== 0) continue;
    if (char === ';') {
      statements.push(sqlText.slice(start, index));
      start = index + 1;
    }
  }
  statements.push(sqlText.slice(start));
  return statements
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function splitTopLevelSetArms(sqlText: string): string[] {
  const masked = lexSql(sqlText).structureMasked;
  const arms: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index];
    if (char === '(') depth++;
    if (char === ')' && depth > 0) depth--;
    if (depth !== 0) continue;
    const setMatch = setOperatorMatch(masked, index);
    if (!setMatch) continue;
    arms.push(sqlText.slice(start, index));
    index += setMatch[0].length - 1;
    start = index + 1;
  }
  arms.push(sqlText.slice(start));
  return arms.map((part) => part.trim()).filter(Boolean);
}

function hasReadOrMutationStatement(sqlText: string): boolean {
  const structuralSql = lexSql(sqlText).structureMasked;
  if (/\b(select|update|delete)\b/i.test(structuralSql)) return true;
  const start = skipSqlWhitespace(structuralSql, 0);
  if (keywordAt(structuralSql, start, 'table')) return true;
  if (!keywordAt(structuralSql, start, 'with')) return false;

  let depth = 0;
  for (let index = start + 4; index < structuralSql.length; index++) {
    if (structuralSql[index] === '(') depth++;
    if (structuralSql[index] === ')' && depth > 0) depth--;
    if (depth === 0 && keywordAt(structuralSql, index, 'table')) return true;
  }
  return false;
}

type PredicateProvenance = 'filter' | 'inner-on' | 'left-on' | 'right-on' | 'full-on';

interface PredicateClause {
  sqlText: string;
  provenance: PredicateProvenance;
  joinedAliases?: ReadonlySet<string>;
}

function parenthesisDepthAt(sqlText: string, beforeIndex: number): number {
  let depth = 0;
  for (let index = 0; index < beforeIndex; index++) {
    if (sqlText[index] === '(') depth++;
    if (sqlText[index] === ')' && depth > 0) depth--;
  }
  return depth;
}

function joinContextForOnClause(
  sqlText: string,
  structuralSql: string,
  onIndex: number,
): Pick<PredicateClause, 'provenance' | 'joinedAliases'> {
  const prefix = structuralSql.slice(0, onIndex);
  const joinPattern = /\b(?:(left|right|full)(?:\s+outer)?|inner|cross)?\s*join\b/gi;
  let nearestJoin: RegExpExecArray | null = null;
  const onDepth = parenthesisDepthAt(structuralSql, onIndex);
  for (const match of prefix.matchAll(joinPattern)) {
    if (parenthesisDepthAt(structuralSql, match.index ?? 0) === onDepth) nearestJoin = match;
  }
  if (!nearestJoin) return { provenance: 'inner-on' };
  const joinType = nearestJoin[1]?.toLowerCase();
  const provenance: PredicateProvenance = joinType === 'left'
    ? 'left-on'
    : joinType === 'right'
      ? 'right-on'
      : joinType === 'full'
        ? 'full-on'
        : 'inner-on';
  return {
    provenance,
    joinedAliases: relationAliasesAt(sqlText, (nearestJoin.index ?? 0) + nearestJoin[0].length),
  };
}

function predicateClauses(sqlText: string): PredicateClause[] {
  const structuralSql = lexSql(sqlText).structureMasked;
  const clausePattern = /\b(?:where|on|having)\b[\s\S]*?(?=\b(?:(?:(?:left|right|full)(?:\s+outer)?|inner|cross)?\s*join|where|on|having|group\s+by|order\s+by|limit|offset|returning|for|union|except|intersect)\b|$)/gi;
  const clauses: PredicateClause[] = [];
  for (const match of structuralSql.matchAll(clausePattern)) {
    const index = match.index ?? 0;
    const sqlClause = sqlText.slice(index, index + match[0].length);
    if (!/^on\b/i.test(match[0])) {
      clauses.push({ sqlText: sqlClause, provenance: 'filter' });
      continue;
    }
    clauses.push({
      sqlText: sqlClause,
      ...joinContextForOnClause(sqlText, structuralSql, index),
    });
  }
  return clauses;
}

function boundValuePattern(): string {
  return String.raw`\$\d+(?:\s*::\s*"?[A-Za-z_][\w$]*"?(?:\[\])?)?`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface SqlIdentifier {
  /** PostgreSQL lookup value: unquoted names are folded, quoted names retain case. */
  value: string;
  quoted: boolean;
}

function caseInsensitiveAsciiPattern(value: string): string {
  return Array.from(value, (char) => (
    /[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : escapeRegExp(char)
  )).join('');
}

function identifierReferencePattern(identifier: SqlIdentifier): string {
  const quoted = `"${escapeRegExp(identifier.value.replace(/"/g, '""'))}"`;
  return identifier.quoted
    ? quoted
    : `(?:${caseInsensitiveAsciiPattern(identifier.value)}|${quoted})`;
}

function databaseColumnPattern(column: string): string {
  return `(?:${caseInsensitiveAsciiPattern(column)}|"${escapeRegExp(column)}")`;
}

function qualifiedIdentifier(alias: SqlIdentifier, column: string): string {
  return String.raw`(?<![\w$"])${identifierReferencePattern(alias)}\s*\.\s*${databaseColumnPattern(column)}`;
}

function unqualifiedIdentifier(column: string): string {
  return String.raw`(?<![\w$.])${databaseColumnPattern(column)}`;
}

function keywordAt(sqlText: string, index: number, keyword: string): boolean {
  if (sqlText.slice(index, index + keyword.length).toLowerCase() !== keyword) return false;

  const before = sqlText[index - 1];
  const after = sqlText[index + keyword.length];
  return (before === undefined || !/[\w$]/.test(before))
    && (after === undefined || !/[\w$]/.test(after));
}

function splitTopLevelAnd(sqlText: string): string[] {
  const structuralSql = lexSql(sqlText).structureMasked;
  const parts: string[] = [];
  let start = 0;
  let depth = 0;

  for (let index = 0; index < sqlText.length; index++) {
    const char = structuralSql[index];

    if (char === '(') depth++;
    if (char === ')' && depth > 0) depth--;
    if (depth !== 0) continue;

    if (keywordAt(structuralSql, index, 'and')) {
      parts.push(sqlText.slice(start, index));
      index += 'and'.length - 1;
      start = index + 1;
    }
  }

  parts.push(sqlText.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function containsStructuralKeyword(sqlText: string, keyword: string): boolean {
  const structuralSql = lexSql(sqlText).structureMasked;
  for (let index = 0; index < structuralSql.length; index++) {
    if (keywordAt(structuralSql, index, keyword)) return true;
  }
  return false;
}

function containsTopLevelStructuralKeyword(sqlText: string, keyword: string): boolean {
  const structuralSql = lexSql(sqlText).structureMasked;
  let depth = 0;
  for (let index = 0; index < structuralSql.length; index++) {
    if (structuralSql[index] === '(') depth++;
    if (structuralSql[index] === ')' && depth > 0) depth--;
    if (depth === 0 && keywordAt(structuralSql, index, keyword)) return true;
  }
  return false;
}

function completeProofConjunct(sqlText: string): string {
  let conjunct = sqlText.trim();
  let structuralSql = lexSql(conjunct).structureMasked;
  for (const keyword of ['where', 'on', 'having']) {
    if (!keywordAt(structuralSql, 0, keyword)) continue;
    conjunct = conjunct.slice(keyword.length).trim();
    break;
  }

  // An ON clause inside a parenthesized joined-table group inherits the
  // group's closing parens from the surrounding SQL. They are delimiters, not
  // boolean wrappers belonging to the conjunct itself.
  while (conjunct.endsWith(')')) {
    structuralSql = lexSql(conjunct).structureMasked;
    let balance = 0;
    for (const char of structuralSql) {
      if (char === '(') balance++;
      if (char === ')') balance--;
    }
    if (balance >= 0) break;
    conjunct = conjunct.slice(0, -1).trimEnd();
  }

  while (conjunct.startsWith('(')) {
    structuralSql = lexSql(conjunct).structureMasked;
    const closing = findMatchingParen(structuralSql, 0);
    if (closing !== conjunct.length - 1) break;
    conjunct = conjunct.slice(1, -1).trim();
  }
  return conjunct;
}

function hasBoundIdentifierPredicate(
  clauses: readonly PredicateClause[],
  identifiers: string[],
): boolean {
  const boundValue = boundValuePattern();
  const patterns = identifiers.flatMap((identifier) => [
    new RegExp(String.raw`^${identifier}\s*=\s*${boundValue}$`),
    new RegExp(String.raw`^${identifier}\s+\b[iI][nN]\b\s*\(\s*${boundValue}\s*\)$`),
    new RegExp(String.raw`^${identifier}\s*=\s*\b(?:[aA][nN][yY]|[sS][oO][mM][eE])\s*\(\s*${boundValue}\s*\)$`),
    new RegExp(String.raw`^${boundValue}\s*=\s*${identifier}$`),
  ]);

  return clauses
    .map((clause) => clause.sqlText)
    .filter((clause) => !containsTopLevelStructuralKeyword(clause, 'or'))
    .flatMap(splitTopLevelAnd)
    .some((part) => {
      if (containsStructuralKeyword(part, 'or') || containsStructuralKeyword(part, 'not')) return false;
      const conjunct = completeProofConjunct(part);
      return patterns.some((pattern) => pattern.test(conjunct));
    });
}

function hasIdentifierRelationship(
  clauses: readonly PredicateClause[],
  leftIdentifier: string,
  rightIdentifier: string,
): boolean {
  const leftToRight = new RegExp(String.raw`^${leftIdentifier}\s*=\s*${rightIdentifier}$`);
  const rightToLeft = new RegExp(String.raw`^${rightIdentifier}\s*=\s*${leftIdentifier}$`);
  return clauses
    .map((clause) => clause.sqlText)
    .filter((clause) => !containsTopLevelStructuralKeyword(clause, 'or'))
    .flatMap(splitTopLevelAnd)
    .some((part) => {
      if (containsStructuralKeyword(part, 'or') || containsStructuralKeyword(part, 'not')) return false;
      const conjunct = completeProofConjunct(part);
      return leftToRight.test(conjunct) || rightToLeft.test(conjunct);
    });
}

interface QueryChildRange {
  start: number;
  end: number;
}

interface TableBinding {
  table: TenantTable;
  alias: SqlIdentifier;
  bindingOrdinal: number;
}

/**
 * A BRIDGE relation (#894 Step 2): not a tenant table, never audited, never a
 * finding — but a binding of it can PROVE a tenant binding's scope. `users`
 * is the only bridge today: `WHERE u.auth_id = $x` anchors it to the caller's
 * Supabase identity (invariant #8), and three relationship shapes carry that
 * proof onto tenant tables (see localScopedBindings). Note the one-way flow:
 * an anchored bridge proves tenant bindings; a scoped tenant binding does NOT
 * retro-prove the bridge (no consumer needs that direction).
 */
const BRIDGE_TABLES = ['users'] as const;
type BridgeTable = (typeof BRIDGE_TABLES)[number];

/** The column whose bound predicate anchors each bridge table. */
const BRIDGE_ANCHOR_COLUMNS: Record<BridgeTable, string> = {
  users: 'auth_id',
};

interface BridgeBinding {
  table: BridgeTable;
  alias: SqlIdentifier;
  bindingOrdinal: number;
}

interface ProvenBinding extends TableBinding {}

interface RawScopeFinding extends TenantScopeFinding {
  allowlistSqlText: string;
}

interface AnalysisResult {
  findings: RawScopeFinding[];
  references: Array<{ table: TenantTable; allowlistSqlText: string }>;
}

const RESERVED_ALIAS_WORDS = new Set([
  'where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross',
  'using', 'set', 'returning', 'for', 'order', 'group', 'limit', 'offset',
  'union', 'except', 'intersect', 'lateral', 'window', 'having', 'from', 'as',
  'select', 'update', 'delete', 'materialized', 'with', 'ordinality',
]);

function findMatchingParen(maskedSql: string, openIndex: number): number | null {
  let depth = 0;
  for (let index = openIndex; index < maskedSql.length; index++) {
    if (maskedSql[index] === '(') depth++;
    if (maskedSql[index] !== ')') continue;
    depth--;
    if (depth === 0) return index;
  }
  return null;
}

function directQueryChildren(maskedSql: string): QueryChildRange[] {
  const stack: number[] = [];
  const candidates: QueryChildRange[] = [];
  for (let index = 0; index < maskedSql.length; index++) {
    if (maskedSql[index] === '(') {
      stack.push(index);
      continue;
    }
    if (maskedSql[index] !== ')') continue;
    const start = stack.pop();
    if (start === undefined) continue;
    const content = maskedSql.slice(start + 1, index).trimStart();
    if (/^(?:select|with|update|delete|table)\b/i.test(content)) {
      candidates.push({ start: start + 1, end: index });
    }
  }
  return candidates
    .filter((candidate) => !candidates.some((outer) => (
      outer !== candidate && outer.start < candidate.start && outer.end > candidate.end
    )))
    .sort((left, right) => left.start - right.start);
}

function maskChildRanges(maskedSql: string, ranges: readonly QueryChildRange[]): string {
  const chars = maskedSql.split('');
  // Keep the parentheses so relation parsing can distinguish a derived/LATERAL
  // relation from a physical table whose name happens to equal its alias.
  for (const range of ranges) maskCharacters(chars, range.start, range.end - 1);
  return chars.join('');
}

function readSqlIdentifier(
  maskedSql: string,
  start: number,
): (SqlIdentifier & { end: number }) | null {
  if (maskedSql[start] === '"') {
    let end = start + 1;
    while (end < maskedSql.length) {
      if (maskedSql[end] === '"' && maskedSql[end + 1] === '"') {
        end += 2;
        continue;
      }
      if (maskedSql[end] === '"') {
        return {
          value: maskedSql.slice(start + 1, end).replace(/""/g, '"'),
          quoted: true,
          end: end + 1,
        };
      }
      end++;
    }
    return null;
  }
  const match = /^[A-Za-z_][\w$]*/.exec(maskedSql.slice(start));
  return match ? {
    value: match[0].toLowerCase(),
    quoted: false,
    end: start + match[0].length,
  } : null;
}

function skipSqlWhitespace(maskedSql: string, start: number): number {
  let index = start;
  while (index < maskedSql.length && /\s/.test(maskedSql[index] ?? '')) index++;
  return index;
}

interface CteDefinition {
  name: SqlIdentifier;
  bodyStart: number;
  bodyEnd: number;
  visibleNames: ReadonlySet<string>;
}

interface CteCollection {
  definitions: CteDefinition[];
  allNames: ReadonlySet<string>;
}

function identifierKey(identifier: SqlIdentifier): string {
  return identifier.value;
}

function collectCtes(maskedSql: string): CteCollection {
  const definitions: CteDefinition[] = [];
  const priorNames = new Set<string>();
  const structuralSql = lexSql(maskedSql).structureMasked;
  let index = skipSqlWhitespace(maskedSql, 0);
  if (!keywordAt(structuralSql, index, 'with')) {
    return { definitions, allNames: priorNames };
  }
  index = skipSqlWhitespace(maskedSql, index + 4);
  const recursive = keywordAt(structuralSql, index, 'recursive');
  if (recursive) {
    index = skipSqlWhitespace(maskedSql, index + 9);
  }

  while (index < maskedSql.length) {
    const name = readSqlIdentifier(maskedSql, index);
    if (!name) break;
    index = skipSqlWhitespace(maskedSql, name.end);
    if (maskedSql[index] === '(') {
      const columnListEnd = findMatchingParen(maskedSql, index);
      if (columnListEnd === null) break;
      index = skipSqlWhitespace(maskedSql, columnListEnd + 1);
    }
    if (!keywordAt(structuralSql, index, 'as')) break;
    index = skipSqlWhitespace(maskedSql, index + 2);
    if (keywordAt(structuralSql, index, 'not')) {
      index = skipSqlWhitespace(maskedSql, index + 3);
    }
    if (keywordAt(structuralSql, index, 'materialized')) {
      index = skipSqlWhitespace(maskedSql, index + 12);
    }
    if (maskedSql[index] !== '(') break;
    const bodyEnd = findMatchingParen(maskedSql, index);
    if (bodyEnd === null) break;
    const visibleNames = new Set(priorNames);
    if (recursive) visibleNames.add(identifierKey(name));
    definitions.push({
      name,
      bodyStart: index + 1,
      bodyEnd,
      visibleNames,
    });
    priorNames.add(identifierKey(name));
    index = skipSqlWhitespace(maskedSql, bodyEnd + 1);
    if (maskedSql[index] !== ',') break;
    index = skipSqlWhitespace(maskedSql, index + 1);
  }
  return { definitions, allNames: priorNames };
}

interface ParsedRelation {
  alias: SqlIdentifier;
  relationName?: SqlIdentifier;
  schemaName?: SqlIdentifier;
  isFunctionOrDerived: boolean;
  shadowsAllAncestors?: boolean;
}

interface RelationCandidate extends ParsedRelation {
  index: number;
}

interface BindingCollection {
  tenantBindings: TableBinding[];
  bridgeBindings: BridgeBinding[];
  localAliases: ReadonlySet<string>;
}

interface JoinedTableGroup {
  contentStart: number;
  contentEnd: number;
}

function relationTokenStart(maskedSql: string, start: number): number {
  const structuralSql = lexSql(maskedSql).structureMasked;
  let index = skipSqlWhitespace(maskedSql, start);
  if (keywordAt(structuralSql, index, 'lateral')) {
    index = skipSqlWhitespace(maskedSql, index + 7);
  }
  if (keywordAt(structuralSql, index, 'only')) {
    index = skipSqlWhitespace(maskedSql, index + 4);
  }
  return index;
}

function joinedTableGroupAt(maskedSql: string, start: number): JoinedTableGroup | null {
  const open = relationTokenStart(maskedSql, start);
  if (maskedSql[open] !== '(') return null;
  const close = findMatchingParen(maskedSql, open);
  if (close === null) return null;
  const contentStart = skipSqlWhitespace(maskedSql, open + 1);
  const content = lexSql(maskedSql.slice(contentStart, close)).structureMasked.trimStart();
  if (/^(?:select|with|update|delete|table|values)\b/i.test(content)) return null;
  return { contentStart, contentEnd: close };
}

function aliasAfterRelation(
  maskedSql: string,
  start: number,
  defaultAlias: SqlIdentifier,
): SqlIdentifier {
  const structuralSql = lexSql(maskedSql).structureMasked;
  let index = skipSqlWhitespace(maskedSql, start);
  if (keywordAt(structuralSql, index, 'as')) {
    index = skipSqlWhitespace(maskedSql, index + 2);
    return readSqlIdentifier(maskedSql, index) ?? defaultAlias;
  }
  const candidate = readSqlIdentifier(maskedSql, index);
  if (!candidate || (!candidate.quoted && RESERVED_ALIAS_WORDS.has(candidate.value))) {
    return defaultAlias;
  }
  return candidate;
}

function aliasAfterFunctionRelation(
  maskedSql: string,
  start: number,
  defaultAlias: SqlIdentifier,
): Pick<ParsedRelation, 'alias' | 'shadowsAllAncestors'> {
  const structuralSql = lexSql(maskedSql).structureMasked;
  let index = skipSqlWhitespace(maskedSql, start);
  if (keywordAt(structuralSql, index, 'with')) {
    index = skipSqlWhitespace(maskedSql, index + 4);
    if (!keywordAt(structuralSql, index, 'ordinality')) {
      return { alias: defaultAlias, shadowsAllAncestors: true };
    }
    index = skipSqlWhitespace(maskedSql, index + 10);
  }

  let aliasStart = index;
  if (keywordAt(structuralSql, aliasStart, 'as')) {
    aliasStart = skipSqlWhitespace(maskedSql, aliasStart + 2);
    if (!readSqlIdentifier(maskedSql, aliasStart)) {
      return { alias: defaultAlias, shadowsAllAncestors: true };
    }
  }
  const explicitAlias = readSqlIdentifier(maskedSql, aliasStart);
  const alias = aliasAfterRelation(maskedSql, index, defaultAlias);
  if (!explicitAlias || (!explicitAlias.quoted && RESERVED_ALIAS_WORDS.has(explicitAlias.value))) {
    return { alias };
  }

  const columnAliasesStart = skipSqlWhitespace(maskedSql, explicitAlias.end);
  if (maskedSql[columnAliasesStart] !== '(') return { alias };
  return findMatchingParen(maskedSql, columnAliasesStart) === null
    ? { alias, shadowsAllAncestors: true }
    : { alias };
}

function parseRelation(maskedSql: string, start: number): ParsedRelation | null {
  let index = relationTokenStart(maskedSql, start);

  if (maskedSql[index] === '(') {
    const end = findMatchingParen(maskedSql, index);
    if (end === null) return null;
    const fallback: SqlIdentifier = { value: `(derived@${index})`, quoted: true };
    return {
      alias: aliasAfterRelation(maskedSql, end + 1, fallback),
      isFunctionOrDerived: true,
    };
  }

  const first = readSqlIdentifier(maskedSql, index);
  if (!first) return null;
  index = skipSqlWhitespace(maskedSql, first.end);
  let schemaName: SqlIdentifier | undefined;
  let relationName: SqlIdentifier = first;
  if (maskedSql[index] === '.') {
    const secondStart = skipSqlWhitespace(maskedSql, index + 1);
    const second = readSqlIdentifier(maskedSql, secondStart);
    if (!second) return null;
    schemaName = first;
    relationName = second;
    index = skipSqlWhitespace(maskedSql, second.end);
  }

  if (maskedSql[index] === '(') {
    const end = findMatchingParen(maskedSql, index);
    if (end === null) return null;
    const relationAlias = aliasAfterFunctionRelation(maskedSql, end + 1, relationName);
    return {
      ...relationAlias,
      relationName,
      schemaName,
      isFunctionOrDerived: true,
    };
  }

  return {
    alias: aliasAfterRelation(maskedSql, index, relationName),
    relationName,
    schemaName,
    isFunctionOrDerived: false,
  };
}

function collectRelationCandidates(maskedSql: string): RelationCandidate[] {
  const structuralSql = lexSql(maskedSql).structureMasked;
  const candidates: RelationCandidate[] = [];
  const addCandidate = (index: number): void => {
    const relation = parseRelation(maskedSql, index);
    if (relation) candidates.push({ ...relation, index });
    const joinedGroup = joinedTableGroupAt(maskedSql, index);
    if (joinedGroup) addCandidate(joinedGroup.contentStart);
  };

  const introducer = /\b(?:delete\s+from|from|join|update|using|table)\b/gi;
  for (const match of structuralSql.matchAll(introducer)) {
    addCandidate((match.index ?? 0) + match[0].length);
  }

  // FROM permits comma-separated bindings. Discover their heads from the
  // quote-aware structural view, then parse identifiers from the lexical view.
  const fromClause = /\bfrom\b([\s\S]*?)(?=\b(?:where|group\s+by|order\s+by|having|limit|offset|returning|union|except|intersect)\b|$)/gi;
  for (const clauseMatch of structuralSql.matchAll(fromClause)) {
    const clause = clauseMatch[1] ?? '';
    const clauseOffset = (clauseMatch.index ?? 0) + clauseMatch[0].indexOf(clause);
    let depth = 0;
    for (let index = 0; index < clause.length; index++) {
      if (clause[index] === '(') depth++;
      if (clause[index] === ')' && depth > 0) depth--;
      if (clause[index] === ',' && depth === 0) addCandidate(clauseOffset + index + 1);
    }
  }

  return candidates;
}

function relationAliasesAt(maskedSql: string, start: number): ReadonlySet<string> {
  const aliases = new Set<string>();
  const relation = parseRelation(maskedSql, start);
  if (relation) aliases.add(identifierKey(relation.alias));
  const joinedGroup = joinedTableGroupAt(maskedSql, start);
  if (!joinedGroup) return aliases;

  const groupSql = `FROM ${maskedSql.slice(joinedGroup.contentStart, joinedGroup.contentEnd)}`;
  for (const candidate of collectRelationCandidates(groupSql)) {
    aliases.add(identifierKey(candidate.alias));
  }
  return aliases;
}

function tableBindings(maskedSql: string, cteNames: ReadonlySet<string>): BindingCollection {
  const candidates = collectRelationCandidates(maskedSql);

  candidates.sort((left, right) => left.index - right.index);
  const seenCandidates = new Set<string>();
  const localAliases = new Set<string>();
  const tenantBindings: TableBinding[] = [];
  const bridgeBindings: BridgeBinding[] = [];
  for (const candidate of candidates) {
    const relationKey = candidate.relationName ? identifierKey(candidate.relationName) : '';
    const schemaKey = candidate.schemaName ? identifierKey(candidate.schemaName) : '';
    const candidateKey = `${candidate.index}\0${relationKey}\0${identifierKey(candidate.alias)}`;
    if (seenCandidates.has(candidateKey)) continue;
    seenCandidates.add(candidateKey);
    localAliases.add(identifierKey(candidate.alias));
    if (candidate.shadowsAllAncestors) localAliases.add('*');

    const schemaTargetsPublic = candidate.schemaName === undefined || schemaKey === 'public';
    const cteReference = candidate.schemaName === undefined && cteNames.has(relationKey);
    if (candidate.isFunctionOrDerived || !schemaTargetsPublic || cteReference) {
      continue;
    }
    if (TENANT_TABLES.includes(relationKey as TenantTable)) {
      tenantBindings.push({
        table: relationKey as TenantTable,
        alias: candidate.alias,
        bindingOrdinal: tenantBindings.length + 1,
      });
    } else if ((BRIDGE_TABLES as readonly string[]).includes(relationKey)) {
      // Retained SEPARATELY from the audited targets: a bridge binding can
      // prove scope but must never become a finding itself (#894 Step 2 —
      // before this, `users` was discarded here and any bridge logic
      // downstream was dead code).
      bridgeBindings.push({
        table: relationKey as BridgeTable,
        alias: candidate.alias,
        bindingOrdinal: bridgeBindings.length + 1,
      });
    }
  }
  return { tenantBindings, bridgeBindings, localAliases };
}

function directlyScoped(
  binding: TableBinding,
  clauses: readonly PredicateClause[],
  allowUnqualified: boolean,
): boolean {
  // Only a column the table PHYSICALLY has can be proof. Inside a subquery an
  // unqualified name the local table lacks resolves to an OUTER relation's
  // column (`EXISTS (SELECT 1 FROM reviews WHERE account_id = $1)` compiles and
  // restricts nothing), so the schema map, not the tenant vocabulary, decides
  // which predicates count.
  const columns = TENANT_SCOPE_COLUMNS[binding.table];
  const identifiers = columns.map((column) => qualifiedIdentifier(binding.alias, column));
  if (allowUnqualified) {
    identifiers.push(...columns.map(unqualifiedIdentifier));
  }
  const alias = identifierKey(binding.alias);
  const applicableClauses = clauses.filter((clause) => {
    if (clause.provenance === 'filter' || clause.provenance === 'inner-on') return true;
    if (clause.provenance === 'left-on') return clause.joinedAliases?.has(alias) ?? false;
    if (clause.provenance === 'right-on') return !(clause.joinedAliases?.has(alias) ?? true);
    return false;
  });
  return hasBoundIdentifierPredicate(applicableClauses, identifiers);
}

function bindingsRelated(
  clauses: readonly PredicateClause[],
  target: Pick<TableBinding, 'alias'>,
  targetColumn: string,
  source: Pick<TableBinding, 'alias'>,
  sourceColumn: string,
): boolean {
  const targetAlias = identifierKey(target.alias);
  const sourceAlias = identifierKey(source.alias);
  const applicableClauses = clauses.filter((clause) => {
    if (clause.provenance === 'filter' || clause.provenance === 'inner-on') return true;
    if (clause.provenance === 'left-on') {
      return (clause.joinedAliases?.has(targetAlias) ?? false)
        && !(clause.joinedAliases?.has(sourceAlias) ?? true);
    }
    if (clause.provenance === 'right-on') {
      return (clause.joinedAliases?.has(sourceAlias) ?? false)
        && !(clause.joinedAliases?.has(targetAlias) ?? true);
    }
    return false;
  });
  return hasIdentifierRelationship(
    applicableClauses,
    qualifiedIdentifier(target.alias, targetColumn),
    qualifiedIdentifier(source.alias, sourceColumn),
  );
}

/**
 * A bridge binding is ANCHORED when its anchor column carries a bound
 * predicate (for `users`: `u.auth_id = $x`). Qualified identifiers only — an
 * unqualified `auth_id` inside a multi-relation statement could resolve to an
 * outer row, and the bridge's whole job is to be proof.
 */
function anchoredBridgeBindings(
  bridges: readonly BridgeBinding[],
  clauses: readonly PredicateClause[],
): Set<BridgeBinding> {
  const anchored = new Set<BridgeBinding>();
  for (const bridge of bridges) {
    const alias = identifierKey(bridge.alias);
    const applicableClauses = clauses.filter((clause) => {
      if (clause.provenance === 'filter' || clause.provenance === 'inner-on') return true;
      if (clause.provenance === 'left-on') return clause.joinedAliases?.has(alias) ?? false;
      if (clause.provenance === 'right-on') return !(clause.joinedAliases?.has(alias) ?? true);
      return false;
    });
    const anchorColumn = BRIDGE_ANCHOR_COLUMNS[bridge.table];
    if (hasBoundIdentifierPredicate(applicableClauses, [
      qualifiedIdentifier(bridge.alias, anchorColumn),
    ])) {
      anchored.add(bridge);
    }
  }
  return anchored;
}

function localScopedBindings(
  bindings: readonly TableBinding[],
  clauses: readonly PredicateClause[],
  bridgeBindings: readonly BridgeBinding[] = [],
): Set<TableBinding> {
  const scoped = new Set<TableBinding>();
  const allowUnqualified = bindings.length === 1;
  for (const binding of bindings) {
    if (directlyScoped(binding, clauses, allowUnqualified)) scoped.add(binding);
  }
  const anchoredBridges = anchoredBridgeBindings(bridgeBindings, clauses);

  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of bindings) {
      if (scoped.has(binding)) continue;

      const viaAccount = bindings.some((account) => (
        account.table === 'accounts'
        && scoped.has(account)
        && binding.table !== 'accounts'
        && hasScopeColumn(binding.table, 'account_id')
        && bindingsRelated(clauses, binding, 'account_id', account, 'id')
      ));
      const viaBusiness = bindings.some((business) => (
        business.table === 'businesses'
        && scoped.has(business)
        && (
          (binding.table === 'accounts' && bindingsRelated(clauses, business, 'account_id', binding, 'id'))
          || (binding.table !== 'accounts'
            && binding.table !== 'businesses'
            && hasScopeColumn(binding.table, 'business_id')
            && bindingsRelated(clauses, binding, 'business_id', business, 'id'))
        )
      ));
      const viaOffboarding = binding.table === 'account_offboarding_tokens'
        && bindings.some((offboarding) => (
          offboarding.table === 'account_offboardings'
          && scoped.has(offboarding)
          && bindingsRelated(clauses, binding, 'account_offboarding_id', offboarding, 'id')
        ));

      // The `users` bridge shapes (#894 Step 2), specified from the MEASURED
      // allowlist SQL rather than the issue text:
      //   PRIMARY (24 of the 25 supabase-auth-id entries):
      //     `users u JOIN accounts a ON a.id = u.account_id WHERE u.auth_id = $x`
      //     — an anchored bridge proves `accounts` through its inbound FK;
      //     `businesses` then chains through the existing viaBusiness rule.
      //   4th shape: `accounts.owner_user_id = users.id` (inbound FK on the
      //     parent).
      //   5th shape, generalized: `<t>.account_id = users.account_id`
      //     (sibling-through-account; live example
      //     worker/jobs/summary-report-helpers.ts).
      const viaUsersInboundFk = binding.table === 'accounts'
        && [...anchoredBridges].some((bridge) => (
          bridge.table === 'users'
          && bindingsRelated(clauses, binding, 'id', bridge, 'account_id')
        ));
      const viaOwnerUser = binding.table === 'accounts'
        && [...anchoredBridges].some((bridge) => (
          bridge.table === 'users'
          && bindingsRelated(clauses, binding, 'owner_user_id', bridge, 'id')
        ));
      const viaUserSiblingAccount = hasScopeColumn(binding.table, 'account_id')
        && [...anchoredBridges].some((bridge) => (
          bridge.table === 'users'
          && bindingsRelated(clauses, binding, 'account_id', bridge, 'account_id')
        ));

      if (viaAccount || viaBusiness || viaOffboarding
        || viaUsersInboundFk || viaOwnerUser || viaUserSiblingAccount) {
        scoped.add(binding);
        changed = true;
      }
    }
  }
  return scoped;
}

function hasScopeColumn(table: TenantTable, column: TenantScopeColumn): boolean {
  return TENANT_SCOPE_COLUMNS[table].includes(column);
}

interface TenantIdentityColumn {
  kind: 'account' | 'business';
  column: TenantScopeColumn;
}

function tenantIdentityColumns(binding: TableBinding): TenantIdentityColumn[] {
  if (binding.table === 'accounts') return [{ kind: 'account', column: 'id' }];
  if (binding.table === 'businesses') {
    return [
      { kind: 'business', column: 'id' },
      { kind: 'account', column: 'account_id' },
    ];
  }
  const identities: TenantIdentityColumn[] = [];
  for (const column of TENANT_SCOPE_COLUMNS[binding.table]) {
    if (column === 'account_id') identities.push({ kind: 'account', column });
    if (column === 'business_id') identities.push({ kind: 'business', column });
  }
  return identities;
}

function scopedFromAncestor(
  binding: TableBinding,
  localAliases: ReadonlySet<string>,
  ancestors: readonly ProvenBinding[],
  clauses: readonly PredicateClause[],
): boolean {
  if (localAliases.has('*')) return false;
  for (const ancestor of ancestors) {
    if (localAliases.has(identifierKey(ancestor.alias))) continue;
    for (const localIdentity of tenantIdentityColumns(binding)) {
      for (const ancestorIdentity of tenantIdentityColumns(ancestor)) {
        if (localIdentity.kind !== ancestorIdentity.kind) continue;
        if (bindingsRelated(
          clauses,
          binding,
          localIdentity.column,
          ancestor,
          ancestorIdentity.column,
        )) return true;
      }
    }
  }
  return false;
}

function templateFingerprint(sqlText: string): string {
  return createHash('sha256')
    .update(normalizeSql(stripSqlComments(sqlText)))
    .digest('hex')
    .slice(0, 16);
}

interface AnalyzeBlockInput {
  sqlText: string;
  normalizedFile: string;
  templateHash: string;
  templateOccurrence: number;
  statementOrdinal: number;
  armPath: string;
  blockPath: string;
  ancestors: readonly ProvenBinding[];
  visibleCtes: ReadonlySet<string>;
  allowlistSqlText: string;
}

function analyzeQueryBlock(input: AnalyzeBlockInput): AnalysisResult {
  const lexical = lexSql(input.sqlText);
  const children = directQueryChildren(lexical.structureMasked);
  const directSql = maskChildRanges(lexical.masked, children);
  const ctes = collectCtes(lexical.masked);
  const visibleCtes = new Set([...input.visibleCtes, ...ctes.allNames]);
  const { tenantBindings: bindings, bridgeBindings, localAliases } = tableBindings(directSql, visibleCtes);
  const clauses = predicateClauses(directSql);
  const scoped = localScopedBindings(bindings, clauses, bridgeBindings);
  for (const binding of bindings) {
    if (scoped.has(binding)) continue;
    if (scopedFromAncestor(binding, localAliases, input.ancestors, clauses)) scoped.add(binding);
  }

  const identityPrefix = `template:${input.templateHash}:occurrence:${input.templateOccurrence}`
    + `:statement:${input.statementOrdinal}:arm:${input.armPath}:block:${input.blockPath}`;
  const findings: RawScopeFinding[] = bindings
    .filter((binding) => !scoped.has(binding))
    .map((binding) => ({
      file: input.normalizedFile,
      table: binding.table,
      reason: UNSCOPED_REASON,
      sqlIdentity: `${identityPrefix}:table:${binding.table}:alias:${binding.alias.value}:binding:${binding.bindingOrdinal}`,
      allowlistSqlText: input.allowlistSqlText,
    }));
  const references = bindings.map((binding) => ({
    table: binding.table,
    allowlistSqlText: input.allowlistSqlText,
  }));
  const provenHere = bindings.filter((binding) => scoped.has(binding));
  // A descendant resolves an alias to the NEAREST enclosing block that binds
  // it. Every alias this block binds therefore hides the same-named ancestor
  // from every descendant, and a relation whose alias could not be determined
  // (`*`) may hide any of them — so only unshadowed ancestors travel down.
  const inheritableAncestors = localAliases.has('*')
    ? []
    : input.ancestors.filter((ancestor) => !localAliases.has(identifierKey(ancestor.alias)));

  children.forEach((child, index) => {
    const childSql = input.sqlText.slice(child.start, child.end);
    const cteDefinition = ctes.definitions.find((cte) => (
      cte.bodyStart === child.start && cte.bodyEnd === child.end
    ));
    const childVisibleCtes = cteDefinition
      ? new Set([...input.visibleCtes, ...cteDefinition.visibleNames])
      : visibleCtes;
    const result = analyzeSqlStructure({
      sqlText: childSql,
      normalizedFile: input.normalizedFile,
      templateHash: input.templateHash,
      templateOccurrence: input.templateOccurrence,
      statementOrdinal: input.statementOrdinal,
      blockPath: `${input.blockPath}.${index + 1}`,
      armPathPrefix: input.armPath,
      // A CTE body precedes the main query's FROM bindings and cannot borrow
      // their aliases. Ordinary scalar/LATERAL children can correlate to them.
      ancestors: cteDefinition
        ? input.ancestors
        : [...inheritableAncestors, ...provenHere],
      visibleCtes: childVisibleCtes,
      allowlistSqlText: input.allowlistSqlText,
    });
    findings.push(...result.findings);
    references.push(...result.references);
  });

  return { findings, references };
}

interface AnalyzeStructureInput extends Omit<AnalyzeBlockInput, 'armPath'> {
  armPathPrefix?: string;
}

function analyzeSqlStructure(input: AnalyzeStructureInput): AnalysisResult {
  const findings: RawScopeFinding[] = [];
  const references: AnalysisResult['references'] = [];
  const arms = splitTopLevelSetArms(input.sqlText);
  const statementCtes = collectCtes(lexSql(input.sqlText).masked);
  arms.forEach((arm, index) => {
    const result = analyzeQueryBlock({
      ...input,
      sqlText: arm,
      armPath: input.armPathPrefix
        ? `${input.armPathPrefix}.${index + 1}`
        : `${index + 1}`,
      // A leading WITH belongs to the entire set expression. The first arm
      // parses its definitions (and therefore their ordered body visibility);
      // later arms see every completed CTE name from that WITH clause.
      visibleCtes: index === 0
        ? input.visibleCtes
        : new Set([...input.visibleCtes, ...statementCtes.allNames]),
    });
    findings.push(...result.findings);
    references.push(...result.references);
  });
  return { findings, references };
}

function allowlistKey(entry: TenantScopeAllowlistEntry): string {
  return `${entry.file}\0${entry.table}\0${normalizeSql(stripSqlComments(entry.sqlSnippet))}`;
}

function getAllowlistEntry(
  file: string,
  table: string,
  sqlText: string,
): TenantScopeAllowlistEntry | undefined {
  const normalizedSql = normalizeSql(stripSqlComments(sqlText));
  return tenantScopeAllowlist.find(
    (entry) => entry.file === file
      && entry.table === table
      && entry.reason.trim().length > 0
      && typeof entry.sqlSnippet === 'string'
      && normalizeSql(stripSqlComments(entry.sqlSnippet)).length > 0
      && normalizedSql === normalizeSql(stripSqlComments(entry.sqlSnippet)),
  );
}

function findDuplicateAllowlistEntries(): TenantScopeFinding[] {
  const seen = new Set<string>();
  const duplicates: TenantScopeFinding[] = [];

  for (const entry of tenantScopeAllowlist) {
    const key = allowlistKey(entry);
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }

    duplicates.push({
      file: entry.file,
      table: entry.table,
      reason: DUPLICATE_ALLOWLIST_REASON,
    });
  }

  return duplicates;
}

function findUnusedAllowlistEntries(usedAllowlistKeys: Set<string>): TenantScopeFinding[] {
  return tenantScopeAllowlist
    .filter((entry) => !usedAllowlistKeys.has(allowlistKey(entry)))
    .map((entry) => ({
      file: entry.file,
      table: entry.table,
      reason: UNUSED_ALLOWLIST_REASON,
    }));
}

/**
 * Structural checks on the allowlist itself: the exact-match baseline gate
 * (any add or remove must bump ALLOWLIST_BASELINE in the same PR) and the
 * per-category path invariants (an entry may not claim a justification its
 * file location contradicts). Exported for tests.
 */
export function findAllowlistIntegrityFindings(
  entries: readonly TenantScopeAllowlistEntry[] = tenantScopeAllowlist,
  baseline: number = ALLOWLIST_BASELINE,
): TenantScopeFinding[] {
  const findings: TenantScopeFinding[] = [];

  if (entries.length !== baseline) {
    findings.push({
      file: 'scripts/ci/tenant-scope-allowlist.ts',
      table: '(allowlist)',
      reason: `allowlist has ${entries.length} entries but ALLOWLIST_BASELINE is ${baseline} — update the baseline in the same PR so the change is an explicit, reviewed decision`,
    });
  }

  for (const entry of entries) {
    const rule = CATEGORY_PATH_RULES[entry.category];
    if (!rule) continue;
    const allowed = rule.allowedPrefixes.some((prefix) => entry.file.startsWith(prefix))
      || rule.allowedFiles?.includes(entry.file);
    if (!allowed) {
      findings.push({
        file: entry.file,
        table: entry.table,
        reason: `category '${entry.category}' requires the file to live under ${rule.allowedPrefixes.join(' | ')} — recategorize the entry, or add the file to this category's allowedFiles in CATEGORY_PATH_RULES with a justification`,
      });
    }
  }

  return findings;
}

function auditSqlTextOccurrence(
  file: string,
  sqlText: string,
  usedAllowlistKeys?: Set<string>,
  options: { applyAllowlist: boolean; templateOccurrence: number } = {
    applyAllowlist: true,
    templateOccurrence: 1,
  },
): TenantScopeFinding[] {
  const normalizedFile = normalizePath(file);
  const lexical = lexSql(sqlText);
  if (!hasReadOrMutationStatement(lexical.masked)) return [];

  const templateHash = templateFingerprint(sqlText);
  const allFindings: RawScopeFinding[] = [];
  const allReferences: AnalysisResult['references'] = [];
  const statements = splitTopLevelStatements(sqlText);
  statements.forEach((statement, index) => {
    if (!hasReadOrMutationStatement(lexSql(statement).masked)) return;
    const result = analyzeSqlStructure({
      sqlText: statement,
      normalizedFile,
      templateHash,
      templateOccurrence: options.templateOccurrence,
      statementOrdinal: index + 1,
      blockPath: 'root',
      ancestors: [],
      visibleCtes: new Set(),
      allowlistSqlText: statement,
    });
    allFindings.push(...result.findings);
    allReferences.push(...result.references);
  });

  const applyAllowlist = options.applyAllowlist;
  const exactTemplateEntries = new Map<TenantTable, TenantScopeAllowlistEntry>();
  for (const { table } of allReferences) {
    const entry = getAllowlistEntry(normalizedFile, table, sqlText);
    if (entry) exactTemplateEntries.set(table, entry);
  }

  for (const reference of allReferences) {
    const entry = exactTemplateEntries.get(reference.table)
      ?? getAllowlistEntry(normalizedFile, reference.table, reference.allowlistSqlText);
    if (entry && applyAllowlist) usedAllowlistKeys?.add(allowlistKey(entry));
  }

  return allFindings
    .filter((finding) => {
      if (!applyAllowlist) return true;
      return !(exactTemplateEntries.get(finding.table as TenantTable)
        ?? getAllowlistEntry(normalizedFile, finding.table, finding.allowlistSqlText));
    })
    .map(({ allowlistSqlText: _allowlistSqlText, ...finding }) => finding)
    .sort((left, right) => (
      TENANT_TABLES.indexOf(left.table as TenantTable)
      - TENANT_TABLES.indexOf(right.table as TenantTable)
    ));
}

export function auditSqlText(
  file: string,
  sqlText: string,
  usedAllowlistKeys?: Set<string>,
  options: { applyAllowlist?: boolean } = {},
): TenantScopeFinding[] {
  return auditSqlTextOccurrence(file, sqlText, usedAllowlistKeys, {
    applyAllowlist: options.applyAllowlist ?? true,
    templateOccurrence: 1,
  });
}

function shouldScanFile(file: string): boolean {
  const normalized = normalizePath(file);
  if (normalized.includes('/__tests__/')) return false;
  if (normalized.includes('/__fixtures__/')) return false;
  if (/\.(test|spec)\.[tj]sx?$/.test(normalized)) return false;
  return /\.(ts|tsx)$/.test(normalized) && !normalized.endsWith('.d.ts');
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(path));
    } else if (entry.isFile() && shouldScanFile(path)) {
      files.push(path);
    }
  }

  return files;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
]);

const CONTROL_HEADER_KEYWORDS = new Set([
  'catch', 'for', 'if', 'switch', 'while', 'with',
]);

interface JsWordToken {
  value: string;
  start: number;
}

interface JsLiteralToken {
  kind: 'string' | 'template';
  start: number;
  end: number;
  text: string;
  /**
   * First index of the enclosing `${ ... }` expression body when this literal
   * sits inside another template's placeholder; undefined at the top level. A
   * tag token found BEFORE this boundary belongs to the enclosing template.
   */
  expressionStart?: number;
  cookedText: string | null;
}

interface JsLexicalView {
  sourceText: string;
  /** Only executable JS/TS remains. Non-code is space-masked at stable offsets. */
  codeMasked: string;
  literals: readonly JsLiteralToken[];
  templates: readonly JsLiteralToken[];
}

interface JsTemplateExpressionRange {
  markerStart: number;
  end: number;
}

const JS_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
};

function cookJsStaticText(rawText: string): string | null {
  let cooked = '';
  for (let index = 0; index < rawText.length; index++) {
    const current = rawText[index];
    if (current !== '\\') {
      cooked += current;
      continue;
    }

    index++;
    const escaped = rawText[index];
    if (escaped === undefined) return null;
    if (escaped === '\n' || escaped === '\u2028' || escaped === '\u2029') continue;
    if (escaped === '\r') {
      if (rawText[index + 1] === '\n') index++;
      continue;
    }

    const simpleEscape = JS_SIMPLE_ESCAPES[escaped];
    if (simpleEscape !== undefined) {
      if (escaped === '0' && /\d/.test(rawText[index + 1] ?? '')) return null;
      cooked += simpleEscape;
      continue;
    }
    if (escaped === 'x') {
      const hex = rawText.slice(index + 1, index + 3);
      if (!/^[\dA-Fa-f]{2}$/.test(hex)) return null;
      cooked += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      if (rawText[index + 1] === '{') {
        const close = rawText.indexOf('}', index + 2);
        if (close < 0) return null;
        const hex = rawText.slice(index + 2, close);
        const codePoint = Number.parseInt(hex, 16);
        if (!/^[\dA-Fa-f]{1,6}$/.test(hex) || codePoint > 0x10ffff) return null;
        cooked += String.fromCodePoint(codePoint);
        index = close;
        continue;
      }
      const hex = rawText.slice(index + 1, index + 5);
      if (!/^[\dA-Fa-f]{4}$/.test(hex)) return null;
      cooked += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    if (/[1-9]/.test(escaped)) return null;

    // Quotes, backslashes, backticks, and JavaScript NonEscapeCharacters all
    // cook to the escaped character with the reverse solidus removed.
    cooked += escaped;
  }
  return cooked;
}

function cookJsTemplateText(
  sourceText: string,
  contentStart: number,
  contentEnd: number,
  expressions: readonly JsTemplateExpressionRange[],
): string | null {
  let cooked = '';
  let cursor = contentStart;
  for (const expression of expressions) {
    const segment = cookJsStaticText(sourceText.slice(cursor, expression.markerStart));
    if (segment === null) return null;
    cooked += segment;
    cooked += sourceText.slice(expression.markerStart, expression.end + 1);
    cursor = expression.end + 1;
  }
  const tail = cookJsStaticText(sourceText.slice(cursor, contentEnd));
  return tail === null ? null : cooked + tail;
}

function precedingJsWord(chars: readonly string[], beforeIndex: number): JsWordToken | null {
  let index = beforeIndex - 1;
  while (index >= 0 && /\s/.test(chars[index] ?? '')) index--;
  if (!/[\w$]/.test(chars[index] ?? '')) return null;
  const wordEnd = index + 1;
  while (index >= 0 && /[\w$]/.test(chars[index] ?? '')) index--;
  return { value: chars.slice(index + 1, wordEnd).join(''), start: index + 1 };
}

function isControlHeaderOpen(chars: readonly string[], openParenIndex: number): boolean {
  let token = precedingJsWord(chars, openParenIndex);
  if (token?.value === 'await') token = precedingJsWord(chars, token.start);
  if (!token || !CONTROL_HEADER_KEYWORDS.has(token.value)) return false;

  let precedingIndex = token.start - 1;
  while (precedingIndex >= 0 && /\s/.test(chars[precedingIndex] ?? '')) precedingIndex--;
  return chars[precedingIndex] !== '.';
}

class JsLexicalScanner {
  private readonly codeChars: string[];
  private readonly literals: JsLiteralToken[] = [];
  private readonly parenStack: boolean[] = [];
  private readonly expressionStarts: number[] = [];

  constructor(private readonly sourceText: string) {
    // Every parser offset in this module is a JavaScript UTF-16 string index.
    // `split('')` preserves that indexing; `Array.from` would collapse astral
    // characters and shift every token after an emoji or other surrogate pair.
    this.codeChars = sourceText.split('');
  }

  scan(): JsLexicalView {
    this.scanCode(0, false);
    const literals = this.literals.sort((left, right) => left.start - right.start);
    return {
      sourceText: this.sourceText,
      codeMasked: this.codeChars.join(''),
      literals,
      templates: literals.filter((literal) => literal.kind === 'template'),
    };
  }

  findExpressionEnd(expressionStart: number): number | null {
    return this.scanCode(expressionStart, true);
  }

  private mask(start: number, end: number): void {
    maskCharacters(this.codeChars, start, Math.min(end, this.sourceText.length - 1));
  }

  private scanQuotedString(start: number, quote: "'" | '"'): number {
    let end = start + 1;
    for (; end < this.sourceText.length; end++) {
      if (this.sourceText[end] === '\\') {
        end++;
        continue;
      }
      if (this.sourceText[end] === quote) break;
    }
    end = Math.min(end, this.sourceText.length - 1);
    const text = this.sourceText.slice(start + 1, end);
    this.literals.push({
      kind: 'string',
      start,
      end,
      text,
      cookedText: cookJsStaticText(text),
    });
    this.mask(start, end);
    return end;
  }

  private scanRegexLiteral(start: number): number | null {
    let inCharacterClass = false;
    let end = start + 1;
    for (; end < this.sourceText.length; end++) {
      if (this.sourceText[end] === '\n' || this.sourceText[end] === '\r') return null;
      if (this.sourceText[end] === '\\') {
        end++;
        continue;
      }
      if (this.sourceText[end] === '[') {
        inCharacterClass = true;
        continue;
      }
      if (this.sourceText[end] === ']' && inCharacterClass) {
        inCharacterClass = false;
        continue;
      }
      if (this.sourceText[end] === '/' && !inCharacterClass) break;
    }
    if (this.sourceText[end] !== '/') return null;
    while (/[A-Za-z]/.test(this.sourceText[end + 1] ?? '')) end++;
    this.mask(start, end);
    return end;
  }

  private scanTemplate(start: number): number {
    const expressions: JsTemplateExpressionRange[] = [];
    this.mask(start, start);
    for (let index = start + 1; index < this.sourceText.length; index++) {
      const current = this.sourceText[index];
      const next = this.sourceText[index + 1];
      if (current === '\\') {
        this.mask(index, Math.min(index + 1, this.sourceText.length - 1));
        index++;
        continue;
      }
      if (current === '$' && next === '{') {
        this.expressionStarts.push(index + 2);
        const expressionEnd = this.scanCode(index + 2, true);
        this.expressionStarts.pop();
        if (expressionEnd === null) {
          this.mask(index, this.sourceText.length - 1);
          return this.sourceText.length - 1;
        }
        this.mask(index, index + 1);
        this.mask(expressionEnd, expressionEnd);
        expressions.push({ markerStart: index, end: expressionEnd });
        index = expressionEnd;
        continue;
      }
      if (current === '`') {
        this.mask(index, index);
        const text = this.sourceText.slice(start + 1, index);
        this.literals.push({
          kind: 'template',
          start,
          end: index,
          text,
          expressionStart: this.expressionStarts.at(-1),
          cookedText: cookJsTemplateText(
            this.sourceText,
            start + 1,
            index,
            expressions,
          ),
        });
        return index;
      }
      this.mask(index, index);
    }
    return this.sourceText.length - 1;
  }

  private scanCode(start: number, stopAtExpressionEnd: boolean): number | null {
    let braceDepth = 0;
    let canEndExpression = false;
    let statementRegexAllowed = false;
    for (let index = start; index < this.sourceText.length; index++) {
      const current = this.sourceText[index];
      const next = this.sourceText[index + 1];
      if (/\s/.test(current ?? '')) continue;
      if (current === '/' && next === '/') {
        let end = index + 2;
        while (end < this.sourceText.length && this.sourceText[end] !== '\n') end++;
        this.mask(index, end - 1);
        index = end - 1;
        continue;
      }
      if (current === '/' && next === '*') {
        let end = index + 2;
        while (end < this.sourceText.length
          && !(this.sourceText[end] === '*' && this.sourceText[end + 1] === '/')) end++;
        end = Math.min(end + 1, this.sourceText.length - 1);
        this.mask(index, end);
        index = end;
        continue;
      }
      if (current === "'" || current === '"') {
        index = this.scanQuotedString(index, current);
        canEndExpression = true;
        statementRegexAllowed = false;
        continue;
      }
      if (current === '`') {
        index = this.scanTemplate(index);
        canEndExpression = true;
        statementRegexAllowed = false;
        continue;
      }
      if (/[A-Za-z_$]/.test(current ?? '')) {
        let end = index + 1;
        while (/[\w$]/.test(this.sourceText[end] ?? '')) end++;
        const word = this.sourceText.slice(index, end);
        canEndExpression = !REGEX_PREFIX_KEYWORDS.has(word);
        statementRegexAllowed = false;
        index = end - 1;
        continue;
      }
      if (/\d/.test(current ?? '')) {
        let end = index + 1;
        while (/[\w.]/.test(this.sourceText[end] ?? '')) end++;
        canEndExpression = true;
        statementRegexAllowed = false;
        index = end - 1;
        continue;
      }
      if (current === '(') {
        this.parenStack.push(isControlHeaderOpen(this.codeChars, index));
        canEndExpression = false;
        statementRegexAllowed = false;
        continue;
      }
      if (current === ')') {
        statementRegexAllowed = this.parenStack.pop() ?? false;
        canEndExpression = true;
        continue;
      }
      if (current === '[') {
        canEndExpression = false;
        statementRegexAllowed = false;
        continue;
      }
      if (current === ']') {
        canEndExpression = true;
        statementRegexAllowed = false;
        continue;
      }
      if (current === '/' && (statementRegexAllowed || !canEndExpression)) {
        const regexEnd = this.scanRegexLiteral(index);
        if (regexEnd !== null) {
          index = regexEnd;
          canEndExpression = true;
          statementRegexAllowed = false;
          continue;
        }
      }
      if (current === '{') {
        if (stopAtExpressionEnd) braceDepth++;
        canEndExpression = false;
        statementRegexAllowed = false;
        continue;
      }
      if (current === '}') {
        if (stopAtExpressionEnd && braceDepth === 0) return index;
        if (stopAtExpressionEnd) braceDepth--;
        canEndExpression = true;
        statementRegexAllowed = false;
        continue;
      }
      if ((current === '+' && next === '+') || (current === '-' && next === '-')) {
        statementRegexAllowed = false;
        index++;
        continue;
      }
      if (current === '!' && next !== '=') {
        statementRegexAllowed = false;
        continue;
      }

      canEndExpression = false;
      statementRegexAllowed = false;
    }
    return null;
  }
}

function lexJs(sourceText: string): JsLexicalView {
  return new JsLexicalScanner(sourceText).scan();
}

function scanJsExpressionEnd(sourceText: string, expressionStart: number): number | null {
  return new JsLexicalScanner(sourceText).findExpressionEnd(expressionStart);
}

function literalAfter(view: JsLexicalView, afterIndex: number): JsLiteralToken | null {
  for (const literal of view.literals) {
    if (literal.start < afterIndex) continue;
    if (view.codeMasked.slice(afterIndex, literal.start).trim().length > 0) return null;
    return literal;
  }
  return null;
}

function literalSqlText(literal: JsLiteralToken): string {
  // Invalid escape syntax cannot produce a runtime query in the scanned
  // TypeScript modules. Keep auditing its raw spelling instead of silently
  // dropping the literal, while valid literals use their runtime-cooked text.
  return literal.cookedText ?? literal.text;
}

function identifierBefore(codeMasked: string, beforeIndex: number): JsWordToken | null {
  let index = beforeIndex - 1;
  while (index >= 0 && /\s/.test(codeMasked[index] ?? '')) index--;
  if (!/[\w$]/.test(codeMasked[index] ?? '')) return null;
  const end = index + 1;
  while (index >= 0 && /[\w$]/.test(codeMasked[index] ?? '')) index--;
  return { value: codeMasked.slice(index + 1, end), start: index + 1 };
}

function genericTypeStartBefore(codeMasked: string, beforeIndex: number): number | null {
  let index = beforeIndex - 1;
  while (index >= 0 && /\s/.test(codeMasked[index] ?? '')) index--;
  if (codeMasked[index] !== '>') return null;

  let angleDepth = 1;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (index--; index >= 0; index--) {
    const current = codeMasked[index];
    if (current === '}') { braceDepth++; continue; }
    if (current === '{' && braceDepth > 0) { braceDepth--; continue; }
    if (current === ']') { bracketDepth++; continue; }
    if (current === '[' && bracketDepth > 0) { bracketDepth--; continue; }
    if (current === ')') { parenDepth++; continue; }
    if (current === '(' && parenDepth > 0) { parenDepth--; continue; }
    if (braceDepth > 0 || bracketDepth > 0 || parenDepth > 0) continue;
    if (current === '>' && codeMasked[index - 1] !== '=') {
      angleDepth++;
      continue;
    }
    if (current !== '<') continue;
    angleDepth--;
    if (angleDepth === 0) return index;
  }
  return null;
}

function sqlTagBeforeTemplate(
  codeMasked: string,
  template: JsLiteralToken,
  sqlTagNames: ReadonlySet<string>,
): { tag: string; sourceIndex: number } | null {
  const genericStart = genericTypeStartBefore(codeMasked, template.start);
  const tagToken = identifierBefore(codeMasked, genericStart ?? template.start);
  if (!tagToken || !sqlTagNames.has(tagToken.value)) return null;
  // The enclosing template's text and `${` are masked to whitespace, so a
  // plain literal nested in a placeholder (`sql\`... ${\`key:${id}\`} ...\``)
  // would otherwise walk back to the OUTER tag and be audited as SQL. Its
  // runtime value is a bind parameter, not a statement.
  if (template.expressionStart !== undefined && tagToken.start < template.expressionStart) {
    return null;
  }
  return { tag: tagToken.value, sourceIndex: tagToken.start };
}

export function extractSqlTemplates(sourceText: string): ExtractedSqlTemplate[] {
  const lexical = lexJs(sourceText);
  const templates: IndexedSqlTemplate[] = [];
  const sqlTagNames = extractSqlTagNames(lexical);
  for (const template of lexical.templates) {
    const tag = sqlTagBeforeTemplate(lexical.codeMasked, template, sqlTagNames);
    if (!tag) continue;
    templates.push({
      tag: tag.tag,
      sqlText: literalSqlText(template),
      sourceIndex: tag.sourceIndex,
    });
  }

  templates.push(...extractUnsafeSqlTemplates(lexical, sqlTagNames));

  return templates
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map(({ sourceIndex: _sourceIndex, ...template }) => template);
}

// db/server SQL-tag exports that behave like postgres.js tagged-template
// clients (`sql\`...\`` / `sqlRead\`...\`` / `sqlUnsubscribe\`...\``). Every
// one needs to be recognized here so the scanner sees tenant-scoped queries
// regardless of which pool a route uses (#477 read bulkhead, #651 redemption
// pool — each is a distinct export, never `sql as X`, so the source-side name
// check must accept it too). A new db/server client export MUST be added here
// in the same PR, or queries tagged with it silently escape this audit.
const DB_SERVER_SQL_TAG_SOURCE_NAMES = new Set(['sql', 'sqlRead', 'sqlUnsubscribe']);

function extractSqlTagNames(lexical: JsLexicalView): Set<string> {
  const tagNames = new Set<string>(['sql', 'tx', 'db']);
  const importRegex = /import\s*\{([^}]+)\}\s*from\b/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(lexical.codeMasked)) !== null) {
    const sourceLiteral = literalAfter(lexical, importRegex.lastIndex);
    const source = sourceLiteral?.kind === 'string' ? literalSqlText(sourceLiteral) : '';
    if (!isDbServerImportSource(source)) continue;
    const imports = match[1] ?? '';
    for (const specifier of imports.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/i);
      const sourceName = parts[0]?.trim();
      if (!sourceName || !DB_SERVER_SQL_TAG_SOURCE_NAMES.has(sourceName)) continue;
      // Fall back to the source name (not a hard-coded 'sql') so an
      // un-aliased `sqlRead` import registers as tag `sqlRead`, not `sql`.
      tagNames.add(parts[1]?.trim() || sourceName);
    }
  }

  return tagNames;
}

function isDbServerImportSource(source: string): boolean {
  return source === '@/lib/db/server'
    || /(?:^|\/)(?:src\/)?lib\/db\/server$/.test(source)
    || /(?:^|\/)db\/server$/.test(source);
}

function extractNamedSqlTemplates(lexical: JsLexicalView): NamedSqlTemplate[] {
  const namedTemplates: NamedSqlTemplate[] = [];
  const declarationRegex = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=/g;
  let match: RegExpExecArray | null;

  while ((match = declarationRegex.exec(lexical.codeMasked)) !== null) {
    const declarationKind = match[1] as NamedSqlTemplate['declarationKind'] | undefined;
    const name = match[2];
    if (!declarationKind || !name) continue;
    const literal = literalAfter(lexical, declarationRegex.lastIndex);
    if (!literal) continue;
    const scope = lexicalScopeContextAt(lexical.codeMasked, match.index);
    namedTemplates.push({
      name,
      sqlText: literalSqlText(literal),
      index: match.index,
      declarationKind,
      scopePath: scope.scopePath,
      functionScopePath: scope.functionScopePath,
    });
    declarationRegex.lastIndex = literal.end + 1;
  }

  return namedTemplates;
}

function resolveNamedSqlTemplates(
  namedTemplates: readonly NamedSqlTemplate[],
  name: string,
  beforeIndex: number,
  useScope: JsScopeContext,
): string[] {
  const matching = namedTemplates
    .filter((template) => template.name === name
      && template.index < beforeIndex
      && (template.declarationKind === 'var'
        ? isScopePrefix(template.functionScopePath, useScope.functionScopePath)
        : isScopePrefix(template.scopePath, useScope.scopePath)))
    .sort((left, right) => {
      const leftDepth = left.declarationKind === 'var'
        ? left.functionScopePath.length
        : left.scopePath.length;
      const rightDepth = right.declarationKind === 'var'
        ? right.functionScopePath.length
        : right.scopePath.length;
      return rightDepth - leftDepth || right.index - left.index;
    });

  const nearest = matching[0];
  if (!nearest) return [];
  if (nearest.declarationKind !== 'var') return [nearest.sqlText];

  return matching
    .filter((template) => template.declarationKind === 'var'
      && template.functionScopePath.length === nearest.functionScopePath.length
      && template.functionScopePath.every(
        (scope, index) => nearest.functionScopePath[index] === scope,
      ))
    .sort((left, right) => left.index - right.index)
    .map((template) => template.sqlText);
}

interface JsScopeContext {
  scopePath: readonly number[];
  functionScopePath: readonly number[];
}

interface JsScopeFrame {
  id: number;
  functionBody: boolean;
}

function isScopePrefix(candidate: readonly number[], use: readonly number[]): boolean {
  return candidate.length <= use.length
    && candidate.every((scope, index) => use[index] === scope);
}

function isFunctionBodyOpen(sourceText: string, braceIndex: number): boolean {
  const prefix = sourceText.slice(Math.max(0, braceIndex - 1000), braceIndex);
  if (/\bstatic\s*$/.test(prefix)) return true;
  if (/=>\s*$/.test(prefix)) return true;
  const returnType = String.raw`(?:\s*:\s*[^{};=]+)?`;
  if (new RegExp(
    String.raw`\bfunction\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?(?:\s*<[^{};]*>)?\s*\([^{};]*\)${returnType}\s*$`,
  ).test(prefix)) return true;

  const method = new RegExp(
    String.raw`\b([A-Za-z_$][\w$]*)(?:\s*<[^{};]*>)?\s*\([^{};]*\)${returnType}\s*$`,
  ).exec(prefix);
  if (!method) return false;
  return !new Set(['catch', 'for', 'if', 'switch', 'while', 'with']).has(method[1] ?? '');
}

function lexicalScopeContextAt(codeMasked: string, beforeIndex: number): JsScopeContext {
  const scopePath = [0];
  const functionScopePath = [0];
  const frames: JsScopeFrame[] = [];
  let nextScopeId = 1;
  for (let index = 0; index < beforeIndex; index++) {
    const current = codeMasked[index];
    if (current === '{') {
      const frame = {
        id: nextScopeId++,
        functionBody: isFunctionBodyOpen(codeMasked, index),
      };
      frames.push(frame);
      scopePath.push(frame.id);
      if (frame.functionBody) functionScopePath.push(frame.id);
      continue;
    }
    if (current === '}' && scopePath.length > 1) {
      const frame = frames.pop();
      scopePath.pop();
      if (frame?.functionBody) functionScopePath.pop();
    }
  }
  return { scopePath, functionScopePath };
}

function skipWhitespace(sourceText: string, startIndex: number): number {
  let index = startIndex;
  while (index < sourceText.length && /\s/.test(sourceText[index] ?? '')) index++;
  return index;
}

function readIdentifier(sourceText: string, startIndex: number): string | null {
  const match = /^[A-Za-z_$][\w$]*/.exec(sourceText.slice(startIndex));
  return match?.[0] ?? null;
}

function extractUnsafeSqlTemplates(
  lexical: JsLexicalView,
  sqlTagNames: ReadonlySet<string>,
): IndexedSqlTemplate[] {
  const templates: IndexedSqlTemplate[] = [];
  const namedTemplates = extractNamedSqlTemplates(lexical);
  const unsafeRegex = new RegExp(
    String.raw`(?<![\w$])(${Array.from(sqlTagNames).map(escapeRegExp).join('|')})\s*\.\s*unsafe(?:\s*<[^>(]+(?:\([^)]*\))?[^>]*>)?\s*\(`,
    'g',
  );
  let match: RegExpExecArray | null;

  while ((match = unsafeRegex.exec(lexical.codeMasked)) !== null) {
    const tag = `${match[1] ?? 'sql'}.unsafe`;
    const argumentLiteral = literalAfter(lexical, unsafeRegex.lastIndex);
    if (argumentLiteral) {
      templates.push({
        tag,
        sqlText: literalSqlText(argumentLiteral),
        sourceIndex: match.index,
      });
      unsafeRegex.lastIndex = argumentLiteral.end + 1;
      continue;
    }

    const argStart = skipWhitespace(lexical.codeMasked, unsafeRegex.lastIndex);
    const identifier = readIdentifier(lexical.codeMasked, argStart);
    if (!identifier) continue;
    const sqlTexts = resolveNamedSqlTemplates(
      namedTemplates,
      identifier,
      match.index,
      lexicalScopeContextAt(lexical.codeMasked, match.index),
    );
    for (const sqlText of sqlTexts) {
      templates.push({ tag, sqlText, sourceIndex: match.index });
    }
  }

  return templates;
}

/**
 * Audit one source file exactly as the repository walk does. Occurrence
 * ordinals belong to extraction ordering, so the single-template seam above
 * intentionally cannot override them.
 */
export function auditSourceText(
  file: string,
  sourceText: string,
  usedAllowlistKeys?: Set<string>,
  options: { applyAllowlist?: boolean } = {},
): TenantScopeFinding[] {
  const fingerprintOccurrences = new Map<string, number>();
  const findings: TenantScopeFinding[] = [];
  for (const { sqlText } of extractSqlTemplates(sourceText)) {
    const fingerprint = templateFingerprint(sqlText);
    const templateOccurrence = (fingerprintOccurrences.get(fingerprint) ?? 0) + 1;
    fingerprintOccurrences.set(fingerprint, templateOccurrence);
    findings.push(...auditSqlTextOccurrence(file, sqlText, usedAllowlistKeys, {
      applyAllowlist: options.applyAllowlist ?? true,
      templateOccurrence,
    }));
  }
  return findings;
}

async function auditRepository(options: { applyAllowlist?: boolean } = {}): Promise<TenantScopeFinding[]> {
  const applyAllowlist = options.applyAllowlist ?? true;
  const allFiles = (await Promise.all(SCANNED_ROOTS.map((root) => collectSourceFiles(root)))).flat();
  const findings: TenantScopeFinding[] = [];
  const usedAllowlistKeys = new Set<string>();

  for (const file of allFiles.sort()) {
    const sourceText = await readFile(file, 'utf8');
    findings.push(...auditSourceText(
      normalizePath(relative(process.cwd(), file)),
      sourceText,
      usedAllowlistKeys,
      { applyAllowlist },
    ));
  }

  return applyAllowlist
    ? [
        ...findAllowlistIntegrityFindings(),
        ...findDuplicateAllowlistEntries(),
        ...findUnusedAllowlistEntries(usedAllowlistKeys),
        ...findings,
      ]
    : findings;
}

async function main(): Promise<void> {
  const applyAllowlist = !process.argv.includes('--no-allowlist');
  const findings = await auditRepository({ applyAllowlist });
  const countSummary = `entries: ${tenantScopeAllowlist.length} (baseline: ${ALLOWLIST_BASELINE})`;
  if (findings.length > 0) {
    const mode = applyAllowlist ? '' : ' (allowlists disabled)';
    console.error(`tenant-scope-audit: failed${mode} — ${countSummary}; findings: ${findings.length}`);
    for (const finding of findings) {
      const identity = finding.sqlIdentity ? ` [${finding.sqlIdentity}]` : '';
      console.error(`${finding.file}: ${finding.table}: ${finding.reason}${identity}`);
    }
    process.exit(1);
  }

  console.log(`tenant-scope-audit: passed — ${countSummary}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('tenant-scope-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
