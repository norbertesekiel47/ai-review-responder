// scripts/ci/admin-aal2-audit.ts
//
// The compensating control for the admin MFA gate, which #831 turned from a
// STRUCTURAL fact into a CONFIGURATION value: the channel runners call
// `config.resolveActor`, a per-route field of `ChannelRouteConfig`, so `tsc`
// cannot reject a route that binds the owner resolver to an admin path. Nothing
// in the type system distinguishes `resolveAdminActor` from `resolveOwnerActor`
// — they inhabit the same `ChannelActorResolver` type by design. This audit is
// what remains.
//
// It enforces two contracts:
//
//   ROUTES (src/app/api/admin/**/route.ts) — every EXPORTED state-mutating
//   handler (POST | PUT | PATCH | DELETE) must reach an admin MFA gate:
//   a CALL to `requireAdminWithAal2`, or a binding of `resolveAdminActor`
//   (whose own first act is that call). Per HANDLER, not per file.
//
//   PAGES (src/app/admin/**/page.tsx) — read-gate parity with the sibling API
//   route. See "The page contract" below.
//
// ---------------------------------------------------------------------------
// Why this is an AST audit and not a text scan
// ---------------------------------------------------------------------------
//
// The predecessor was `code.includes(...)` over a comment-stripped whole file.
// Its floor was exactly two substring conditions — the file must not contain
// the literal `resolveOwnerActor`, and must contain `requireAdminWithAal2` or
// `resolveAdminActor` SOMEWHERE — which left three verified holes, each closed
// here by construction rather than by another string:
//
//   1. FILE-SCOPED, NOT VERB-SCOPED. `const code = stripComments(text)` bound
//      the whole file, so a compliant `export async function GET` calling the
//      gate cleared a sibling `export const POST` that bound the owner
//      resolver. Mixed-verb admin routes are the normal App Router shape and
//      this repo has them (`src/app/api/admin/businesses/route.ts` — plain-admin
//      GET, AAL2 POST; `businesses/[id]/route.ts` — same). Closed by resolving
//      each exported mutation handler independently and searching only the
//      declarations REACHABLE from that handler.
//
//   2. AN UNUSED IMPORT SATISFIED THE ALLOW RULE. `import { requireAdminWithAal2 }`
//      at the top of a file cleared every handler in it, even after the real
//      call site was deleted. Closed by requiring a CallExpression (for the
//      gate) or a value reference inside the handler (for the resolver) — an
//      import declaration is never part of a handler's reachable set.
//
//   3. INDIRECTION VIA A RENAMING RE-EXPORT. A one-line
//      `export { resolveOwnerActor as resolveChannelActor } from './resolve-actor'`
//      in a file the audit never reads (anything not named `route.ts` under
//      `src/app/api/admin/`) laundered the denied name away. Closed by the
//      fail-closed posture below, NOT by following re-exports across files.
//
// FAIL-CLOSED IS THE MECHANISM. The allow rule is an ALLOWLIST OF RECOGNIZED
// GATE SHAPES, and an unrecognized shape is a FINDING, not a pass — the same
// posture ci:outbox-seam takes for an INSERT whose topic it cannot read
// ("silence on an unrecognized shape is how a guard becomes decorative").
// A handler that delegates to an opaque imported function has no gate this
// audit can see, so it is reported. That is why the renaming-re-export never
// needed cross-file resolution: the alias is not a recognized gate, so binding
// it fails for the same reason binding anything unknown fails.
//
// PROVENANCE closes the last gap in the allowlist. `resolveAdminActor` and
// `requireAdminWithAal2` are credited only when the local name is bound by an
// import from the canonical module, so
// `import { somethingElse as resolveAdminActor } from './evil'` earns nothing.
// (The same-file alias `import { resolveOwnerActor as resolveAdminActor }` is
// caught by the deny rule instead — the literal `resolveOwnerActor` survives on
// the LEFT of the `as` as a real Identifier node.)
//
// Reading IDENTIFIERS rather than text also retires `stripComments` outright.
// A comment or a string literal is not an Identifier, so the two directions the
// old scan got wrong — a header comment naming `resolveAdminActor` CLEARING a
// mis-bound route, and a header comment naming `resolveOwnerActor` TRIPPING a
// correct one (`admin/channels/telegram/start/route.ts` documents its owner
// counterpart) — are both structurally impossible now. So is
// `const GATE_TAG = 'resolveAdminActor'`, which the text scan accepted.
//
// ---------------------------------------------------------------------------
// The page contract: read-gate PARITY, not "pages need AAL2"
// ---------------------------------------------------------------------------
//
// `requireAdminPage`'s `aal2` parameter (src/lib/auth/page-gate.ts:41) DEFAULTS
// TO FALSE and 8 of 16 gated admin pages opt in. Nothing watched either way.
// The rule below is DERIVED from what the tree actually does, not imposed:
//
//   P1 (floor). Every `src/app/admin/**/page.tsx` must call a recognized admin
//   page gate — `requireAdminPage`, or `requireCurrentAal2FromSupabase` for the
//   one page with its own auth shape (impersonate/[sessionId]/view, documented
//   as such at page-gate.ts:27-37). The pre-auth pages are EXEMPT and that
//   exemption is DERIVED from src/proxy.ts's own `routePath !== '/admin/…'`
//   comparisons (readPreAuthAdminPaths), never hand-listed — the same
//   derive-don't-list discipline ci:db-imports applies to worker roots. A
//   hand-list would drift the moment proxy.ts changed; deriving means the two
//   cannot disagree. This is the bigger of the two holes: a NEW admin page
//   shipped with no gate at all was previously invisible.
//
//   P2 (parity). A page that server-renders data reads the DB DIRECTLY via
//   `sql` — it does not go through its API route, so the PAGE's gate, not the
//   route's, is what protects that data. If the sibling route
//   (src/app/admin/<X>/page.tsx → src/app/api/admin/<X>/route.ts) gates its GET
//   with `requireAdminWithAal2`, a weaker page gate is a parallel read path
//   around it: an AAL1 admin is refused by the API and served by the page.
//   So the page must pass `aal2: true`.
//
// P2 is the rule the opted-in pages already state in prose, four times:
// "gate parity with GET /api/admin/offboardings, which uses requireAdminWithAal2"
// (offboardings), "must match the route's requireAdminWithAal2" (flagged),
// "must match the suppressions route's" (autonomy), "matching the
// requireAdminWithAal2 on the routes this page calls" (suppressions).
//
// WHAT P2 IS DELIBERATELY NOT. It is NOT "a page that renders a mutation
// surface must be AAL2". That rule is FALSE here and pinning it would flag a
// correct page: `/admin/businesses/[id]` hosts five mutation surfaces (PATCH
// business, POST resend-invite / ranking / zernio-queue / grant-extension, PUT
// keywords) whose routes are ALL AAL2-gated, and the page is deliberately
// `aal2: false` with the reason recorded — "Gate parity with GET
// /api/admin/businesses/[id] — plain admin role, no AAL2." Mutations are not
// the page's job: every admin mutation route enforces its own gate, which is
// exactly what the ROUTE half of this audit exists to keep true. A form-hosting
// page MAY still opt into `aal2: true` as a UX affordance — step up before the
// form is filled in rather than after, which businesses/new, locations/csv-import,
// impersonate and demos each say in a comment — and that is a SUPERSET of the
// requirement, never a finding.
//
// Verified against the tree at the time of writing: P1 and P2 hold in BOTH
// directions for all 21 admin pages with zero findings and zero allowlist
// entries. Every page with a sibling GET route matches its gate exactly.
//
// RECORDED LIMITATION (P2): a page with no sibling `route.ts` has no parity
// anchor and is checked by P1 only — /admin/autonomy (its reads live under
// autonomy/suspensions/), /admin/security, /admin/runbook, /admin/impersonate,
// /admin/businesses/new. All five are correct today; four are AAL2 anyway. The
// alternative — mapping page → service module → route — was rejected as a
// heuristic that fails silently in the passing direction.
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** State-mutating HTTP verbs. A route exporting one of these needs the gate. */
const MUTATION_VERBS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

