import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tenantScopeAllowlist, type TenantScopeAllowlistEntry } from './tenant-scope-allowlist';

export interface TenantScopeFinding {
  file: string;
  table: string;
  reason: string;
}

const TENANT_TABLES = [
  'accounts',
  'businesses',
  'reviews',
  'responses',
  'approval_links',
  'approval_audit_log',
  'account_audit_log',
  'notification_deliveries',
  'api_costs',
  'review_exceptions',
  'ranking_snapshots',
  'zernio_connections',
] as const;

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

function normalizeSql(sqlText: string): string {
  return sqlText.replace(/\s+/g, ' ').trim();
}

function hasReadOrMutationStatement(sqlText: string): boolean {
  return /\b(select|update|delete)\b/i.test(sqlText);
}

function predicateClauses(sqlText: string): string[] {
  const normalizedSql = normalizeSql(sqlText);
  return normalizedSql.match(
    /\b(?:where|on|having)\b[\s\S]*?(?=\b(?:where|on|having|group\s+by|order\s+by|limit|offset|returning|union|except|intersect)\b|$)/gi,
  ) ?? [];
}

function boundValuePattern(): string {
  return String.raw`(?:\$\{[^}]+\}|\$\d+)(?:\s*::\s*[a-z_][\w]*(?:\[\])?)?`;
}

function hasBoundIdentifierPredicate(clauses: string[], identifier: string): boolean {
  const boundValue = boundValuePattern();
  const leftHandScope = [
    new RegExp(String.raw`${identifier}\s*=\s*${boundValue}(?=\s|,|\)|;|$)`, 'i'),
    new RegExp(String.raw`${identifier}\s+\bin\b\s*\(\s*${boundValue}`, 'i'),
    new RegExp(String.raw`${identifier}\s*=\s*\b(?:any|some)\s*\(\s*${boundValue}`, 'i'),
  ];
  const rightHandScope = new RegExp(
    String.raw`${boundValue}\s*=\s*${identifier}(?=\s|,|\)|;|$)`,
    'i',
  );

  return clauses.some((clause) =>
    leftHandScope.some((pattern) => pattern.test(clause)) || rightHandScope.test(clause),
  );
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

function hasTenantScope(sqlText: string): boolean {
  const clauses = predicateClauses(sqlText);
  const tenantColumnIdentifier = String.raw`(?:"?[a-z_][\w$]*"?\s*\.\s*)?"?(?:account_id|business_id)"?`;
  if (hasBoundIdentifierPredicate(clauses, tenantColumnIdentifier)) return true;

  if (referencesTenantTable(sqlText, 'accounts')) {
    for (const alias of tableAliases(sqlText, 'accounts')) {
      const identifier = String.raw`(?:(?:"?${alias}"?\s*\.\s*)?)"?id"?`;
      if (hasBoundIdentifierPredicate(clauses, identifier)) return true;
    }
  }

  if (referencesTenantTable(sqlText, 'businesses')) {
    for (const alias of tableAliases(sqlText, 'businesses')) {
      const identifier = String.raw`(?:(?:"?${alias}"?\s*\.\s*)?)"?id"?`;
      if (hasBoundIdentifierPredicate(clauses, identifier)) return true;
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
  const normalizedSql = normalizeSql(sqlText);
  return tenantScopeAllowlist.find(
    (entry) => entry.file === file
      && entry.table === table
      && entry.reason.trim().length > 0
      && typeof entry.sqlSnippet === 'string'
      && normalizeSql(stripSqlComments(entry.sqlSnippet)).length > 0
      && normalizedSql.includes(normalizeSql(stripSqlComments(entry.sqlSnippet))),
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
  const scoped = hasTenantScope(sqlForScan);
  for (const table of TENANT_TABLES) {
    if (!referencesTenantTable(sqlForScan, table)) continue;
    const allowlistEntry = getAllowlistEntry(normalizedFile, table, sqlForScan);
    if (allowlistEntry) {
      usedAllowlistKeys?.add(allowlistKey(allowlistEntry));
    }
    if (scoped) continue;
    if (allowlistEntry) {
      continue;
    }

    findings.push({
      file: normalizedFile,
      table,
      reason: UNSCOPED_REASON,
    });
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

function extractSqlTemplates(sourceText: string): string[] {
  const templates: string[] = [];
  const tagRegex = /\bsql(?:\s*<[^`]+>)?\s*`/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(sourceText)) !== null) {
    const templateStart = sourceText.indexOf('`', match.index);
    if (templateStart < 0) continue;

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
        templates.push(template);
        tagRegex.lastIndex = index + 1;
        break;
      }

      template += current;
    }
  }

  return templates;
}

async function auditRepository(): Promise<TenantScopeFinding[]> {
  const allFiles = (await Promise.all(SCANNED_ROOTS.map((root) => collectSourceFiles(root)))).flat();
  const findings: TenantScopeFinding[] = [];
  const usedAllowlistKeys = new Set<string>();

  for (const file of allFiles.sort()) {
    const sourceText = await readFile(file, 'utf8');
    for (const sqlText of extractSqlTemplates(sourceText)) {
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
