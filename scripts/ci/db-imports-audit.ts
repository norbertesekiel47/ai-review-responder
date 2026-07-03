// scripts/ci/db-imports-audit.ts
//
// Ratchet guard for the A+ campaign's DB-injection convention (spec
// docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md §2.1):
// domain modules receive `sql` / `supabaseServer` as explicit parameters; only
// COMPOSITION ROOTS may import the singleton module src/lib/db/server. Every
// current non-root importer is in DB_IMPORTS_BASELINE; CI fails on a NEW
// importer or a stale entry. The baseline shrinks to 0 over the Stage-2 domain
// sweeps; Stage 3 then deletes it and the allowlist becomes strict.
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { DB_IMPORTS_BASELINE } from './db-imports-baseline';

const SCAN_DIRS = ['src', 'worker'] as const;
const SCAN_EXT = /\.(?:ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next', 'coverage', '__fixtures__']);
const SKIP_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;

function normalize(file: string): string {
  return file.split(sep).join('/');
}

/**
 * True when `spec` (a static import/export module specifier string) points at
 * the db/server singleton module — the aliased form (`@/lib/db/server`) or any
 * relative form ending in `db/server` (e.g. `../../db/server`). An
 * extension-qualified specifier (`@/lib/db/server.js` / `../../db/server.ts`)
 * resolves to the same module, so the `.js`/`.ts` suffix is stripped before
 * matching. A specifier that merely SHARES the prefix (`@/lib/db/server-utils`,
 * with or without extension) does not match: the relative form requires
 * `db/server` to be the full trailing path segment.
 */
function isDbServerSpecifier(spec: string): boolean {
  const withoutExtension = spec.replace(/\.(?:js|ts)$/, '');
  return withoutExtension === '@/lib/db/server' || /(^|\/)db\/server$/.test(withoutExtension);
}

/**
 * Top-level files in root-classed directories that are NOT entry points —
 * helpers that live beside the handlers they serve. Named explicitly (no
 * filename heuristics): position grants root status; these are the known
 * exceptions. A Stage-2 sweep migrates them onto parameter injection.
 */
const NON_ROOT_EXCEPTIONS = new Set(['worker/jobs/summary-report-helpers.ts']);

/**
 * True when the file is a composition root that may import the db/server
 * singleton directly and pass `sql`/`supabaseServer` down (spec §2.1): the
 * singleton owner itself, `src/instrumentation.ts`, Next.js route handlers /
 * server-component pages / layouts (Next.js invokes all three — no caller
 * exists that could inject a client, incl. at the `src/app/` root), and
 * worker entry points — top-level job handlers (`worker/jobs/<File>.ts`, NOT
 * a subfolder helper like `worker/jobs/publisher/post-reply.ts`),
 * `worker/index.ts` / `worker/queues.ts`, top-level poller/scheduler boot
 * files (`worker/background/{pollers,schedulers}/<File>.ts` — subfolder
 * helpers like `pollers/health-alert/checks.ts` are domain modules and belong
 * in the baseline), and every file under `worker/ingress/`. The ingress
 * exemption stays a blanket on purpose: per-event ingress handlers
 * legitimately live in provider subfolders (`ingress/stripe/*.ts`, …), so
 * path shape can't separate a handler from a helper there — the ~3 shared
 * helpers that ride along are an accepted width cost. NON_ROOT_EXCEPTIONS
 * overrides all positional rules for known top-level helpers.
 * Pure — unit-tested.
 */
export function isCompositionRoot(file: string): boolean {
  if (NON_ROOT_EXCEPTIONS.has(file)) return false;
  if (file === 'src/lib/db/server.ts' || file === 'src/instrumentation.ts') return true;
  if (/^src\/app\/(?:.*\/)?route\.ts$/.test(file)) return true;
  if (/^src\/app\/(?:.*\/)?page\.tsx$/.test(file)) return true;
  if (/^src\/app\/(?:.*\/)?layout\.tsx$/.test(file)) return true;
  if (/^worker\/(?:index|queues)\.ts$/.test(file)) return true;
  if (/^worker\/jobs\/[^/]+\.ts$/.test(file)) return true;
  if (/^worker\/background\/(?:pollers|schedulers)\/[^/]+\.ts$/.test(file)) return true;
  if (/^worker\/ingress\//.test(file)) return true;
  return false;
}

/**
 * True when an ImportDeclaration carries a RUNTIME dependency on its module:
 * a default binding, a namespace binding, a named specifier without an inline
 * `type` keyword, no import clause at all (a bare side-effect import
 * statement still executes the module), or EMPTY braces — a non-type-only
 * import declaration always evaluates the target module regardless of
 * bindings, and db/server constructs the pool at import. Only a
 * statement-level `import type` or braces containing EXCLUSIVELY
 * inline-`type` specifiers (`import { type Sql } from ...`) are runtime-free
 * (TypeScript elides the whole declaration).
 */
function importBindsRuntimeValue(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return true;
  if (ts.isNamespaceImport(bindings)) return true;
  if (bindings.elements.length === 0) return true;
  return bindings.elements.some((specifier) => !specifier.isTypeOnly);
}

/**
 * True when an ExportDeclaration carries a RUNTIME dependency on its module:
 * `export * from`, `export * as ns from`, a named specifier without an inline
 * `type` keyword, or EMPTY braces — a non-type-only re-export declaration
 * always evaluates the target module regardless of bindings. Only a
 * statement-level `export type` or braces containing EXCLUSIVELY
 * inline-`type` specifiers (`export { type Sql } from ...`) are runtime-free.
 */
function exportBindsRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (!clause) return true;
  if (ts.isNamespaceExport(clause)) return true;
  if (clause.elements.length === 0) return true;
  return clause.elements.some((specifier) => !specifier.isTypeOnly);
}

/**
 * The specifier text of a dynamic import call whose FIRST argument is a
 * string literal, else null (computed specifiers return null). Accepts extra
 * arguments so the import-attributes form (a second options argument) is
 * still caught.
 */
function literalDynamicImportSpecifier(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  if (node.arguments.length < 1) return null;
  const argument = node.arguments[0];
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : null;
}

/**
 * True when this AST node wires a runtime dependency on db/server: a value
 * import declaration, a value re-export declaration, or a literal dynamic
 * import call targeting the module.
 */
function nodeDependsOnDbServer(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    return (
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isDbServerSpecifier(node.moduleSpecifier.text) &&
      importBindsRuntimeValue(node)
    );
  }
  if (ts.isExportDeclaration(node)) {
    return (
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isDbServerSpecifier(node.moduleSpecifier.text) &&
      exportBindsRuntimeValue(node)
    );
  }
  const dynamicSpecifier = literalDynamicImportSpecifier(node);
  return dynamicSpecifier !== null && isDbServerSpecifier(dynamicSpecifier);
}

