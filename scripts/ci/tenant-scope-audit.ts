import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tenantScopeAllowlist, type TenantScopeAllowlistEntry } from './tenant-scope-allowlist';

export interface TenantScopeFinding {
  file: string;
  table: string;
  reason: string;
}

export interface ExtractedSqlTemplate {
  tag: string;
  sqlText: string;
}

interface NamedSqlTemplate {
  name: string;
  sqlText: string;
  index: number;
}

const TENANT_TABLES = [
  'accounts',
  'businesses',
  'channel_enrollments',
  'reviews',
  'responses',
  'approval_links',
  'approval_audit_log',
  'account_audit_log',
  'notification_deliveries',
  'api_costs',
  'weekly_summaries',
  'monthly_impact_emails',
  'onboarding_drip_log',
  'satisfaction_responses',
  'api_costs_daily_rollups',
  'review_exceptions',
  'ranking_snapshots',
  'zernio_connections',
  'zernio_finalize_incidents',
  'zernio_backfill_runs',
  'sms_sender_opt_outs',
  'sms_sender_opt_out_events',
] as const;

type TenantTable = (typeof TENANT_TABLES)[number];

const SCANNED_ROOTS = ['src', 'worker'] as const;
const UNSCOPED_REASON = 'missing account_id or business_id scope';
const DUPLICATE_ALLOWLIST_REASON = 'duplicate tenant scope allowlist entry';
const UNUSED_ALLOWLIST_REASON = 'unused tenant scope allowlist entry';

function normalizePath(file: string): string {
  return file.split(sep).join('/');
}

function stripSqlComments(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ');
}

function stripSelectSubqueries(sqlText: string): string {
  let stripped = '';
  for (let index = 0; index < sqlText.length; index++) {
    const current = sqlText[index];
    if (current !== '(') {
      stripped += current;
      continue;
    }

    const afterParen = sqlText.slice(index + 1);
    const leadingWhitespace = afterParen.match(/^\s*/)?.[0] ?? '';
    if (!afterParen.slice(leadingWhitespace.length).match(/^select\b/i)) {
      stripped += current;
      continue;
    }

    let depth = 1;
    index++;
    while (index < sqlText.length && depth > 0) {
      const char = sqlText[index];
      if (char === '(') depth++;
      if (char === ')') depth--;
      index++;
    }
    index--;
    stripped += ' (subquery) ';
  }
  return stripped;
}

function normalizeSql(sqlText: string): string {
  return sqlText.replace(/\s+/g, ' ').trim();
}

function setOperatorMatch(sqlText: string, index: number): RegExpExecArray | null {
  const match = /^(?:union(?:\s+all)?|except|intersect)\b/i.exec(sqlText.slice(index));
  if (!match) return null;

  const before = sqlText[index - 1];
  if (before !== undefined && /[\w$]/.test(before)) return null;
  return match;
}