const GATE_FN = 'requireAdminWithAal2';
const ADMIN_RESOLVER = 'resolveAdminActor';
const OWNER_RESOLVER = 'resolveOwnerActor';
const PAGE_GATE_FN = 'requireAdminPage';
const PAGE_AAL2_FN = 'requireCurrentAal2FromSupabase';

/**
 * Canonical module homes. Matched on the trailing path segment so the alias
 * form (`@/lib/auth/admin-mfa-gate`) and every relative form
 * (`../../auth/admin-mfa-gate`) resolve identically, with any explicit
 * `.ts`/`.js` extension stripped first — the shape ci:db-imports uses for
 * `isDbServerSpecifier`. A specifier that merely shares a PREFIX
 * (`./resolve-actor-helpers`) does not match: the segment must terminate.
 */
function moduleIs(spec: string, tail: string): boolean {
  const withoutExtension = spec.replace(/\.(?:js|ts)$/, '');
  return new RegExp(`(^|/)${tail}$`).test(withoutExtension);
}

const isGateModule = (spec: string) => moduleIs(spec, 'admin-mfa-gate');
const isResolverModule = (spec: string) => moduleIs(spec, 'resolve-actor');
const isPageGateModule = (spec: string) => moduleIs(spec, 'page-gate');
const isMfaModule = (spec: string) => moduleIs(spec, 'mfa');