/**
 * True if the file's AST contains a RUNTIME-value dependency on the db/server
 * singleton: an `import`/`export ... from` declaration binding at least one
 * value (statement-level `import type`/`export type` AND inline
 * `{ type Sql }` specifiers are excluded — they carry no runtime dependency),
 * or a literal dynamic import call naming the module. Parses with the
 * TypeScript compiler (mirrors process-env-audit / response-status-audit /
 * static-policy-audit) so a `"@/lib/db/server"` string literal or comment
 * can't false-fire. A value re-export (`export { sql } from
 * '@/lib/db/server'`) counts: it still wires a non-root module to the
 * singleton's runtime value. Literal dynamic imports count; only COMPUTED
 * specifiers (`import(someVar)`, concatenations) are out of scope — none
 * exist for db/server today. Pure — unit-tested.
 */
export function fileImportsDbServer(text: string): boolean {
  const source = ts.createSourceFile(
    'scan.tsx',
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (nodeDependsOnDbServer(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export interface EvaluateInput {
  importingFiles: ReadonlySet<string>;
  baseline?: ReadonlySet<string>;
}

/** Compare the live importing-file set against the baseline. Pure — unit-tested. */
export function evaluateFindings(input: EvaluateInput): string[] {
  const baseline = input.baseline ?? DB_IMPORTS_BASELINE;
  const findings: string[] = [];
  for (const file of input.importingFiles) {
    if (isCompositionRoot(file)) continue;
    if (!baseline.has(file)) {
      findings.push(
        `${file} imports @/lib/db/server but is not a composition root — accept sql/supabaseServer as an explicit parameter instead (spec §2.1 — docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md)`,
      );
    }
  }
  for (const file of baseline) {
    if (!input.importingFiles.has(file)) {
      findings.push(
        `${file} is in DB_IMPORTS_BASELINE but no longer imports @/lib/db/server — remove the stale baseline entry (the baseline shrinks to 0 over the Stage-2 domain sweeps)`,
      );
    }
  }
  return findings;
}

async function collectFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(join(dir, entry.name), root, out);
    } else if (entry.isFile() && SCAN_EXT.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(normalize(relative(root, join(dir, entry.name))));
    }
  }
}

export async function collectImportingFiles(root: string): Promise<Set<string>> {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) await collectFiles(resolve(root, dir), root, files);
  const importing = new Set<string>();
  for (const file of files) {
    if (isCompositionRoot(file)) continue;
    if (fileImportsDbServer(await readFile(resolve(root, file), 'utf8'))) importing.add(file);
  }
  return importing;
}