function splitSqlUnits(sqlText: string): string[] {
  const units: string[] = [];
  let start = 0;
  let depth = 0;

  for (let index = 0; index < sqlText.length; index++) {
    const char = sqlText[index];

    if (char === "'") {
      index++;
      while (index < sqlText.length) {
        if (sqlText[index] === "'" && sqlText[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (sqlText[index] === "'") break;
        index++;
      }
      continue;
    }

    if (char === '(') depth++;
    if (char === ')' && depth > 0) depth--;

    if (depth !== 0) continue;

    if (char === ';') {
      units.push(sqlText.slice(start, index));
      start = index + 1;
      continue;
    }

    const setMatch = setOperatorMatch(sqlText, index);
    if (setMatch) {
      units.push(sqlText.slice(start, index));
      index += setMatch[0].length - 1;
      start = index + 1;
    }
  }

  units.push(sqlText.slice(start));

  return units
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function hasReadOrMutationStatement(sqlText: string): boolean {
  return /\b(select|update|delete)\b/i.test(sqlText);
}

function predicateClauses(sqlText: string): string[] {
  const normalizedSql = normalizeSql(stripSelectSubqueries(sqlText));
  return normalizedSql.match(
    /\b(?:where|on|having)\b[\s\S]*?(?=\b(?:where|on|having|group\s+by|order\s+by|limit|offset|returning|union|except|intersect)\b|$)/gi,
  ) ?? [];
}

function boundValuePattern(): string {
  return String.raw`(?:\$\{[^}]+\}|\$\d+)(?:\s*::\s*[a-z_][\w]*(?:\[\])?)?`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function qualifiedIdentifier(alias: string, column: string): string {
  return String.raw`(?<![\w$])"?${escapeRegExp(alias)}"?\s*\.\s*"?${column}"?`;
}

function unqualifiedIdentifier(column: string): string {
  return String.raw`(?<![\w$.])"?${column}"?`;
}

function keywordAt(sqlText: string, index: number, keyword: string): boolean {
  if (sqlText.slice(index, index + keyword.length).toLowerCase() !== keyword) return false;

  const before = sqlText[index - 1];
  const after = sqlText[index + keyword.length];
  return (before === undefined || !/[\w$]/.test(before))
    && (after === undefined || !/[\w$]/.test(after));
}

function splitTopLevelAnd(sqlText: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;

  for (let index = 0; index < sqlText.length; index++) {
    const char = sqlText[index];

    if (char === "'") {
      index++;
      while (index < sqlText.length) {
        if (sqlText[index] === "'" && sqlText[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (sqlText[index] === "'") break;
        index++;
      }
      continue;
    }

    if (char === '(') depth++;
    if (char === ')' && depth > 0) depth--;
    if (depth !== 0) continue;

    if (keywordAt(sqlText, index, 'and')) {
      parts.push(sqlText.slice(start, index));
      index += 'and'.length - 1;
      start = index + 1;
    }
  }

  parts.push(sqlText.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function hasBoundIdentifierPredicate(clauses: string[], identifiers: string[]): boolean {
  const boundValue = boundValuePattern();
  const patterns = identifiers.flatMap((identifier) => [
    new RegExp(String.raw`${identifier}\s*=\s*${boundValue}(?=\s|,|\)|;|$)`, 'i'),
    new RegExp(String.raw`${identifier}\s+\bin\b\s*\(\s*${boundValue}`, 'i'),
    new RegExp(String.raw`${identifier}\s*=\s*\b(?:any|some)\s*\(\s*${boundValue}`, 'i'),
    new RegExp(String.raw`${boundValue}\s*=\s*${identifier}(?=\s|,|\)|;|$)`, 'i'),
  ]);

  return clauses
    .flatMap(splitTopLevelAnd)
    .some((part) => {
      if (/\bor\b/i.test(part) || /\bnot\b/i.test(part)) return false;
      return patterns.some((pattern) => pattern.test(part));
    });
}

function tableAliases(sqlText: string, table: string): string[] {
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tableName = `(?:"${escapedTable}"|${escapedTable})`;
  const schemaPrefix = `(?:(?:"public"|public)\\s*\\.\\s*)?`;
  const tableRef = String.raw`\b(?:from|join|update|delete\s+from|using)\s+(?:only\s+)?${schemaPrefix}${tableName}(?:\s+(?:as\s+)?("?[\w$]+"?))?`;
  const aliases = new Set<string>([table]);

  for (const match of sqlText.matchAll(new RegExp(tableRef, 'gi'))) {
    const alias = match[1]?.replace(/^"|"$/g, '');
    if (!alias) continue;
    if (/^(where|on|join|left|right|inner|outer|full|cross|using|set|returning|for|order|group|limit|offset)$/i.test(alias)) {
      continue;
    }
    aliases.add(alias);
  }

  return Array.from(aliases);
}

function hasIdentifierRelationship(
  clauses: string[],
  leftIdentifier: string,
  rightIdentifier: string,
): boolean {
  const leftToRight = new RegExp(String.raw`${leftIdentifier}\s*=\s*${rightIdentifier}`, 'i');
  const rightToLeft = new RegExp(String.raw`${rightIdentifier}\s*=\s*${leftIdentifier}`, 'i');
  return clauses
    .flatMap(splitTopLevelAnd)
    .some((part) => {
      if (/\bor\b/i.test(part) || /\bnot\b/i.test(part)) return false;
      return leftToRight.test(part) || rightToLeft.test(part);
    });
}

function referencedTenantTables(sqlText: string): TenantTable[] {
  return TENANT_TABLES.filter((table) => referencesTenantTable(sqlText, table));
}

function accountAliasScoped(clauses: string[], alias: string, allowUnqualified: boolean): boolean {
  const identifiers = [qualifiedIdentifier(alias, 'id')];
  if (allowUnqualified) identifiers.push(unqualifiedIdentifier('id'));
  return hasBoundIdentifierPredicate(clauses, identifiers);
}

function businessAliasDirectlyScoped(
  clauses: string[],
  alias: string,
  allowUnqualified: boolean,
): boolean {
  const identifiers = [
    qualifiedIdentifier(alias, 'id'),
    qualifiedIdentifier(alias, 'account_id'),
  ];
  if (allowUnqualified) {
    identifiers.push(unqualifiedIdentifier('id'), unqualifiedIdentifier('account_id'));
  }
  return hasBoundIdentifierPredicate(clauses, identifiers);
}

function businessAliasScoped(
  sqlText: string,
  clauses: string[],
  businessAlias: string,
  allowUnqualified: boolean,
): boolean {
  if (businessAliasDirectlyScoped(clauses, businessAlias, allowUnqualified)) return true;

  for (const accountAlias of tableAliases(sqlText, 'accounts')) {
    const accountScoped = accountAliasScoped(
      clauses,
      accountAlias,
      tableAliases(sqlText, 'accounts').length === 1,
    );
    if (!accountScoped) continue;
    if (hasIdentifierRelationship(
      clauses,
      qualifiedIdentifier(businessAlias, 'account_id'),
      qualifiedIdentifier(accountAlias, 'id'),
    )) {
      return true;
    }
  }

  return false;
}

function tenantAliasDirectlyScoped(
  clauses: string[],
  alias: string,
  allowUnqualified: boolean,
): boolean {
  const identifiers = [
    qualifiedIdentifier(alias, 'account_id'),
    qualifiedIdentifier(alias, 'business_id'),
  ];
  if (allowUnqualified) {
    identifiers.push(unqualifiedIdentifier('account_id'), unqualifiedIdentifier('business_id'));
  }
  return hasBoundIdentifierPredicate(clauses, identifiers);
}

function hasTenantScopeForTable(
  sqlText: string,
  table: TenantTable,
  referencedTables: readonly TenantTable[],
): boolean {
  const clauses = predicateClauses(sqlText);
  const aliases = tableAliases(sqlText, table);
  const allowUnqualified = aliases.length === 1 && referencedTables.length === 1;

  if (table === 'accounts') {
    if (aliases.some((alias) => accountAliasScoped(clauses, alias, aliases.length === 1))) {
      return true;
    }
    for (const businessAlias of tableAliases(sqlText, 'businesses')) {
      if (!businessAliasDirectlyScoped(clauses, businessAlias, false)) continue;
      if (aliases.some((accountAlias) => hasIdentifierRelationship(
        clauses,
        qualifiedIdentifier(businessAlias, 'account_id'),
        qualifiedIdentifier(accountAlias, 'id'),
      ))) {
        return true;
      }
    }
    return false;
  }

  if (table === 'businesses') {
    return aliases.some((alias) => businessAliasScoped(sqlText, clauses, alias, aliases.length === 1));
  }

  if (aliases.some((alias) => tenantAliasDirectlyScoped(clauses, alias, allowUnqualified))) {
    return true;
  }

  for (const alias of aliases) {
    for (const accountAlias of tableAliases(sqlText, 'accounts')) {
      const relatedToAccount = hasIdentifierRelationship(
        clauses,
        qualifiedIdentifier(alias, 'account_id'),
        qualifiedIdentifier(accountAlias, 'id'),
      );
      if (!relatedToAccount) continue;
      if (accountAliasScoped(clauses, accountAlias, false)) return true;
    }

    for (const businessAlias of tableAliases(sqlText, 'businesses')) {
      const relatedToBusiness = hasIdentifierRelationship(
        clauses,
        qualifiedIdentifier(alias, 'business_id'),
        qualifiedIdentifier(businessAlias, 'id'),
      );
      if (!relatedToBusiness) continue;
      if (businessAliasScoped(sqlText, clauses, businessAlias, false)) return true;
    }
  }

  return false;
}

function referencesTenantTable(sqlText: string, table: string): boolean {
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tableName = `(?:"${escapedTable}"|${escapedTable})`;
  const schemaPrefix = `(?:(?:"public"|public)\\s*\\.\\s*)?`;
  const tableBoundary = '(?=\\s|\\(|,|;|$)';
  const patterns = [
    `\\bfrom\\s+(?:only\\s+)?${schemaPrefix}${tableName}${tableBoundary}`,
    `\\bjoin\\s+${schemaPrefix}${tableName}${tableBoundary}`,
    `\\bupdate\\s+(?:only\\s+)?${schemaPrefix}${tableName}${tableBoundary}`,
    `\\bdelete\\s+from\\s+(?:only\\s+)?${schemaPrefix}${tableName}${tableBoundary}`,
    `\\busing\\s+${schemaPrefix}${tableName}${tableBoundary}`,
  ];

  return patterns.some((pattern) => new RegExp(pattern, 'i').test(sqlText));
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

export function auditSqlText(
  file: string,
  sqlText: string,
  usedAllowlistKeys?: Set<string>,
): TenantScopeFinding[] {
  const normalizedFile = normalizePath(file);
  const sqlForScan = stripSqlComments(sqlText);
  if (!hasReadOrMutationStatement(sqlForScan)) return [];

  const findings: TenantScopeFinding[] = [];
  for (const sqlUnit of splitSqlUnits(sqlForScan)) {
    if (!hasReadOrMutationStatement(sqlUnit)) continue;
    const referencedTables = referencedTenantTables(sqlUnit);
    for (const table of referencedTables) {
      const unitAllowlistEntry = getAllowlistEntry(normalizedFile, table, sqlUnit);
      if (unitAllowlistEntry) {
        usedAllowlistKeys?.add(allowlistKey(unitAllowlistEntry));
      }
      if (hasTenantScopeForTable(sqlUnit, table, referencedTables)) continue;
      if (unitAllowlistEntry) {
        continue;
      }

      findings.push({
        file: normalizedFile,
        table,
        reason: UNSCOPED_REASON,
      });
    }
  }

  const templateReferencedTables = referencedTenantTables(sqlForScan);
  for (const table of templateReferencedTables) {
    const templateAllowlistEntry = getAllowlistEntry(normalizedFile, table, sqlForScan);
    if (templateAllowlistEntry && findings.every((finding) => finding.table !== table)) {
      usedAllowlistKeys?.add(allowlistKey(templateAllowlistEntry));
    }
  }

  return findings;
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

export function extractSqlTemplates(sourceText: string): ExtractedSqlTemplate[] {
  const templates: ExtractedSqlTemplate[] = [];
  const sqlTagNames = extractSqlTagNames(sourceText);
  const tagPattern = Array.from(sqlTagNames).map(escapeRegExp).join('|');
  const tagRegex = new RegExp(
    `(?<![\\w$])(${tagPattern})(?:\\s*<[^\`]+>)?\\s*\``,
    'g',
  );
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(sourceText)) !== null) {
    const templateStart = sourceText.indexOf('`', match.index);
    if (templateStart < 0) continue;
    const tag = match[1] ?? 'sql';
    const parsed = parseTemplateLiteral(sourceText, templateStart);
    if (!parsed) continue;
    templates.push({ tag, sqlText: parsed.sqlText });
    tagRegex.lastIndex = parsed.endIndex + 1;
  }

  templates.push(...extractUnsafeSqlTemplates(sourceText, sqlTagNames));

  return templates;
}

function extractSqlTagNames(sourceText: string): Set<string> {
  const tagNames = new Set<string>(['sql', 'tx', 'db']);
  const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]@\/lib\/db\/server['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(sourceText)) !== null) {
    const imports = match[1] ?? '';
    for (const specifier of imports.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/i);
      if (parts[0]?.trim() !== 'sql') continue;
      tagNames.add(parts[1]?.trim() || 'sql');
    }
  }

  return tagNames;
}

function parseTemplateLiteral(
  sourceText: string,
  templateStart: number,
): { sqlText: string; endIndex: number } | null {
  let depth = 0;
  let template = '';
  for (let index = templateStart + 1; index < sourceText.length; index++) {
    const current = sourceText[index];
    const next = sourceText[index + 1];

    if (current === '\\') {
      template += current;
      if (next !== undefined) {
        template += next;
        index++;
      }
      continue;
    }

    if (current === '$' && next === '{') {
      depth++;
      template += '${';
      index++;
      continue;
    }

    if (current === '}' && depth > 0) {
      depth--;
      template += current;
      continue;
    }

    if (current === '`' && depth === 0) {
      return { sqlText: template, endIndex: index };
    }

    template += current;
  }

  return null;
}

function parseStringLiteral(
  sourceText: string,
  stringStart: number,
): { sqlText: string; endIndex: number } | null {
  const quote = sourceText[stringStart];
  if (quote !== '"' && quote !== "'") return null;

  let value = '';
  for (let index = stringStart + 1; index < sourceText.length; index++) {
    const current = sourceText[index];
    const next = sourceText[index + 1];
    if (current === '\\') {
      value += current;
      if (next !== undefined) {
        value += next;
        index++;
      }
      continue;
    }
    if (current === quote) {
      return { sqlText: value, endIndex: index };
    }
    value += current;
  }

  return null;
}

function extractNamedSqlTemplates(sourceText: string): NamedSqlTemplate[] {
  const namedTemplates: NamedSqlTemplate[] = [];
  const declarationRegex = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([`"'])/g;
  let match: RegExpExecArray | null;

  while ((match = declarationRegex.exec(sourceText)) !== null) {
    const name = match[1];
    if (!name) continue;
    const literalStart = skipWhitespace(sourceText, declarationRegex.lastIndex - 1);
    const literalStartChar = sourceText[literalStart];
    const parsed = literalStartChar === '`'
      ? parseTemplateLiteral(sourceText, literalStart)
      : parseStringLiteral(sourceText, literalStart);
    if (!parsed) continue;
    namedTemplates.push({ name, sqlText: parsed.sqlText, index: match.index });
    declarationRegex.lastIndex = parsed.endIndex + 1;
  }

  return namedTemplates;
}

function resolveNamedSqlTemplate(
  namedTemplates: readonly NamedSqlTemplate[],
  name: string,
  beforeIndex: number,
): string | null {
  const matching = namedTemplates
    .filter((template) => template.name === name && template.index < beforeIndex)
    .sort((left, right) => right.index - left.index);

  return matching[0]?.sqlText ?? null;
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
  sourceText: string,
  sqlTagNames: ReadonlySet<string>,
): ExtractedSqlTemplate[] {
  const templates: ExtractedSqlTemplate[] = [];
  const namedTemplates = extractNamedSqlTemplates(sourceText);
  const unsafeRegex = new RegExp(
    String.raw`(?<![\w$])(${Array.from(sqlTagNames).map(escapeRegExp).join('|')})\s*\.\s*unsafe(?:\s*<[^>(]+(?:\([^)]*\))?[^>]*>)?\s*\(`,
    'g',
  );
  let match: RegExpExecArray | null;

  while ((match = unsafeRegex.exec(sourceText)) !== null) {
    const tag = `${match[1] ?? 'sql'}.unsafe`;
    const argStart = skipWhitespace(sourceText, unsafeRegex.lastIndex);
    const argStartChar = sourceText[argStart];
    if (argStartChar === '`') {
      const parsed = parseTemplateLiteral(sourceText, argStart);
      if (parsed) {
        templates.push({ tag, sqlText: parsed.sqlText });
        unsafeRegex.lastIndex = parsed.endIndex + 1;
      }
      continue;
    }

    if (argStartChar === '"' || argStartChar === "'") {
      const parsed = parseStringLiteral(sourceText, argStart);
      if (parsed) {
        templates.push({ tag, sqlText: parsed.sqlText });
        unsafeRegex.lastIndex = parsed.endIndex + 1;
      }
      continue;
    }

    const identifier = readIdentifier(sourceText, argStart);
    if (!identifier) continue;
    const sqlText = resolveNamedSqlTemplate(namedTemplates, identifier, match.index);
    if (sqlText) templates.push({ tag, sqlText });
  }

  return templates;
}

async function auditRepository(): Promise<TenantScopeFinding[]> {
  const allFiles = (await Promise.all(SCANNED_ROOTS.map((root) => collectSourceFiles(root)))).flat();
  const findings: TenantScopeFinding[] = [];
  const usedAllowlistKeys = new Set<string>();

  for (const file of allFiles.sort()) {
    const sourceText = await readFile(file, 'utf8');
    for (const { sqlText } of extractSqlTemplates(sourceText)) {
      findings.push(...auditSqlText(
        normalizePath(relative(process.cwd(), file)),
        sqlText,
        usedAllowlistKeys,
      ));
    }
  }

  return [
    ...findDuplicateAllowlistEntries(),
    ...findUnusedAllowlistEntries(usedAllowlistKeys),
    ...findings,
  ];
}

async function main(): Promise<void> {
  const findings = await auditRepository();
  if (findings.length > 0) {
    console.error('tenant-scope-audit: failed');
    for (const finding of findings) {
      console.error(`${finding.file}: ${finding.table}: ${finding.reason}`);
    }
    process.exit(1);
  }

  console.log('tenant-scope-audit: passed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('tenant-scope-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
