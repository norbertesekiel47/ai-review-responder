import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tenantScopeAllowlist } from './tenant-scope-allowlist';

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
  'zernio_connections',
] as const;

const SCANNED_ROOTS = ['src', 'worker'] as const;
const UNSCOPED_REASON = 'missing account_id or business_id scope';
const ID_PREDICATE = String.raw`\b(?:[a-z_][a-z0-9_]*\s*\.\s*)?id\s*(?:=|IN\b|=\s*ANY\b)`;
const TABLE_IDENTITY_SCOPE_PATTERNS: Record<(typeof TENANT_TABLES)[number], RegExp[]> = {
  accounts: [new RegExp(ID_PREDICATE, 'i'), /\bstripe_(customer|subscription)_id\b/i],
  businesses: [new RegExp(ID_PREDICATE, 'i'), /\bonboarded_by\b/i],
  reviews: [new RegExp(ID_PREDICATE, 'i'), /\bprovider_review_id\b/i],
  responses: [new RegExp(ID_PREDICATE, 'i'), /\breview_id\b/i],
  approval_links: [new RegExp(ID_PREDICATE, 'i'), /\b(response_id|token_hash)\b/i],
  approval_audit_log: [new RegExp(ID_PREDICATE, 'i'), /\b(response_id|approval_link_id)\b/i],
  account_audit_log: [new RegExp(ID_PREDICATE, 'i')],
  notification_deliveries: [new RegExp(ID_PREDICATE, 'i'), /\b(response_id|external_message_id)\b/i],
  api_costs: [new RegExp(ID_PREDICATE, 'i')],
  zernio_connections: [new RegExp(ID_PREDICATE, 'i'), /\b(zernio_account_id|zernio_location_id)\b/i],
};

function normalizePath(file: string): string {
  return file.split(sep).join('/');
}

function stripSqlComments(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ');
}

function hasReadOrMutationStatement(sqlText: string): boolean {
  return /\b(select|update|delete)\b/i.test(sqlText);
}

function hasTenantScope(sqlText: string): boolean {
  return /\b(account_id|business_id)\b/i.test(sqlText);
}

function hasTableIdentityScope(sqlText: string, table: (typeof TENANT_TABLES)[number]): boolean {
  return TABLE_IDENTITY_SCOPE_PATTERNS[table].some((pattern) => pattern.test(sqlText));
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

function hasAllowlistEntry(file: string, table: string): boolean {
  return tenantScopeAllowlist.some(
    (entry) => entry.file === file && entry.table === table && entry.reason.trim().length > 0,
  );
}

export function auditSqlText(file: string, sqlText: string): TenantScopeFinding[] {
  const normalizedFile = normalizePath(file);
  const sqlForScan = stripSqlComments(sqlText);
  if (!hasReadOrMutationStatement(sqlForScan)) return [];
  if (hasTenantScope(sqlForScan)) return [];

  const findings: TenantScopeFinding[] = [];
  for (const table of TENANT_TABLES) {
    if (!referencesTenantTable(sqlForScan, table)) continue;
    if (hasTableIdentityScope(sqlForScan, table)) continue;
    if (hasAllowlistEntry(normalizedFile, table)) continue;

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

  for (const file of allFiles.sort()) {
    const sourceText = await readFile(file, 'utf8');
    for (const sqlText of extractSqlTemplates(sourceText)) {
      findings.push(...auditSqlText(normalizePath(relative(process.cwd(), file)), sqlText));
    }
  }

  return findings;
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