/**
 * Renders the full `db-imports-baseline.ts` module source from the given
 * non-composition-root importer files: header comment (spec reference,
 * regeneration command, do-not-hand-edit notice) followed by the sorted,
 * quoted `DB_IMPORTS_BASELINE` entries. Pure — unit-tested; `emitBaseline`
 * writes the result to disk.
 */
export function renderBaselineModule(files: readonly string[]): string {
  const entries = [...files].sort();
  const lines = [
    '// scripts/ci/db-imports-baseline.ts',
    '//',
    '// Committed baseline: non-composition-root files (spec',
    '// docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md §2.1)',
    '// that import the src/lib/db/server singleton TODAY. Generated by the audit\'s',
    '// own scan — regenerate with:',
    '//   pnpm tsx scripts/ci/db-imports-audit.ts --emit-baseline',
    '// (writes this file atomically — tmp file + rename — so a partial run never',
    '// leaves a half-written baseline).',
    '// Do NOT hand-edit entries. Shrinks to 0 over the Stage-2 domain sweeps as each domain',
    '// module is converted to take `sql`/`supabaseServer` as an explicit parameter;',
    '// Stage 3 then deletes this file and the guard becomes a strict',
    '// composition-root allowlist. Adding a NEW importer requires migrating it',
    '// instead — that is the point of this guard.',
    '',
    'export const DB_IMPORTS_BASELINE: ReadonlySet<string> = new Set([',
    ...entries.map((entry) => `  '${entry}',`),
    ']);',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Writes the regenerated baseline module to `scripts/ci/db-imports-baseline.ts`
 * atomically: the full source is written to a co-located `.tmp` file, then
 * `rename`d into place. A crash mid-write leaves only the `.tmp` file — never
 * a half-written baseline — since `rename` is a single filesystem operation.
 */
async function emitBaseline(importing: ReadonlySet<string>, root: string): Promise<void> {
  const source = renderBaselineModule([...importing]);
  const target = resolve(root, 'scripts/ci/db-imports-baseline.ts');
  const tmp = `${target}.tmp`;
  await writeFile(tmp, source);
  await rename(tmp, target);
  console.log(`db-imports-audit: baseline regenerated (${importing.size} entries)`);
}

async function main(): Promise<void> {
  const root = process.cwd();
  const importing = await collectImportingFiles(root);
  if (process.argv.includes('--emit-baseline')) {
    await emitBaseline(importing, root);
    return;
  }
  const findings = evaluateFindings({ importingFiles: importing });
  if (findings.length > 0) {
    console.error('db-imports-audit: failed');
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log(
    `db-imports-audit: passed (baseline ${DB_IMPORTS_BASELINE.size} files importing db/server outside composition roots)`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('db-imports-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