interface ImportOrigin {
  /** The name as exported by the target module (left of `as`). */
  imported: string;
  module: string;
}

/**
 * A file's top-level shape, indexed once so every later question is a map
 * lookup rather than another traversal.
 */
interface ModuleIndex {
  source: ts.SourceFile;
  /** Local binding name → where it was imported from. */
  imports: ReadonlyMap<string, ImportOrigin>;
  /** Top-level value declarations, by local name → the node worth traversing. */
  locals: ReadonlyMap<string, ts.Node>;
  /** Exported name → its declaration node, or null when re-exported from elsewhere. */
  exports: ReadonlyMap<string, ts.Node | null>;
}

/** Local binding name → origin, for every NAMED import in `statement`. */
function readImportBindings(statement: ts.ImportDeclaration): Array<[string, ImportOrigin]> {
  if (!ts.isStringLiteralLike(statement.moduleSpecifier)) return [];
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  // Not named `module` — @next/next/no-assign-module-variable bans that identifier.
  const moduleSpec = statement.moduleSpecifier.text;
  return bindings.elements.map((element) => [
    element.name.text,
    { imported: (element.propertyName ?? element.name).text, module: moduleSpec },
  ]);
}

/**
 * Top-level value declarations introduced by `statement`, as
 * [localName, nodeWorthWalking]. A variable's INITIALIZER is the node to walk —
 * that is what `export const POST = withSameOrigin()(inner)` puts the handler in.
 */
function readValueDeclarations(statement: ts.Statement): Array<[string, ts.Node]> {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name ? [[statement.name.text, statement]] : [];
  }
  if (!ts.isVariableStatement(statement)) return [];
  const declared: Array<[string, ts.Node]> = [];
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    declared.push([declaration.name.text, declaration.initializer ?? declaration]);
  }
  return declared;
}

/** True when `statement` carries an `export` modifier. */
function hasExportModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * `export { createBusiness as POST }` resolved through the local table. With a
 * moduleSpecifier it is a re-export this audit cannot see into, and null records
 * that so the caller fails closed rather than skipping the handler.
 */
