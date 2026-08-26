// scripts/blast-radius-importers.ts — the import-edge matcher behind
// scripts/blast-radius.sh (#888).
//
// Reads a NUL-separated list of changed production source paths on stdin and
// writes the blast-radius markdown report to stdout: for every changed file,
// the files that actually IMPORT it. The old implementation grepped for bare
// substrings, so any file named `route.ts` reported every other route as an
// importer (82 phantom importers on #872). This one reads real specifier
// nodes from the TypeScript AST — comments and string literals can never
// match — and resolves each specifier to repo-relative candidate paths.
//
// Resolution is STRING NORMALIZATION against the changed set, deliberately
// not ts.resolveModuleName: filesystem-based resolution returns nothing for
// a DELETED or RENAMED target, and importers of a deleted module are exactly
// the blast radius a reviewer needs to see. Alias prefixes come from
// tsconfig.json `paths`, never hardcoded.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Directories walked for candidate importers, relative to the repo root. */
const IMPORTER_ROOTS = ['src', 'worker', 'scripts'] as const;

interface AliasMapping {
  /** Specifier prefix, e.g. `@/lib/` (always slash-terminated). */
  prefix: string;
  /** Repo-relative replacement, e.g. `src/lib/` (always slash-terminated). */
  target: string;
}

/**
 * Alias mappings from tsconfig.json `compilerOptions.paths`. Only the
 * `prefix/*` → `./target/*` shape is supported — that is every alias this
 * repo defines — and longer prefixes sort first so `@/lib/*` wins over `@/*`.
 */
export function readAliasMappings(rootDir: string): AliasMapping[] {
  const configPath = join(rootDir, 'tsconfig.json');
  // tsconfig.json is JSONC (comments, trailing commas) — TypeScript's own
  // parser is the only correct reader for it.
  const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const raw: unknown = parsed.config;
  const paths =
    typeof raw === 'object' && raw !== null
      ? (raw as { compilerOptions?: { paths?: Record<string, string[]> } })
          .compilerOptions?.paths
      : undefined;
  if (!paths) return [];

  const mappings: AliasMapping[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = targets[0];
    if (!pattern.endsWith('/*') || !target || !target.endsWith('/*')) continue;
    mappings.push({
      prefix: pattern.slice(0, -1), // '@/lib/*' -> '@/lib/'
      target: target.replace(/^\.\//, '').slice(0, -1), // './src/lib/*' -> 'src/lib/'
    });
  }
  return mappings.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Every import/export/require/dynamic-import specifier in one source file. */
export function extractSpecifiers(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const [firstArg] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && firstArg && ts.isStringLiteralLike(firstArg)) {
        specifiers.push(firstArg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * Repo-relative candidate paths a specifier can denote. Returns [] for bare
 * package specifiers. Handles the NodeNext `./x.js` → `x.ts` convention the
 * old grep supported, and folder imports via `/index.ts(x)`.
 */
export function specifierCandidates(
  importerRepoPath: string,
  specifier: string,
  aliases: readonly AliasMapping[],
): string[] {
  let resolved: string | undefined;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    resolved = posix.normalize(posix.join(posix.dirname(importerRepoPath), specifier));
  } else {
    const alias = aliases.find((mapping) => specifier.startsWith(mapping.prefix));
    if (alias) resolved = alias.target + specifier.slice(alias.prefix.length);
  }
  if (resolved === undefined || resolved.startsWith('../')) return [];

  const base = resolved.replace(/\.(js|jsx)$/, '');
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  if (/\.(ts|tsx)$/.test(base)) candidates.push(base);
  return candidates;
}

function walkSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
  };
  for (const root of IMPORTER_ROOTS) walk(join(rootDir, root));
  return files;
}

/** changed repo path → sorted list of repo paths that import it. */
export function computeImporters(
  rootDir: string,
  changedPaths: readonly string[],
): Map<string, string[]> {
  const aliases = readAliasMappings(rootDir);
  const changedSet = new Set(changedPaths);
  const importers = new Map<string, Set<string>>(
    changedPaths.map((path) => [path, new Set<string>()]),
  );

  for (const absolutePath of walkSourceFiles(rootDir)) {
    const repoPath = absolutePath
      .slice(rootDir.length + 1)
      .split(sep)
      .join('/');
    const specifiers = extractSpecifiers(readFileSync(absolutePath, 'utf8'), repoPath);
    for (const specifier of specifiers) {
      for (const candidate of specifierCandidates(repoPath, specifier, aliases)) {
        if (changedSet.has(candidate) && candidate !== repoPath) {
          importers.get(candidate)?.add(repoPath);
        }
      }
    }
  }

  return new Map(
    [...importers.entries()].map(([path, set]) => [path, [...set].sort()]),
  );
}

export function renderReport(
  branch: string,
  importersByChanged: ReadonlyMap<string, readonly string[]>,
): string {
  const lines: string[] = [
    `# Blast radius — importers of changed files (\`${branch}\`)`,
    '',
    'Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.',
    '',
  ];
  if (importersByChanged.size === 0) {
    lines.push('_No changed production source files._', '');
    return lines.join('\n');
  }
  for (const [changed, importers] of importersByChanged) {
    lines.push(`## \`${changed}\` — ${importers.length} importer(s)`);
    if (importers.length > 0) {
      for (const importer of importers) lines.push(`- ${importer}`);
    } else {
      lines.push(
        '_none found (entry point, or dynamic/config-driven usage — check registration sites)_',
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function readNulSeparatedStdin(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

async function main(): Promise<void> {
  const branchFlag = process.argv.indexOf('--branch');
  const branch = branchFlag !== -1 ? process.argv[branchFlag + 1] : undefined;
  if (!branch) {
    console.error('usage: blast-radius-importers.ts --branch <name>  (NUL-separated changed paths on stdin)');
    process.exitCode = 1;
    return;
  }
  const changed = await readNulSeparatedStdin();
  const importers = computeImporters(process.cwd(), changed);
  process.stdout.write(renderReport(branch, importers));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
