// scripts/ci/db-imports-audit.ts
//
// STRICT guard for the A+ campaign's DB-injection convention (spec
// docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md §2.1):
// domain modules receive `sql` / `supabaseServer` as explicit parameters; only
// COMPOSITION ROOTS may import the singleton module src/lib/db/server. The
// Stage-2 domain sweeps drove the baseline to 0; Stage 3 (this guard) deleted
// the baseline and now fails CI on ANY non-composition-root file that imports
// db/server. Worker composition roots are DERIVED from worker/index.ts
// registration (see readRegisteredWorkerRoots) — a top-level worker helper that
// sits beside handlers but is not registered there is NOT a root. Adding a NEW
// importer requires migrating it to parameter injection instead — that is the
// point of this guard.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { walk } from './lib/ratchet-harness';

const SCAN_DIRS = ['src', 'worker'] as const;

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
 * The module specifier of a worker composition root as it appears in a
 * `worker/index.ts` import: one directory segment (`jobs`,
 * `background/pollers`, or `background/schedulers`) followed by exactly ONE
 * more path segment (`[^/]+$`, no extension). The single-segment tail excludes
 * a subfolder handler (`./jobs/publisher/ResponsePublisherWorker` — already a
 * non-root) while capturing every top-level registered handler/poller/scheduler.
 */
const REGISTERED_WORKER_ROOT_SPECIFIER = /^\.\/(?:jobs|background\/pollers|background\/schedulers)\/[^/]+$/;

/**
 * The set of worker composition roots DERIVED from `worker/index.ts`
 * registration: the repo-relative path of every top-level job handler, poller,
 * and scheduler module the entry point imports. Parses `worker/index.ts` with
 * the TypeScript compiler (mirrors `fileImportsDbServer` — never regex the raw
 * text, which would false-fire on a comment or a string literal) and, for each
 * top-level import declaration whose string-literal specifier matches
 * REGISTERED_WORKER_ROOT_SPECIFIER, maps `./<dir>/<Name>` → `worker/<dir>/<Name>.ts`.
 * This is why root status for a worker module is EARNED by registration, not
 * granted by file position: a top-level helper beside the handlers can never
 * silently gain root status without being wired into the entry point. Only a
 * direct top-level `import … from './jobs|background/…'` counts — a barrel
 * re-export or a dynamic `import()` registration is NOT credited. That bias is
 * deliberate and fail-safe: an un-credited real handler produces a LOUD CI
 * failure (fix by importing it directly in worker/index.ts), never a silent
 * root grant to an unregistered helper. Pure — unit-tested.
 */
export function readRegisteredWorkerRoots(indexText: string): Set<string> {
  const source = ts.createSourceFile(
    'worker/index.ts',
    indexText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const roots = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    if (!REGISTERED_WORKER_ROOT_SPECIFIER.test(spec)) continue;
    // Strip any explicit extension (mirrors isDbServerSpecifier) so an
    // extension-qualified specifier still maps to the real `.ts` file.
    const specifierPath = spec.slice(2).replace(/\.(?:js|ts)$/, '');
    roots.add(`worker/${specifierPath}.ts`);
  }
  return roots;
}

/**
 * True when the file is a composition root that may import the db/server
 * singleton directly and pass `sql`/`supabaseServer` down (spec §2.1): the
 * singleton owner itself, `src/instrumentation.ts`, Next.js route handlers /
 * server-component pages / layouts (Next.js invokes all three — no caller
 * exists that could inject a client, incl. at the `src/app/` root),
 * `worker/index.ts` / `worker/queues.ts`, every file under `worker/ingress/`,
 * and every worker module REGISTERED in `worker/index.ts` (the
 * `registeredWorkerRoots` set — the top-level job handlers, pollers, and
 * schedulers the entry point imports). Root status for a worker module is
 * EARNED by registration, not granted by position: a top-level helper that
 * lives beside the handlers (e.g. `worker/jobs/summary-report-helpers.ts`) is a
 * domain module, not a root, and must take `sql`/`supabaseServer` as an
 * explicit parameter. The ingress exemption stays a blanket on purpose:
 * per-event ingress handlers legitimately live in provider subfolders
 * (`ingress/stripe/*.ts`, …), so path shape can't separate a handler from a
 * helper there — the ~3 shared helpers that ride along are an accepted width
 * cost. Pure (the registered-root set is passed in) — unit-tested.
 */
export function isCompositionRoot(file: string, registeredWorkerRoots: ReadonlySet<string>): boolean {
  if (file === 'src/lib/db/server.ts' || file === 'src/instrumentation.ts') return true;
  // Owner-decided classification (A+ campaign sweep 2i): auth.ts is a db-layer
  // auth gate — it owns a Supabase SSR client factory plus a single identity
  // SELECT and serves ~14 callers — so it is a composition root, not a domain
  // module. Named EXPLICITLY (not a `src/lib/db/*` blanket) so account-guard.ts
  // and other db-layer domain modules stay in scope.
  if (file === 'src/lib/db/auth.ts') return true;
  if (/^src\/app\/(?:.*\/)?route\.ts$/.test(file)) return true;
  if (/^src\/app\/(?:.*\/)?page\.tsx$/.test(file)) return true;
  if (/^src\/app\/(?:.*\/)?layout\.tsx$/.test(file)) return true;
  if (/^worker\/(?:index|queues)\.ts$/.test(file)) return true;
  if (registeredWorkerRoots.has(file)) return true;
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
}

/**
 * Strict evaluation: `importingFiles` is already filtered to
 * non-composition-roots by `collectImportingFiles`, so EVERY entry is a
 * failure — a non-root module that imports the db/server singleton instead of
 * taking `sql`/`supabaseServer` as an explicit parameter. Emits one "new
 * importer" message per offender. Pure — unit-tested.
 */
export function evaluateFindings(input: EvaluateInput): string[] {
  const findings: string[] = [];
  for (const file of input.importingFiles) {
    findings.push(
      `${file} imports @/lib/db/server but is not a composition root — accept sql/supabaseServer as an explicit parameter instead, OR if this IS a top-level worker handler/poller/scheduler, register it directly in worker/index.ts to earn root status (spec §2.1 — docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md)`,
    );
  }
  return findings;
}

export async function collectImportingFiles(root: string): Promise<Set<string>> {
  const files = await walk(root, { scanDirs: SCAN_DIRS });
  const registeredWorkerRoots = readRegisteredWorkerRoots(
    await readFile(resolve(root, 'worker/index.ts'), 'utf8'),
  );
  const importing = new Set<string>();
  for (const file of files) {
    if (isCompositionRoot(file, registeredWorkerRoots)) continue;
    if (fileImportsDbServer(await readFile(resolve(root, file), 'utf8'))) importing.add(file);
  }
  return importing;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const importing = await collectImportingFiles(root);
  const findings = evaluateFindings({ importingFiles: importing });
  if (findings.length > 0) {
    console.error('db-imports-audit: failed');
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log('db-imports-audit: passed (strict — no non-composition-root file imports db/server)');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('db-imports-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
