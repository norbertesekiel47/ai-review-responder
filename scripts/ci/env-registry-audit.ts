// scripts/ci/env-registry-audit.ts — #918: the env-var registry rule gets teeth.
//
// The house rule ("no new env var or feature flag without a registry entry")
// had NO enforcement: `ci:config-coverage` compares required-var declarations
// against lane lists and never reads a registry document, so a `rawOpt` var —
// or a flag, or a sanctioned raw read — ships with or without its row.
//
// This audit derives the DECLARED-VAR set from three lanes and fails any var
// with no row in the canonical flat inventory, `docs/eservices-variables.md`
// (that file's own header owns the inventory role; `.claude/reference/
// env-vars.md` owns per-flag BEHAVIOR, so flags must additionally have a row
// there). Lanes:
//
//   A. Config lane schemas — the z.object() literals in src/lib/config/
//      {server,worker,client,stripe-shape}.ts. Spreads are NOT silently
//      skipped: `...stripePriceShape` resolves through the
//      STRIPE_PRICE_ENV_VARS array extracted from price-tier-map.ts, and any
//      OTHER spread fails loudly so future generated shapes must be
//      registered here.
//   B. Flag call sites — readFlag/readFlagEnabledByDefault resolved through
//      their IMPORT BINDINGS (aliases and namespace imports included; any
//      non-call reference to the binding fails), with string-literal or
//      same-file-const arguments. flags.ts itself declares no names.
//   C. Raw process.env reads — literal reads across all of src/ + worker/
//      (production files) and next.config.mjs. Dynamic `process.env[k]`
//      reads must resolve through a same-file literal const, a registered
//      generic-reader module's extracted inventory (fail-closed per element,
//      see REGISTERED_GENERIC_READERS), or they fail with the site named.
//
// Registry parsing is NAME-CELL-ONLY: a var counts as registered only when it
// is the single backticked token of a table row's first cell — a mention in
// another row's prose can never false-pass — and the old inline-list /
// slash-separated-cell formats fail a format guard so the normalized
// inventory stays normalized.
//
// `scripts/` is deliberately OUT of scope: dev tooling reads env vars
// (TEST_DATABASE_POOL_URL and friends) that are documented where the tooling
// is documented, not in the app's service catalogue.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const VAR_NAME_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/** Failure = human-readable line naming the site. Success = names collected. */
export interface Extraction {
  names: Set<string>;
  failures: string[];
}

function newExtraction(): Extraction {
  return { names: new Set(), failures: [] };
}

// ---------------------------------------------------------------------------
// Shared AST helpers