function readNamedExportAliases(
  statement: ts.ExportDeclaration,
  locals: ReadonlyMap<string, ts.Node>,
): Array<[string, ts.Node | null]> {
  const clause = statement.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return [];
  const reExported = statement.moduleSpecifier !== undefined;
  return clause.elements.map((element) => [
    element.name.text,
    reExported ? null : (locals.get((element.propertyName ?? element.name).text) ?? null),
  ]);
}

function setAll<V>(target: Map<string, V>, entries: ReadonlyArray<readonly [string, V]>): void {
  for (const [key, value] of entries) target.set(key, value);
}

/** The three maps `indexModule` fills, before they are frozen into a ModuleIndex. */
interface MutableIndex {
  imports: Map<string, ImportOrigin>;
  locals: Map<string, ts.Node>;
  exports: Map<string, ts.Node | null>;
}

/**
 * Folds one top-level statement into the index. Statements are processed in
 * source order, which is what lets `readNamedExportAliases` resolve
 * `export { createBusiness as POST }` against the locals declared above it.
 */
function indexStatement(statement: ts.Statement, index: MutableIndex): void {
  if (ts.isImportDeclaration(statement)) {
    setAll(index.imports, readImportBindings(statement));
    return;
  }
  if (ts.isExportDeclaration(statement)) {
    setAll(index.exports, readNamedExportAliases(statement, index.locals));
    return;
  }
  const declared = readValueDeclarations(statement);
  setAll(index.locals, declared);
  if (hasExportModifier(statement)) setAll(index.exports, declared);
}

function indexModule(text: string): ModuleIndex {
  const source = ts.createSourceFile(
    'scan.tsx',
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const index: MutableIndex = { imports: new Map(), locals: new Map(), exports: new Map() };
  for (const statement of source.statements) indexStatement(statement, index);
  return { source, ...index };
}

/**
 * True when `node` is an Identifier used as a VALUE — excluding the three
 * positions where the same text means something else: the property name of
 * `obj.foo`, the key of `{ foo: … }`, and the source key of a destructuring
 * `{ foo: bar }`. Import specifiers are deliberately NOT excluded: the
 * `resolveOwnerActor` on the left of `import { resolveOwnerActor as x }` is
 * precisely the reference the deny rule must catch.
 */
function isValueIdentifier(node: ts.Node): node is ts.Identifier {
  if (!ts.isIdentifier(node)) return false;
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return true;
}

/** True when local name `id` was imported as `exported` from a module `matches` accepts. */
function importedAs(
  index: ModuleIndex,
  id: ts.Identifier,
  exported: string,
  matches: (spec: string) => boolean,
): boolean {
  const origin = index.imports.get(id.text);
  return origin !== undefined && origin.imported === exported && matches(origin.module);
}

interface GateEvidence {
  /** A CALL to requireAdminWithAal2 — an import alone can never set this. */
  callsGate: boolean;
  /** resolveAdminActor referenced as a value (called, or passed as `resolveActor:`). */
  bindsAdminResolver: boolean;
}

/**
 * Walks every declaration REACHABLE from `start` within this module, following
 * local identifier references one hop at a time, and reports whether an admin
 * gate is among them.
 *
 * The reachability walk is what makes the audit verb-scoped. Starting from
 * `export const POST = withSameOrigin()(createBusiness)` it visits the
 * initializer, finds the local identifier `createBusiness`, resolves it to that
 * function's declaration, and searches ITS body — so the gate inside
 * `createBusiness` credits the POST, while a gate inside a sibling `GET` (never
 * referenced from POST) credits nothing.
 *
 * Imported identifiers terminate the walk: their bodies are in another file.
 * That is the fail-closed edge — a handler delegating to an opaque import
 * yields no evidence and is reported.
 */
function collectGateEvidence(index: ModuleIndex, start: ts.Node): GateEvidence {
  const evidence: GateEvidence = { callsGate: false, bindsAdminResolver: false };
  const visited = new Set<string>();
  const queue: ts.Node[] = [start];

  while (queue.length > 0) {
    const root = queue.pop()!;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        importedAs(index, node.expression, GATE_FN, isGateModule)
      ) {
        evidence.callsGate = true;
      }

      if (isValueIdentifier(node)) {
        if (importedAs(index, node, ADMIN_RESOLVER, isResolverModule)) {
          evidence.bindsAdminResolver = true;
        }
        // Follow local declarations — `withSameOrigin()(createBusiness)`.
        const local = index.locals.get(node.text);
        if (local && local !== root && !visited.has(node.text)) {
          visited.add(node.text);
          queue.push(local);
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(root);
  }

  return evidence;
}

/**
 * True when the file references `resolveOwnerActor` as a real Identifier
 * anywhere — a binding, a local alias, or the left side of an aliased import.
 *
 * Deliberately FILE-scoped while the allow rule is HANDLER-scoped, and the
 * asymmetry is the point: both directions fail safe. An admin route has no
 * legitimate reason to import the owner resolver at all (it runs behind
 * `requireRoleOr401` against the SESSION with no MFA step-up), so a leftover
 * import is the exact shape a half-finished edit leaves behind and is worth
 * reporting; whereas a GATE must actually protect the handler in hand, so
 * proximity is not enough.
 */
function referencesOwnerResolver(index: ModuleIndex): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isValueIdentifier(node) && node.text === OWNER_RESOLVER) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(index.source);
  return found;
}

/**
 * Pure scan function — no FS access. Returns a list of finding messages
 * (empty array = file is clean). Scoped to `src/app/api/admin/`.
 */
export function scanRouteFile(path: string, text: string): string[] {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized.includes('src/app/api/admin/')) return [];

  const index = indexModule(text);
  const handlers = MUTATION_VERBS.filter((verb) => index.exports.has(verb));
  if (handlers.length === 0) return [];

  // Deny rule first — it outranks the allowlist, so gating one handler
  // correctly cannot buy absolution for the file also naming the owner resolver.
  if (referencesOwnerResolver(index)) {
    return [
      `${path} [admin-aal2] admin mutation route must not reference ${OWNER_RESOLVER} ` +
        `(it runs behind requireRoleOr401 with no MFA step-up)`,
    ];
  }

  const findings: string[] = [];
  for (const verb of handlers) {
    const node = index.exports.get(verb);
    if (!node) {
      findings.push(
        `${path} [admin-aal2] ${verb} is re-exported from another module, so this audit cannot ` +
          `see its gate — export the handler from this file and call ${GATE_FN} in it`,
      );
      continue;
    }
    const evidence = collectGateEvidence(index, node);
    if (evidence.callsGate || evidence.bindsAdminResolver) continue;
    findings.push(
      `${path} [admin-aal2] mutation handler ${verb} must use ${GATE_FN} — no call to it, and no ` +
        `${ADMIN_RESOLVER} binding, is reachable from this handler. A gate hidden behind an ` +
        `imported wrapper is not visible to this audit and does not count.`,
    );
  }
  return findings;
}

/**
 * The AAL2 gate an exported GET handler applies, used as the parity anchor for
 * the sibling page. Same reachability walk as the mutation handlers, so a GET
 * delegating to a local helper is read correctly.
 */
export function routeGetRequiresAal2(text: string): boolean {
  const index = indexModule(text);
  const node = index.exports.get('GET');
  if (!node) return false;
  return collectGateEvidence(index, node).callsGate;
}

/** How strongly an admin page gates itself. */
export type AdminPageGate = 'none' | 'plain' | 'aal2';

/**
 * Reads a page's own gate. Requires a CALL (never a bare import), and credits
 * `aal2` only on the literal `true` — `aal2: someFlag` is not provably a
 * step-up, so it reads as `plain` and fails P2 closed.
 *
 * `requireCurrentAal2FromSupabase` also counts: `impersonate/[sessionId]/view`
 * has a genuinely different auth shape (no users-role lookup; it feeds a 5-way
 * session discriminant incl. `notFound()`) and is documented at page-gate.ts:27-37
 * as deliberately not a caller of `requireAdminPage`. It still steps up.
 */