function parse(sourceText: string, fileName: string): ts.SourceFile {
  const kind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.mjs') || fileName.endsWith('.js')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/** Same-file `const NAME = 'LITERAL'` resolution for an identifier. */
function resolveLocalStringConst(source: ts.SourceFile, name: string): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      const init = unwrapAs(node.initializer);
      if (ts.isStringLiteralLike(init)) found = init.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function unwrapAs(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * Same-file `const NAME = ['A', 'B', ...KNOWN_SPREAD]` resolution. Returns
 * undefined unless EVERY element resolves (string literal, or a spread found
 * in `spreadInventories`) — partial resolution must read as unresolved, never
 * as a shorter list.
 */
function resolveLocalStringArray(
  source: ts.SourceFile,
  name: string,
  spreadInventories: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> | undefined {
  let result: Set<string> | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      const init = unwrapAs(node.initializer);
      if (ts.isArrayLiteralExpression(init)) {
        const names = new Set<string>();
        for (const element of init.elements) {
          if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
            const spread = spreadInventories.get(element.expression.text);
            if (spread === undefined) return;
            for (const spreadName of spread) names.add(spreadName);
          } else {
            const value = unwrapAs(element as ts.Expression);
            if (!ts.isStringLiteralLike(value)) return;
            names.add(value.text);
          }
        }
        result = names;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

/** Array-iteration methods whose callback parameter carries an element. */
const ITERATION_METHODS = new Set(['filter', 'some', 'every', 'map', 'forEach', 'find']);

/**
 * Resolves `process.env[k]` where `k` is the callback parameter of
 * `INVENTORY.filter((k) => …)` — the repo's standard missing-env probe shape
 * (instrumentation.ts, telegram-env.ts, whatsapp-env.ts). Returns the
 * iterated names, or undefined when the receiver is not a resolvable
 * inventory.
 */
function resolveIterationParameter(
  source: ts.SourceFile,
  key: ts.Identifier,
  spreadInventories: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> | undefined {
  let current: ts.Node = key;
  while (current.parent !== undefined) {
    current = current.parent;
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
    const isParameter = current.parameters.some(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === key.text,
    );
    if (!isParameter) continue;
    const call = current.parent;
    if (
      !ts.isCallExpression(call) ||
      call.arguments[0] !== current ||
      !ts.isPropertyAccessExpression(call.expression) ||
      !ITERATION_METHODS.has(call.expression.name.text)
    ) {
      return undefined;
    }
    const receiver = unwrapAs(call.expression.expression);
    if (!ts.isIdentifier(receiver)) return undefined;
    return (
      resolveLocalStringArray(source, receiver.text, spreadInventories) ??
      (spreadInventories.get(receiver.text) !== undefined
        ? new Set(spreadInventories.get(receiver.text))
        : undefined)
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Lane A — config lane schemas

export const CONFIG_SCHEMA_FILES = [
  'src/lib/config/server.ts',
  'src/lib/config/worker.ts',
  'src/lib/config/client.ts',
  'src/lib/config/stripe-shape.ts',
] as const;

/**
 * Spread identifiers a schema literal may contain, each resolving to the
 * STRIPE_PRICE_ENV_VARS inventory. Anything else fails: a silently skipped
 * spread is exactly how a generated shape's vars would vanish from the audit.
 */
const KNOWN_SCHEMA_SPREADS = new Set(['stripePriceShape']);

export function extractSchemaVars(
  sourceText: string,
  fileName: string,
  spreadInventory: ReadonlySet<string>,
): Extraction {
  const out = newExtraction();
  const source = parse(sourceText, fileName);

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'object' &&
      node.arguments.length >= 1
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const member of arg.properties) {
          if (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) {
            const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
              ? member.name.text
              : undefined;
            if (name && VAR_NAME_RE.test(name)) out.names.add(name);
          } else if (ts.isSpreadAssignment(member)) {
            const spreadName = ts.isIdentifier(member.expression)
              ? member.expression.text
              : member.expression.getText();
            if (KNOWN_SCHEMA_SPREADS.has(spreadName)) {
              for (const name of spreadInventory) out.names.add(name);
            } else {
              out.failures.push(
                `${fileName}:${lineOf(source, member)}: unregistered spread \`...${spreadName}\` in a config schema — register it in KNOWN_SCHEMA_SPREADS with its inventory, or the vars it carries vanish from this audit`,
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// ---------------------------------------------------------------------------
// Lane B — flag call sites, resolved through import bindings

const FLAG_READER_NAMES = new Set(['readFlag', 'readFlagEnabledByDefault']);

function isFlagsModuleSpecifier(specifier: string, importerPath: string): boolean {
  if (/(^|\/)config\/flags$/.test(specifier)) return true;
  return specifier === './flags' && importerPath.replace(/\\/g, '/').includes('src/lib/config/');
}

export function extractFlagCalls(sourceText: string, fileName: string): Extraction {
  const out = newExtraction();
  const source = parse(sourceText, fileName);

  // localName -> which reader it is; namespaceName for `* as flags` imports.
  const readerBindings = new Map<string, string>();
  const namespaceBindings = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!isFlagsModuleSpecifier(statement.moduleSpecifier.text, fileName)) continue;
    const clause = statement.importClause;
    if (!clause?.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      namespaceBindings.add(clause.namedBindings.name.text);
    } else {
      for (const element of clause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (FLAG_READER_NAMES.has(imported)) {
          readerBindings.set(element.name.text, imported);
        }
      }
    }
  }
  if (readerBindings.size === 0 && namespaceBindings.size === 0) return out;

  const resolveArg = (call: ts.CallExpression): void => {
    const arg = call.arguments[0];
    if (arg === undefined) {
      out.failures.push(`${fileName}:${lineOf(source, call)}: flag reader called with no argument`);
      return;
    }
    if (ts.isStringLiteralLike(arg)) {
      out.names.add(arg.text);
      return;
    }
    if (ts.isIdentifier(arg)) {
      const value = resolveLocalStringConst(source, arg.text);
      if (value !== undefined) {
        out.names.add(value);
        return;
      }
    }
    out.failures.push(
      `${fileName}:${lineOf(source, arg)}: flag name is not a string literal or same-file const — the audit cannot register it`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && readerBindings.has(node.text)) {
      const parent = node.parent;
      const isImportSite =
        ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
      const isDirectCallee = ts.isCallExpression(parent) && parent.expression === node;
      if (isDirectCallee) {
        resolveArg(parent);
      } else if (!isImportSite) {
        out.failures.push(
          `${fileName}:${lineOf(source, node)}: non-call reference to flag reader \`${node.text}\` (alias/assignment/re-export) — flags read this way vanish between audit lanes`,
        );
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaceBindings.has(node.expression.text) &&
      FLAG_READER_NAMES.has(node.name.text)
    ) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        resolveArg(parent);
      } else {
        out.failures.push(
          `${fileName}:${lineOf(source, node)}: non-call reference to \`${node.getText()}\``,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// ---------------------------------------------------------------------------
// Registered generic readers + literal-array inventories (lane C support)

/**
 * Modules whose `process.env[k]` reads are sanctioned GENERIC: their names
 * come from inventories this audit extracts fail-closed, not from resolving
 * each read. src/lib/config/** is the sanctioned env home (lane A owns its
 * names); flags.ts's generic reader is lane B's subject.
 */
export const REGISTERED_GENERIC_READERS = [
  'worker/config/startup-assert.ts',
  'src/lib/payments/price-tier-map.ts',
] as const;

function isRegisteredGenericReader(repoPath: string): boolean {
  const normalized = repoPath.replace(/\\/g, '/');
  return (
    normalized.startsWith('src/lib/config/') ||
    (REGISTERED_GENERIC_READERS as readonly string[]).includes(normalized)
  );
}

/**
 * Extracts env-name inventories from a registered reader module: top-level
 * `string[]` arrays and `{ key: 'X', … }[]` object arrays. FAIL-CLOSED per
 * element: an array where SOME elements carry a var name and others do not
 * resolve fails the audit — "return what parsed" is how a partial extraction
 * silently drops a var.
 */
export function extractLiteralArrayInventories(
  sourceText: string,
  fileName: string,
  spreadInventories: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Extraction {
  const out = newExtraction();
  const source = parse(sourceText, fileName);

  const harvestArray = (array: ts.ArrayLiteralExpression, label: string): void => {
    const collected: string[] = [];
    let matching = 0;
    let broken = false;
    for (const element of array.elements) {
      if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
        const spread = spreadInventories.get(element.expression.text);
        if (spread === undefined) {
          broken = true;
          continue;
        }
        for (const name of spread) {
          collected.push(name);
          matching += 1;
        }
        continue;
      }
      const value = unwrapAs(element as ts.Expression);
      if (ts.isStringLiteralLike(value)) {
        collected.push(value.text);
        if (VAR_NAME_RE.test(value.text)) matching += 1;
      } else if (ts.isObjectLiteralExpression(value)) {
        const keyProp = value.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
            property.name.text === 'key',
        );
        if (keyProp === undefined) {
          broken = true;
          continue;
        }
        const keyValue = unwrapAs(keyProp.initializer);
        if (ts.isStringLiteralLike(keyValue)) {
          collected.push(keyValue.text);
          if (VAR_NAME_RE.test(keyValue.text)) matching += 1;
        } else {
          out.failures.push(
            `${fileName}:${lineOf(source, keyProp)}: ${label}: object-array \`key\` is not a string literal — extraction is fail-closed`,
          );
          return;
        }
      } else {
        broken = true;
      }
    }
    if (matching === 0) return; // not an env-name inventory at all
    if (broken || matching !== collected.length) {
      out.failures.push(
        `${fileName}:${lineOf(source, array)}: ${label}: array mixes var-name elements with unresolved ones — extraction is fail-closed, fix the array or this audit`,
      );
      return;
    }
    for (const name of collected) out.names.add(name);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const init = unwrapAs(node.initializer);
      if (ts.isArrayLiteralExpression(init)) {
        const label = ts.isIdentifier(node.name) ? node.name.text : 'array';
        harvestArray(init, label);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * Caller-level check for free-form generic readers (`missingEnvVars(required:
 * string[])`): registering the READ SITE alone is fail-open — a new caller
 * with an unregistered array would pass. Every call's argument must be an
 * inline literal array or an identifier the inventory extraction resolved.
 */
export function checkGenericReaderCallers(
  sourceText: string,
  fileName: string,
  knownArrayNames: ReadonlySet<string>,
): string[] {
  const failures: string[] = [];
  const source = parse(sourceText, fileName);

  const knownIdentifiers = new Set<string>();
  const collectNames = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrapAs(node.initializer);
      if (ts.isArrayLiteralExpression(init)) knownIdentifiers.add(node.name.text);
    }
    ts.forEachChild(node, collectNames);
  };
  collectNames(source);

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'missingEnvVars' &&
      node.arguments.length >= 1
    ) {
      const arg = unwrapAs(node.arguments[0] as ts.Expression);
      const resolves =
        ts.isArrayLiteralExpression(arg) ||
        (ts.isIdentifier(arg) && (knownIdentifiers.has(arg.text) || knownArrayNames.has(arg.text)));
      if (!resolves) {
        failures.push(
          `${fileName}:${lineOf(source, node)}: missingEnvVars called with an argument the audit cannot resolve to a literal array — new callers must pass a registered inventory`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
}

// ---------------------------------------------------------------------------
// Lane C — raw process.env reads

/**
 * Platform- or harness-provided names that need no service-catalogue row.
 * Keep MINIMAL — every entry is a hole in the audit. Prefixes cover families
 * the platform injects wholesale.
 */
export const PLATFORM_PROVIDED_VARS = new Set([
  'NODE_ENV', // runtime-injected by Node/Next
  'CI', // set by the CI runner
  'VERCEL', // Vercel platform marker
  'VERCEL_ENV', // Vercel platform marker
  'VERCEL_TARGET_ENV', // Vercel platform marker (custom envs)
  'VERCEL_URL', // Vercel platform marker
  'PORT', // injected by Railway/host
]);
export const PLATFORM_PROVIDED_PREFIXES = ['RAILWAY_', 'NEXT_RUNTIME'] as const;

export function isPlatformProvided(name: string): boolean {
  return (
    PLATFORM_PROVIDED_VARS.has(name) ||
    PLATFORM_PROVIDED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function isProcessEnv(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'process' &&
    expression.name.text === 'env'
  );
}

export function extractRawEnvReads(
  sourceText: string,
  fileName: string,
  options: {
    dynamicReadsRegistered: boolean;
    importedInventories?: ReadonlyMap<string, ReadonlySet<string>>;
  },
): Extraction {
  const out = newExtraction();
  const source = parse(sourceText, fileName);
  const inventories = options.importedInventories ?? new Map<string, ReadonlySet<string>>();

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
      out.names.add(node.name.text);
    } else if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
      const key = unwrapAs(node.argumentExpression);
      if (ts.isStringLiteralLike(key)) {
        out.names.add(key.text);
      } else if (ts.isIdentifier(key)) {
        const constValue = resolveLocalStringConst(source, key.text);
        const iterated =
          constValue === undefined
            ? resolveIterationParameter(source, key, inventories)
            : undefined;
        if (constValue !== undefined) {
          out.names.add(constValue);
        } else if (iterated !== undefined) {
          for (const name of iterated) out.names.add(name);
        } else if (!options.dynamicReadsRegistered) {
          out.failures.push(
            `${fileName}:${lineOf(source, node)}: dynamic process.env[${key.text}] read in an unregistered module — resolve it to literals or register the module with a fail-closed inventory`,
          );
        }
      } else if (!options.dynamicReadsRegistered) {
        out.failures.push(
          `${fileName}:${lineOf(source, node)}: dynamic process.env[…] read in an unregistered module`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// ---------------------------------------------------------------------------
// Registry parsing — name-cell-only, with format guards

export function parseRegistryNames(markdown: string, fileName: string): Extraction {
  const out = newExtraction();
  const lines = markdown.split('\n');
  lines.forEach((line, index) => {
    const row = line.match(/^\|\s*`([A-Z][A-Z0-9_]{2,})`\s*\|/);
    if (row?.[1]) {
      out.names.add(row[1]);
      return;
    }
    // A dedicated `### \`VAR\`` heading is the other name-anchored shape the
    // behavior registry uses — a heading cannot be another row's prose.
    const heading = line.match(/^###\s+`([A-Z][A-Z0-9_]{2,})`\s*$/);
    if (heading?.[1]) {
      out.names.add(heading[1]);
      return;
    }
    // Format guards: the pre-normalization shapes must not come back.
    if (/^\|\s*`[A-Z][A-Z0-9_]*`\s*\/\s*`/.test(line)) {
      out.failures.push(
        `${fileName}:${index + 1}: slash-separated multi-var name cell — one variable per row (audit parses the name cell only)`,
      );
    } else if (
      /`[A-Z][A-Z0-9_]{2,}`/.test(line) &&
      line.includes('\u00b7') &&
      (line.match(/`[A-Z][A-Z0-9_]{2,}`/g) ?? []).length >= 2 &&
      !line.startsWith('|')
    ) {
      // The pre-normalization inline shape: `A` \u2705 \u00b7 `B` \u2705 \u00b7 \u2026 - wrapped
      // PROSE that merely starts with a backticked var must not trip this.
      out.failures.push(
        `${fileName}:${index + 1}: inline code-span var list outside a table — move it into the inventory table (one var per row)`,
      );
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// File walking

const RAW_SCAN_ROOTS = ['src', 'worker'] as const;

export function listProductionSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        files.push(full);
      }
    }
  };
  for (const root of RAW_SCAN_ROOTS) walk(join(rootDir, root));
  const nextConfig = join(rootDir, 'next.config.mjs');
  try {
    statSync(nextConfig);
    files.push(nextConfig);
  } catch {
    // absent in a fixture tree
  }
  return files;
}

// ---------------------------------------------------------------------------
// Main

interface AuditResult {
  failures: string[];
  declaredCount: number;
  flagCount: number;
}

export function runAudit(rootDir: string): AuditResult {
  const failures: string[] = [];
  const read = (repoPath: string): string => readFileSync(join(rootDir, repoPath), 'utf8');

  // The Stripe price inventory first — schemas spread it, startup-assert
  // spreads it, and instrumentation iterates it.
  const stripeExtraction = extractLiteralArrayInventories(
    read('src/lib/payments/price-tier-map.ts'),
    'src/lib/payments/price-tier-map.ts',
  );
  const stripeNames: ReadonlySet<string> = new Set(
    [...stripeExtraction.names].filter((name) => name.startsWith('STRIPE_')),
  );
  const importedInventories = new Map<string, ReadonlySet<string>>([
    ['STRIPE_PRICE_ENV_VARS', stripeNames],
  ]);

  // Inventories from registered generic readers (also feeds the schema spread).
  const inventoryNames = new Set<string>();
  const knownArrayNames = new Set<string>();
  for (const repoPath of REGISTERED_GENERIC_READERS) {
    const text = read(repoPath);
    const inventory = extractLiteralArrayInventories(text, repoPath, importedInventories);
    failures.push(...inventory.failures);
    for (const name of inventory.names) inventoryNames.add(name);
    // Names of the arrays themselves, for caller-level checks.
    const source = parse(text, repoPath);
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isArrayLiteralExpression(unwrapAs(node.initializer))) {
          knownArrayNames.add(node.name.text);
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
  }

  // Lane A.
  const declared = new Set<string>();
  for (const repoPath of CONFIG_SCHEMA_FILES) {
    const extraction = extractSchemaVars(read(repoPath), repoPath, stripeNames);
    failures.push(...extraction.failures);
    for (const name of extraction.names) declared.add(name);
  }

  // Lanes B and C over the production tree.
  const flagNames = new Set<string>();
  for (const absolute of listProductionSourceFiles(rootDir)) {
    const repoPath = relative(rootDir, absolute).split(sep).join('/');
    const text = readFileSync(absolute, 'utf8');

    if (repoPath !== 'src/lib/config/flags.ts') {
      const flags = extractFlagCalls(text, repoPath);
      failures.push(...flags.failures);
      for (const name of flags.names) {
        flagNames.add(name);
        declared.add(name);
      }
    }

    const raw = extractRawEnvReads(text, repoPath, {
      dynamicReadsRegistered:
        isRegisteredGenericReader(repoPath) || repoPath === 'src/lib/config/flags.ts',
      importedInventories,
    });
    failures.push(...raw.failures);
    for (const name of raw.names) declared.add(name);

    if (repoPath === 'worker/config/startup-assert.ts') {
      failures.push(...checkGenericReaderCallers(text, repoPath, knownArrayNames));
    }
  }
  for (const name of inventoryNames) declared.add(name);

  // Registries.
  const catalogue = parseRegistryNames(
    read('docs/eservices-variables.md'),
    'docs/eservices-variables.md',
  );
  failures.push(...catalogue.failures);
  const flagRegistry = parseRegistryNames(
    read('.claude/reference/env-vars.md'),
    '.claude/reference/env-vars.md',
  );
  failures.push(...flagRegistry.failures);

  for (const name of [...declared].sort()) {
    if (isPlatformProvided(name)) continue;
    if (!catalogue.names.has(name)) {
      failures.push(
        `\`${name}\` is read by production code but has no row in docs/eservices-variables.md — add its inventory row (one var per table row)`,
      );
    }
  }
  for (const name of [...flagNames].sort()) {
    if (!flagRegistry.names.has(name)) {
      failures.push(
        `flag \`${name}\` has no row in .claude/reference/env-vars.md — that file owns per-flag behavior`,
      );
    }
  }

  return { failures, declaredCount: declared.size, flagCount: flagNames.size };
}

function main(): void {
  const { failures, declaredCount, flagCount } = runAudit(process.cwd());
  if (failures.length > 0) {
    console.error('env-registry-audit: failed');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `env-registry-audit: passed (${declaredCount} declared vars incl. ${flagCount} flags, every one with a registry row)`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