export function readAdminPageGate(text: string): AdminPageGate {
  const index = indexModule(text);
  let gate: AdminPageGate = 'none';

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (importedAs(index, node.expression, PAGE_AAL2_FN, isMfaModule)) gate = 'aal2';
      if (importedAs(index, node.expression, PAGE_GATE_FN, isPageGateModule)) {
        const options = node.arguments[1];
        const optsAal2 =
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === 'aal2' &&
              property.initializer.kind === ts.SyntaxKind.TrueKeyword,
          );
        if (optsAal2) gate = 'aal2';
        else if (gate === 'none') gate = 'plain';
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(index.source);
  return gate;
}

/**
 * The admin page paths src/proxy.ts exempts from its role gate, DERIVED from
 * proxy.ts's own `routePath !== '/admin/…'` comparisons rather than
 * hand-listed. These are the pre-auth pages (login / forgot-password /
 * reset-password); requiring an admin gate on them is a bootstrap paradox —
 * the same reason `security/page.tsx` documents for carrying no `aal2` (it IS
 * the MFA enrollment surface). Deriving keeps this audit and the proxy from
 * ever disagreeing. Pure — unit-tested.
 */
export function readPreAuthAdminPaths(proxyText: string): Set<string> {
  const source = ts.createSourceFile('proxy.ts', proxyText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const paths = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const { left, right } = node;
      if (ts.isIdentifier(left) && left.text === 'routePath' && ts.isStringLiteralLike(right)) {
        if (right.text.startsWith('/admin/')) paths.add(right.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return paths;
}

/** `src/app/admin/businesses/[id]/page.tsx` → `/admin/businesses/[id]`. */
export function pageRoutePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^src\/app/, '').replace(/\/page\.tsx$/, '');
}

/** `src/app/admin/flagged/page.tsx` → `src/app/api/admin/flagged/route.ts`. */
export function siblingRouteFile(file: string): string {
  return `src/app/api${pageRoutePath(file)}/route.ts`;
}

export interface PageScanContext {
  /** Admin page paths src/proxy.ts serves pre-auth (readPreAuthAdminPaths). */
  preAuthPaths: ReadonlySet<string>;
  /**
   * Whether the sibling API route gates its GET with requireAdminWithAal2.
   * `null` when no sibling route.ts exists — P2 has no anchor and is skipped
   * (recorded limitation, see the header).
   */
  siblingGetRequiresAal2: boolean | null;
}

/**
 * Pure scan for one admin page. Applies P1 (every admin page carries a gate)
 * and P2 (read-gate parity with the sibling route's GET). Scoped to
 * `src/app/admin/`; `page.tsx` only — `layout.tsx` renders chrome, not tenant
 * data, and src/proxy.ts already gates all of /admin.
 */
export function scanAdminPageFile(path: string, text: string, context: PageScanContext): string[] {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized.startsWith('src/app/admin/') || !normalized.endsWith('/page.tsx')) return [];

  const routePath = pageRoutePath(normalized);
  if (context.preAuthPaths.has(routePath)) return [];

  const gate = readAdminPageGate(text);
  if (gate === 'none') {
    return [
      `${path} [admin-aal2] admin page must call ${PAGE_GATE_FN} (src/lib/auth/page-gate.ts) — ` +
        `it renders behind the /admin proxy gate but carries no gate of its own. If this page is ` +
        `deliberately pre-auth, add it to the routePath exclusions in src/proxy.ts, which is where ` +
        `this audit derives that exemption from.`,
    ];
  }

  if (context.siblingGetRequiresAal2 === true && gate !== 'aal2') {
    return [
      `${path} [admin-aal2] page must pass { aal2: true } to ${PAGE_GATE_FN} — its sibling route ` +
        `${siblingRouteFile(normalized)} gates GET with ${GATE_FN}, and this page reads the same ` +
        `data directly via sql, so a weaker page gate is a parallel read path around the route's ` +
        `step-up (an AAL1 admin refused by the API is served by the page).`,
    ];
  }

  return [];
}

/** Walks `dir` and appends every file named `name` (relative to `root`) to `out`. */
async function collectNamedFiles(
  dir: string,
  root: string,
  out: string[],
  name: string,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Skip test directories.
      if (entry.name === '__tests__') continue;
      await collectNamedFiles(join(dir, entry.name), root, out, name);
    } else if (entry.isFile() && entry.name === name) {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
}

/**
 * Walks `dir` and appends every `route.ts` path (relative to `root`) to `out`.
 *
 * Exported for tests because it decides the audit's SCOPE: a directory this
 * function silently skips is a directory `scanRouteFile` never sees, so an
 * under-walk makes the whole MFA guarantee pass vacuously. An unreadable
 * directory returns quietly by design — a permissions error must not fail the
 * build — which is exactly the branch worth pinning.
 */
export async function collectRouteFiles(dir: string, root: string, out: string[]): Promise<void> {
  await collectNamedFiles(dir, root, out, 'route.ts');
}

/** Walks `dir` and appends every `page.tsx` path (relative to `root`) to `out`. */
export async function collectAdminPageFiles(dir: string, root: string, out: string[]): Promise<void> {
  await collectNamedFiles(dir, root, out, 'page.tsx');
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** One pass of the audit: the files it walked, and what it found in them. */
export interface AuditPass {
  files: string[];
  findings: string[];
}

/** Scans every `route.ts` under `<root>/src/app/api/admin`. */
export async function auditRoutes(root: string): Promise<AuditPass> {
  const files: string[] = [];
  await collectRouteFiles(resolve(root, 'src', 'app', 'api', 'admin'), root, files);
  const findings: string[] = [];
  for (const file of files) {
    findings.push(...scanRouteFile(file, await readFile(resolve(root, file), 'utf8')));
  }
  return { files, findings };
}

/**
 * Scans every `page.tsx` under `<root>/src/app/admin`, anchoring P2 on each
 * page's sibling route. A page with no sibling gets a null anchor and is
 * checked by P1 only.
 */
export async function auditPages(root: string, preAuthPaths: ReadonlySet<string>): Promise<AuditPass> {
  const files: string[] = [];
  await collectAdminPageFiles(resolve(root, 'src', 'app', 'admin'), root, files);
  const findings: string[] = [];
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    const siblingText = await readIfPresent(resolve(root, siblingRouteFile(normalized)));
    findings.push(
      ...scanAdminPageFile(normalized, await readFile(resolve(root, file), 'utf8'), {
        preAuthPaths,
        siblingGetRequiresAal2: siblingText === null ? null : routeGetRequiresAal2(siblingText),
      }),
    );
  }
  return { files, findings };
}

async function main(): Promise<void> {
  const root = process.cwd();

  const preAuthPaths = readPreAuthAdminPaths(await readFile(resolve(root, 'src', 'proxy.ts'), 'utf8'));
  if (preAuthPaths.size === 0) {
    // Deriving zero exemptions would flag every pre-auth page — a loud failure
    // rather than a silent one, but still a broken derivation worth naming.
    console.error('admin-aal2-audit: fatal — derived 0 pre-auth admin paths from src/proxy.ts');
    process.exit(1);
  }

  const routes = await auditRoutes(root);
  const pages = await auditPages(root, preAuthPaths);
  const findings = [...routes.findings, ...pages.findings];

  if (findings.length > 0) {
    console.error('admin-aal2-audit: FAILED');
    for (const finding of findings) {
      console.error(`  ${finding}`);
    }
    process.exit(1);
  }

  console.log(
    `admin-aal2-audit: passed (${routes.files.length} admin route files, ` +
      `${pages.files.length} admin pages scanned)`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('admin-aal2-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
