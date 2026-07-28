import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { normalize, walk } from './lib/ratchet-harness';
import { SQL_TAG_NAMES } from './lib/sql-tag-scan';

/**
 * Enforces CLAUDE.md architecture invariants that are otherwise pure
 * developer discipline (no type system or framework catches them):
 *
 *   #10 — Use Node.js native crypto. The `crypto-js` package must never appear
 *         as a dependency or be imported anywhere.
 *   #13 — Feature flags are server-authoritative. The browser must not learn
 *         flag state from a `NEXT_PUBLIC_*` env var, so every `NEXT_PUBLIC_`
 *         read in code must be on an explicit allowlist of browser-safe values.
 *   #14 — Server-owned policy/lifecycle rows must not be read or written
 *         directly by client components through Supabase.
 *    §  — A `'use client'` component must not import `@/lib/db/server`; that
 *         would bundle DATABASE_POOL_URL / SUPABASE_SERVICE_KEY into the browser.
 *         The runtime `server-only` tripwire cannot guard this module — the
 *         Railway worker imports it under tsx and would crash on boot — so this
 *         build-time check stands in (deep-scan §4.3).
 *    §  — A SqlExecutor-typed parameter that tags SQL templates must be named
 *         something scripts/ci/lib/sql-tag-scan.ts recognises, or the four SQL
 *         vocabulary audits silently scan nothing (#592).
 *    §  — Worker code must not read NODE_ENV to decide which deployment lane it
 *         is on; the lane owner is src/lib/config/deployment-lane.ts (#611,
 *         ADR 0013). See scanWorkerNodeEnvReads for the exact scope.
 *
 * Whole-repo (src + worker + scripts), unlike `pnpm lint` which only covers
 * `src`. Adding a genuinely browser-safe public var is a deliberate one-line
 * edit to ALLOWED_NEXT_PUBLIC below — that review is the point.
 */

export const ALLOWED_NEXT_PUBLIC: ReadonlySet<string> = new Set([
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_DOCS_BASE_URL',
  'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY',
  'NEXT_PUBLIC_SENTRY_DSN',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
]);

const SCAN_DIRS = ['src', 'worker', 'scripts'] as const;
const LEGACY_TIER_SCAN_DIRS = ['src', 'worker', 'scripts', 'e2e', 'tests'] as const;
// Overrides the harness defaults: this audit also scans .js/.mjs/.cjs, and it
// keeps __fixtures__ in scope. SKIP_FILE uses the harness default.
const SCAN_EXT = /\.(?:ts|tsx|mjs|cjs|js)$/;
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next', 'coverage']);
const LEGACY_TIER_SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage']);
// This audit names its own forbidden patterns in source/messages; skip it
// so it never flags itself. Normalized to match walk()'s forward-slash paths.
const SELF = normalize(join('scripts', 'ci', 'static-policy-audit.ts'));

const LEGACY_TIER_HISTORY_EXCLUSIONS = new Set([
  'scripts/ci/__tests__/static-policy-audit.test.ts',
  'src/lib/shared/__tests__/migration-034-structure.test.ts',
  'src/lib/shared/__tests__/migration-054-structure.test.ts',
  'src/lib/shared/__tests__/migration-077-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-078-copilot-autopilot.integration.test.ts',
]);

export type PolicyRule =
  | 'crypto-js'
  | 'next-public-allowlist'
  | 'server-owned-table-browser-access'
  | 'server-db-client-import'
  | 'subscription-status-literal'
  | 'legacy-subscription-tier'
  | 'inline-feature-flag'
  | 'railway-replicas'
  | 'sql-executor-tag-name'
  | 'worker-node-env-read';

export interface PolicyFinding {
  file: string;
  line: number;
  rule: PolicyRule;
  detail: string;
}

// An ESM/CJS module specifier for the banned package (bare or submodule import).
const CRYPTO_JS_SPECIFIER = /(?:from|require|import)\s*\(?\s*['"]crypto-js(?:\/[^'"]*)?['"]/;
// An actual READ of a public env var — dot form `process.env.NEXT_PUBLIC_X` OR
// string-bracket form `process.env['NEXT_PUBLIC_X']` (so a non-allowlisted public
// read can't bypass via notation; the dynamic `process.env[name]` is excluded).
// Not a log/comment that merely names the variable.
const NEXT_PUBLIC_ACCESS =
  /process\.env(?:\.(NEXT_PUBLIC_[A-Z0-9_]+)|\[\s*['"](NEXT_PUBLIC_[A-Z0-9_]+)['"]\s*\])/g;

// Invariant #13 (Stage-4 flag sweep): a boolean feature flag (`*_ENABLED` /
// `*_DISABLED`) must be read through the shared `readFlag` primitive
// (src/lib/config/flags.ts) behind a per-feature `<feature>/flags.ts` accessor —
// never inline. Matches a DOT-notation read `process.env.X_ENABLED` (the
// `process.env.` prefix; bare flag-name mentions in comments/log strings are not
// matched, and whole-comment lines are skipped). Matches BOTH the dot form
// `process.env.X_ENABLED` and the string-literal bracket form
// `process.env['X_ENABLED']` / `process.env["X_ENABLED"]` (so the rule can't be
// bypassed by switching notation) — but NOT the dynamic `process.env[name]` that
// `readFlag` itself uses (bracket WITHOUT a string literal → variable key). A
// `NEXT_PUBLIC_*_ENABLED` read is excluded (the negative lookaheads) because it is
// already the more-specific `next-public-allowlist` rule's concern — no
// double-flagging. Like the sibling `NEXT_PUBLIC_ACCESS`/`crypto-js` rules this is
// a raw-line scan: a `process.env.X_ENABLED` buried inside a string literal or a
// trailing comment on a CODE line is a rare, accepted false-positive surface (the
// `process.env.` prefix makes it unlikely); the fix there is a local rewrite.
// Exempt files below.
const INLINE_FLAG_ACCESS =
  /process\.env(?:\.(?!NEXT_PUBLIC_)([A-Z][A-Z0-9_]*_(?:ENABLED|DISABLED))\b|\[\s*['"](?!NEXT_PUBLIC_)([A-Z][A-Z0-9_]*_(?:ENABLED|DISABLED))['"]\s*\])/g;

// The flag-ban does NOT apply to: every `<feature>/flags.ts` accessor module
// (the sanctioned home, incl. config/flags.ts), the worker boot-assert (it
// validates flag-gated env groups by name), and `scripts/` CI/dev tooling (run
// standalone via tsx, outside the app runtime and the @/ import graph).
function isFlagBanExempt(file: string): boolean {
  return /(?:^|[/\\])flags\.ts$/.test(file)
    || /^worker[/\\]config[/\\]startup-assert\.ts$/.test(file)
    || /^scripts[/\\]/.test(file);
}
// File-local guard only: this catches direct client-component table references.
// It does not follow imports through helper modules, so code review must still
// reject browser Supabase helper indirection for these server-owned tables.
const SERVER_OWNED_BROWSER_FORBIDDEN_TABLES = [
  'account_offboardings',
  'account_offboarding_tokens',
  'auto_approval_policies',
] as const;
const SERVER_OWNED_BROWSER_FORBIDDEN_TABLE_PATTERNS =
  SERVER_OWNED_BROWSER_FORBIDDEN_TABLES.map((table) => ({
    table,
    pattern: new RegExp(`\\b${table}\\b`),
  }));

// Module specifier in a `from '…'` / `import('…')` / `require('…')` position.
const MODULE_SPECIFIER_RE = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

// True when a specifier resolves to the server-only DB module (`@/lib/db/server`
// or any relative path ending in `lib/db/server` / `db/server`). Mirrors the
// tenant-scope audit's `isDbServerImportSource` so the two stay in agreement.
function isDbServerSpecifier(specifier: string): boolean {
  return specifier === '@/lib/db/server'
    || /(?:^|\/)(?:src\/)?lib\/db\/server$/.test(specifier)
    || /(?:^|\/)db\/server$/.test(specifier);
}

/**
 * True only when `'use client'` is a genuine file-prologue directive — the
 * first non-blank, non-line-comment statement — matching how Next.js treats it.
 * A bare `/^['"]use client['"]/m` regex would also match a `'use client'`
 * string literal later in the file (e.g. a fixture array), falsely flagging a
 * server module as a client component and producing spurious CI failures.
 */
function isClientComponentFile(text: string): boolean {
  return /^['"]use client['"];?/.test(stripLeadingWhitespaceAndComments(text));
}

function stripLeadingWhitespaceAndComments(text: string): string {
  let remaining = text;
  while (remaining.length > 0) {
    const trimmed = remaining.replace(/^\s+/, '');
    if (trimmed.startsWith('//')) {
      const nextLine = trimmed.indexOf('\n');
      remaining = nextLine === -1 ? '' : trimmed.slice(nextLine + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const commentEnd = trimmed.indexOf('*/');
      if (commentEnd === -1) return trimmed;
      remaining = trimmed.slice(commentEnd + 2);
      continue;
    }
    return trimmed;
  }
  return remaining;
}

// ── Subscription-status bare-literal guard (deep-scan §7.1; repworth.md "Never do") ──
// Subscription status values must use the `SubscriptionStatus` enum
// (src/lib/shared/subscription-status.ts), never bare string literals. Detection
// is LINE-SCOPED to avoid false-positives on OTHER status domains (Zernio
// connection status, review status, job/outbox status): a bare status literal is
// flagged ONLY on a non-comment line that ALSO names the `subscription_status`
// column or `subscriptionStatus` field. The bounded quotes deliberately exclude
// synthetic supersets like 'active_pending_business' / 'pending_payment_admin_handoff'.
// SQL predicates (the enum can't be imported into a postgres.js sql`` template,
// so they keep the literal + a `-- enum:` reference comment) and the dashboard
// view-model discriminant union are the explicit, reviewed allowlist below; the
// carve-out count is printed so growth stays visible.
const SUBSCRIPTION_STATUS_FIELD = /subscription[_]?[Ss]tatus/;
const SUBSCRIPTION_STATUS_LITERAL = /['"](?:active|trialing|past_due|cancelled|pending_payment)['"]/;

// file:line sites that legitimately keep a bare literal. Each is either a SQL
// predicate inside a postgres.js sql`` template (annotated with a `-- enum:`
// reference comment) or a type-level discriminant in the dashboard view-model
// union (which mixes enum statuses with synthetic states). Adding a new entry is
// a deliberate, reviewed edit — that review is the point.
export const SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST: ReadonlySet<string> = new Set([
  // ── SQL predicates inside postgres.js sql`` templates (enum can't be imported;
  //    each keeps the literal + a trailing `-- enum: SubscriptionStatus.X` comment) ──
  'src/app/api/admin/billing/grant-extension/route.ts:70',
  'src/app/api/admin/billing/grant-extension/route.ts:108',
  'src/lib/admin/margin-service.ts:135',
  'worker/background/pollers/CancellationGracePoller.ts:46',
  'worker/background/pollers/EmailChannelReconcilePoller.ts:124',
  'worker/background/pollers/EngagementMonitorPoller.ts:91',
  'worker/background/schedulers/MonthlyImpactScheduler.ts:60',
  'worker/background/schedulers/OnboardingDripScheduler.ts:40',
  'worker/background/schedulers/RankingTrackingScheduler.ts:82',
  'worker/background/schedulers/WeeklySummaryScheduler.ts:71',
  'worker/ingress/stripe/apply-subscription-state.ts:343',
  'worker/ingress/stripe/apply-subscription-state.ts:356',
  'worker/ingress/stripe/apply-subscription-state.ts:369',
  'worker/ingress/stripe/apply-subscription-state.ts:379',
  'worker/ingress/stripe/apply-subscription-state.ts:412',
  'worker/ingress/stripe/apply-subscription-state.ts:423',
  'worker/ingress/stripe/apply-subscription-state.ts:432',
  'worker/ingress/stripe/apply-subscription-state.ts:435',
  'worker/ingress/stripe/shared.ts:112',
  // ── dashboard view-model discriminant union (type-level literals; the union
  //    mixes enum statuses with synthetic states like 'active_pending_business') ──
  'src/lib/dashboard/types.ts:148',
  'src/lib/dashboard/types.ts:167',
  'src/lib/dashboard/types.ts:176',
  'src/lib/dashboard/types.ts:283',
]);

/** True when the trimmed line begins a line/block comment (so a status literal
 * mentioned in prose is not mistaken for code). */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const LEGACY_TIER_VALUES = new Set(['basic', 'standard', 'premium', 'founders', 'founding']);
const LEGACY_TIER_ENUM_MEMBERS = new Set(['BASIC', 'STANDARD', 'PREMIUM', 'FOUNDERS']);
const LEGACY_PLAN_COPY = /\b(basic|standard|premium|founders|founding)\b/gi;
const TIER_CONTEXT_MARKER = /(?:subscription_?tier|subscriptionTier|SubscriptionTier|tier(?:Config|Limit|Map|For)?|TIER_|plan(?:Tier)?|priceTier)/i;
const TIER_CALL_MARKER = /(?:tier|quota|subscription|plan|payment|price|cost|summary|triage|judge)/i;
const VARIANT_CONTEXT_MARKER = /(?:price_?variant|PriceVariant|PRICE_VARIANTS|variant)/i;

function isFoundingPriceVariantSql(raw: string, matchIndex: number): boolean {
  const prefix = raw.slice(0, matchIndex);
  const boundary = Math.max(prefix.lastIndexOf(','), prefix.lastIndexOf('\n'), prefix.lastIndexOf(';'));
  return /price_variant\s*(?:=|:)\s*$/i.test(prefix.slice(boundary + 1));
}

function legacyPlanCopyTerms(raw: string): string[] {
  const matches = [...raw.matchAll(LEGACY_PLAN_COPY)];
  if (matches.length === 0) return [];
  return matches.flatMap((match) => {
    const term = match[1]!.toLowerCase();
    const technicalUse =
      (term === 'basic' && /\bbasic (?:auth|authentication)\b/i.test(raw))
      || (term === 'standard' && /\bstandard (?:confirmation|library|cancellation)\b/i.test(raw));
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const planLike = new RegExp(
        `(?:\\b(?:plan|tier)\\s+${escaped}\\b|\\b${escaped}\\s+(?:plan|tier)\\b|\\b(?:upgrade(?:\\s+to)?|supported\\s+on)\\s+(?:the\\s+)?${escaped}\\b|\\b${escaped}\\s+includes?\\b)`,
        'i',
      ).test(raw);
    const labelUse = new RegExp(`^\\s*${escaped}\\s*:`, 'i').test(raw);
    return !technicalUse && (planLike || labelUse) ? [term] : [];
  });
}

function callDirectlyContainsNodeArgument(call: ts.CallExpression, node: ts.Node): boolean {
  return call.arguments.some(
    (argument) => argument.getStart() <= node.getStart() && node.getEnd() <= argument.getEnd(),
  );
}

function isTierAssertionLiteral(
  call: ts.CallExpression,
  node: ts.StringLiteralLike,
  source: ts.SourceFile,
): boolean {
  if (!callDirectlyContainsNodeArgument(call, node)) return false;
  if (ts.isPropertyAccessExpression(call.expression)) {
    const receiver = call.expression.expression;
    if (
      ts.isCallExpression(receiver)
      && callTargetText(receiver.expression, source) === 'expect'
    ) {
      return receiver.arguments.some((argument) =>
        TIER_CONTEXT_MARKER.test(argument.getText(source))
      );
    }
  }
  const target = callTargetText(call.expression, source);
  if (!/^(?:assert\.)?(?:equal|strictEqual|deepEqual)$/.test(target)) return false;
  return call.arguments.some((argument) =>
    !(argument.getStart() <= node.getStart() && node.getEnd() <= argument.getEnd())
    && TIER_CONTEXT_MARKER.test(argument.getText(source))
  );
}

function nodeNameText(node: ts.Node | undefined, source: ts.SourceFile): string {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return node.getText(source);
}

function callTargetText(expression: ts.Expression, source: ts.SourceFile): string {
  if (ts.isCallExpression(expression)) return callTargetText(expression.expression, source);
  if (ts.isPropertyAccessExpression(expression)) {
    return `${callTargetText(expression.expression, source)}.${expression.name.text}`;
  }
  if (ts.isElementAccessExpression(expression)) {
    return callTargetText(expression.expression, source);
  }
  return expression.getText(source);
}

function enclosingStatementText(node: ts.Node, source: ts.SourceFile): string {
  let current: ts.Node | undefined = node;
  while (current && !ts.isStatement(current)) current = current.parent;
  return (current ?? node).getText(source);
}

function isPriceVariantLiteral(node: ts.StringLiteralLike, source: ts.SourceFile): boolean {
  if (node.text !== 'founding') return false;
  const parent = node.parent;
  // A variant-named result/property must never hide a retired tier comparison
  // nested inside its initializer (for example subscriptionTier === 'founding').
  if (ts.isBinaryExpression(parent)) {
    const other = parent.left === node ? parent.right : parent.left;
    if (TIER_CONTEXT_MARKER.test(other.getText(source))) return false;
  }
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent))
    && VARIANT_CONTEXT_MARKER.test(nodeNameText(parent.name, source))
  ) {
    return true;
  }
  if (
    ts.isJsxAttribute(parent)
    && VARIANT_CONTEXT_MARKER.test(nodeNameText(parent.name, source))
  ) {
    return true;
  }
  let current: ts.Node | undefined = node;
  while (current && !ts.isStatement(current)) {
    if (
      (ts.isTypeAliasDeclaration(current) || ts.isVariableDeclaration(current))
      && VARIANT_CONTEXT_MARKER.test(nodeNameText(current.name, source))
    ) {
      return true;
    }
    if (
      (ts.isPropertyAssignment(current) || ts.isPropertySignature(current))
      && VARIANT_CONTEXT_MARKER.test(nodeNameText(current.name, source))
    ) {
      return true;
    }
    if (
      ts.isJsxAttribute(current)
      && VARIANT_CONTEXT_MARKER.test(nodeNameText(current.name, source))
    ) {
      return true;
    }
    current = current.parent;
  }
  if (ts.isCallExpression(parent)) {
    const callee = callTargetText(parent.expression, source);
    const index = parent.arguments.indexOf(node);
    if ((callee.endsWith('resolveTierSnapshot') || callee.endsWith('priceIdFor')) && index === 1) {
      return true;
    }
    if (
      /createCheckoutSession/i.test(parent.expression.getText(source))
      && index === 3
    ) return true;
    if (VARIANT_CONTEXT_MARKER.test(callee)) return true;
  }
  if (ts.isBinaryExpression(parent)) {
    const other = parent.left === node ? parent.right : parent.left;
    if (VARIANT_CONTEXT_MARKER.test(other.getText(source))) return true;
  }
  let switchChild: ts.Node = node;
  let switchParent: ts.Node | undefined = parent;
  while (switchParent && !ts.isStatement(switchParent)) {
    switchChild = switchParent;
    switchParent = switchParent.parent;
  }
  if (
    switchParent
    && ts.isSwitchStatement(switchParent)
    && VARIANT_CONTEXT_MARKER.test(switchParent.expression.getText(source))
    && switchParent.caseBlock.getStart(source) <= switchChild.getStart(source)
  ) {
    return true;
  }
  return false;
}

function isFoundingVariantProperty(node: ts.PropertyAssignment, source: ts.SourceFile): boolean {
  if (nodeNameText(node.name, source) !== 'founding') return false;
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isStatement(current)) {
    if (
      ts.isPropertyAssignment(current)
      && VARIANT_CONTEXT_MARKER.test(nodeNameText(current.name, source))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isTierLiteralContext(node: ts.StringLiteralLike, source: ts.SourceFile): boolean {
  if (isPriceVariantLiteral(node, source)) return false;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      (ts.isPropertyAssignment(current) || ts.isPropertySignature(current))
      && TIER_CONTEXT_MARKER.test(nodeNameText(current.name, source))
    ) {
      return true;
    }
    if (
      ts.isJsxAttribute(current)
      && TIER_CONTEXT_MARKER.test(nodeNameText(current.name, source))
    ) {
      return true;
    }
    if (
      (ts.isVariableDeclaration(current)
        || ts.isParameter(current)
        || ts.isTypeAliasDeclaration(current))
      && (
        TIER_CONTEXT_MARKER.test(nodeNameText(current.name, source))
        || TIER_CONTEXT_MARKER.test(current.type?.getText(source) ?? '')
      )
    ) {
      return true;
    }
    if (
      ts.isCallExpression(current)
      && (
        TIER_CALL_MARKER.test(callTargetText(current.expression, source))
        || isTierAssertionLiteral(current, node, source)
      )
    ) {
      return true;
    }
    if (ts.isBinaryExpression(current)) {
      const other = current.left.getStart(source) <= node.getStart(source)
        && node.getStart(source) < current.left.getEnd()
        ? current.right
        : current.left;
      if (TIER_CONTEXT_MARKER.test(other.getText(source))) return true;
    }
    if (
      (ts.isFunctionDeclaration(current)
        || ts.isFunctionExpression(current)
        || ts.isMethodDeclaration(current)
        || ts.isArrowFunction(current))
      && (
        TIER_CONTEXT_MARKER.test(nodeNameText(current.name, source))
        || TIER_CONTEXT_MARKER.test(current.type?.getText(source) ?? '')
      )
    ) {
      return true;
    }
    if (
      ts.isEnumDeclaration(current)
      && TIER_CONTEXT_MARKER.test(nodeNameText(current.name, source))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

/** Context-aware mechanical proof that removed values cannot re-enter the tier domain. */
export function scanLegacySubscriptionTiers(file: string, text: string): PolicyFinding[] {
  if (LEGACY_TIER_HISTORY_EXCLUSIONS.has(normalize(file))) return [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: PolicyFinding[] = [];
  const seen = new Set<string>();
  const add = (position: number, value: string) => {
    const line = lineOf(source, position);
    const key = `${line}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      file,
      line,
      rule: 'legacy-subscription-tier',
      detail: `removed subscription tier ${JSON.stringify(value)}; use copilot/autopilot and keep founding only in PriceVariant`,
    });
  };

  // One-step identifier indirection is common in schema declarations:
  // `const values = ['standard']; const subscriptionTierSchema = z.enum(values)`.
  // Record the source literal so the later tier-domain use reports its origin.
  const indirectBindings = new Map<string, {
    declarationStart: number;
    literals: Array<{ position: number; value: string }>;
  }>();
  const collectIndirectBindings = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      const literals: Array<{ position: number; value: string }> = [];
      const collectLiterals = (candidate: ts.Node): void => {
        if (ts.isStringLiteralLike(candidate)) {
          const value = candidate.text.toLowerCase();
          if (
            LEGACY_TIER_VALUES.has(value)
            && !isPriceVariantLiteral(candidate, source)
          ) {
            literals.push({ position: candidate.getStart(source), value });
          }
        }
        ts.forEachChild(candidate, collectLiterals);
      };
      collectLiterals(node.initializer);
      if (literals.length > 0) {
        indirectBindings.set(node.name.text, {
          declarationStart: node.name.getStart(source),
          literals,
        });
      }
    }
    ts.forEachChild(node, collectIndirectBindings);
  };
  collectIndirectBindings(source);

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && node.expression.getText(source).endsWith('SubscriptionTier')
      && LEGACY_TIER_ENUM_MEMBERS.has(node.name.text)
    ) {
      add(node.name.getStart(source), node.name.text);
    }
    if (ts.isEnumMember(node) && ts.isEnumDeclaration(node.parent)) {
      const enumName = nodeNameText(node.parent.name, source);
      const memberName = nodeNameText(node.name, source);
      if (
        TIER_CONTEXT_MARKER.test(enumName)
        && LEGACY_TIER_ENUM_MEMBERS.has(memberName.toUpperCase())
      ) {
        add(node.name.getStart(source), memberName.toLowerCase());
      }
    }
    if (ts.isIdentifier(node)) {
      const binding = indirectBindings.get(node.text);
      if (
        binding
        && node.getStart(source) !== binding.declarationStart
        && TIER_CONTEXT_MARKER.test(enclosingStatementText(node, source))
      ) {
        for (const literal of binding.literals) add(literal.position, literal.value);
      }
    }
    if (ts.isStringLiteralLike(node)) {
      const normalizedValue = node.text.toLowerCase();
      if (LEGACY_TIER_VALUES.has(normalizedValue) && isTierLiteralContext(node, source)) {
        add(node.getStart(source), normalizedValue);
      }
      for (const value of legacyPlanCopyTerms(node.text)) {
        add(node.getStart(source), value);
      }
      const raw = node.text;
      if (/subscription_?tier/i.test(raw)) {
        const oldValue = /['"](basic|standard|premium|founders|founding)['"]/g;
        for (const match of raw.matchAll(oldValue)) {
          const value = match[1]!;
          if (value === 'founding' && isFoundingPriceVariantSql(raw, match.index ?? 0)) continue;
          add(node.getStart(source), value);
        }
      }
    }
    if (ts.isTemplateExpression(node) && /subscription_?tier/i.test(node.getText(source))) {
      const raw = node.getText(source);
      for (const match of raw.matchAll(/['"](basic|standard|premium|founders|founding)['"]/g)) {
        const value = match[1]!;
        if (value === 'founding' && isFoundingPriceVariantSql(raw, match.index ?? 0)) continue;
        add(node.getStart(source), value);
      }
    }
    if (
      ts.isPropertyAssignment(node)
      && LEGACY_TIER_VALUES.has(nodeNameText(node.name, source).toLowerCase())
      && !isFoundingVariantProperty(node, source)
      && TIER_CONTEXT_MARKER.test(enclosingStatementText(node, source))
    ) {
      add(node.name.getStart(source), nodeNameText(node.name, source).toLowerCase());
    }
    if (
      ts.isShorthandPropertyAssignment(node)
      && LEGACY_TIER_VALUES.has(node.name.text.toLowerCase())
      && TIER_CONTEXT_MARKER.test(enclosingStatementText(node, source))
    ) {
      add(node.name.getStart(source), node.name.text.toLowerCase());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

// ── SQL-executor tag naming (#592) ──────────────────────────────────────
//
// The four SQL vocabulary audits (reviews-status, outbox-topics, outbox-status,
// response-status) find SQL by tag NAME, via sql-tag-scan's SQL_TAG_NAMES. A
// template tagged with any other name is invisible to all four — and invisible
// silently, because a scan that matches nothing reports success. `exec` was
// missing from that set for months across 12 call sites, `src/lib/shared/
// outbox.ts` among them.
//
// This rule closes the loop from the other side: a SqlExecutor-typed parameter
// used as a template tag must be named something the scanners recognise. It is
// deliberately narrow — a parameter merely PASSED along (`archive(client, id)`)
// carries no SQL text and is not the scanners' business; only a parameter that
// is actually a tag hides SQL.
//
// Scoped to src/ + worker/ because that is what those four audits scan.
// `scripts/` is outside their reach (e.g. health-bundle-differential.ts's
// `observer`, which queries pg_stat_activity, not a domain table).

/** Type annotations that make a parameter a Postgres.js executor. */
const SQL_EXECUTOR_TYPE = /\b(?:Sql|TransactionSql|SqlExecutor)\b/;

/** Identifier at the root of a tagged template's tag, if it has one. */
function taggedTemplateRootName(node: ts.TaggedTemplateExpression): string | undefined {
  if (ts.isIdentifier(node.tag)) return node.tag.text;
  if (ts.isPropertyAccessExpression(node.tag) && ts.isIdentifier(node.tag.expression)) {
    return node.tag.expression.text;
  }
  return undefined;
}

/** Every identifier used as a template tag anywhere inside `node`'s body. */
function tagNamesUsedIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const collect = (inner: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(inner)) {
      const root = taggedTemplateRootName(inner);
      if (root !== undefined) names.add(root);
    }
    ts.forEachChild(inner, collect);
  };
  ts.forEachChild(node, collect);
  return names;
}

/**
 * Flag SqlExecutor-typed parameters that tag SQL templates under a name the
 * vocabulary audits do not scan. Pure — unit-tested.
 */
export function scanSqlExecutorTagNames(file: string, text: string): PolicyFinding[] {
  if (!/^(?:src|worker)[/\\]/.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: PolicyFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node.parameters.length > 0) {
      const executorParams = node.parameters.filter(
        (parameter) =>
          parameter.type !== undefined &&
          ts.isIdentifier(parameter.name) &&
          SQL_EXECUTOR_TYPE.test(parameter.type.getText(source)),
      );
      if (executorParams.length > 0) {
        const tagged = tagNamesUsedIn(node);
        for (const parameter of executorParams) {
          const name = (parameter.name as ts.Identifier).text;
          if (!tagged.has(name) || SQL_TAG_NAMES.has(name)) continue;
          findings.push({
            file,
            line: source.getLineAndCharacterOfPosition(parameter.getStart(source)).line + 1,
            rule: 'sql-executor-tag-name',
            detail:
              `\`${name}\` tags SQL templates but is not in SQL_TAG_NAMES, so ` +
              'the reviews-status, outbox-topics, outbox-status and ' +
              'response-status audits cannot see them (#592). Rename it to ' +
              `one of ${[...SQL_TAG_NAMES].sort().join(', ')}, or add the ` +
              'spelling to scripts/ci/lib/sql-tag-scan.ts.',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

const NODE_ENV = 'NODE_ENV';

// The one sanctioned exemption to the rule below. This poller's read is a
// production-only guard on a destructive purge-window override; migrating it to
// the deployment-lane owner is tracked by #614. Delete this entry — and the read
// it protects — when #614 lands; nothing else may be added here.
const NODE_ENV_READ_EXEMPT_FILES: ReadonlySet<string> = new Set([
  'worker/background/pollers/AccountOffboardingPurgePoller.ts',
]);

const NODE_ENV_READ_DETAIL =
  'worker code must not ask NODE_ENV which deployment lane it is on (#611, ADR ' +
  '0013): production Railway leaves it unset and staging sets it to production, ' +
  'so the answer is wrong on at least one lane. Use requiresProductionConfig() / ' +
  'deploymentLane() from src/lib/config/deployment-lane.ts.';

/** `process.env` — dot form, or the `process['env']` bracket spelling. */
function isProcessEnvExpression(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return ts.isIdentifier(node.expression)
      && node.expression.text === 'process'
      && node.name.text === 'env';
  }
  if (ts.isElementAccessExpression(node)) {
    return ts.isIdentifier(node.expression)
      && node.expression.text === 'process'
      && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === 'env';
  }
  return false;
}

/** The expression an object binding pattern destructures, if it has one. */
function bindingPatternInitializer(node: ts.ObjectBindingPattern): ts.Expression | undefined {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) {
    return parent.initializer;
  }
  return undefined;
}

/** The SOURCE property a binding element reads — `propertyName` when renamed. */
function bindingElementKey(element: ts.BindingElement): string | undefined {
  const key = element.propertyName ?? element.name;
  if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text;
  if (ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression)) {
    return key.expression.text;
  }
  return undefined;
}

/**
 * Ban the statically identifiable READ of NODE_ENV under `worker/` (#611).
 *
 * Banning the read rather than enumerating `=== 'production'` comparison shapes
 * is both simpler and strictly stronger: this audit scans each file
 * independently with no symbol resolution, so
 * `export const runtimeMode = process.env.NODE_ENV` in one worker file plus
 * `if (runtimeMode === 'production')` in another would evade any
 * comparison-shaped rule. If the read cannot exist, neither can the export.
 *
 * AST rather than a line scan is what makes the no-false-positive requirement
 * satisfiable: comments are trivia and never become nodes, and a bare string is
 * not a `process.env` member-access subtree — so a NODE_ENV mention in prose or
 * an error message is excluded structurally, not by pattern-matching.
 *
 * Scope of the guarantee, stated honestly. "Statically identifiable" covers
 * property access, bracket access with a string literal, template-literal
 * access, and destructuring (including renamed and computed-string keys). It
 * does NOT cover a dynamic key (`const k = 'NODE_ENV'; process.env[k]`) or a
 * whole-object alias (`const env = process.env; env.NODE_ENV`) — neither is
 * decidable without symbol resolution this audit does not have. Rejecting ALL
 * dynamic `process.env[…]` access is not an option: worker/config/startup-assert.ts
 * legitimately iterates required-variable NAME LISTS that way, so a bracket read
 * is flagged only when its key is a literal resolving to NODE_ENV.
 *
 * `src/**` is deliberately out of scope: cookies, the logger, impersonation and
 * destructive-auth branch on NODE_ENV for genuine dev-vs-prod runtime behaviour
 * and would each need a judgement-call allowlist entry. ADR 0013 records that as
 * a decision, not an oversight.
 */
export function scanWorkerNodeEnvReads(file: string, text: string): PolicyFinding[] {
  const normalized = normalize(file);
  if (!/^worker[/\\]/.test(normalized)) return [];
  if (NODE_ENV_READ_EXEMPT_FILES.has(normalized)) return [];

  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: PolicyFinding[] = [];
  const flag = (position: number, form: string): void => {
    findings.push({
      file,
      line: lineOf(source, position),
      rule: 'worker-node-env-read',
      detail: `${form} — ${NODE_ENV_READ_DETAIL}`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && node.name.text === NODE_ENV
      && isProcessEnvExpression(node.expression)
    ) {
      flag(node.name.getStart(source), 'process.env.NODE_ENV');
    } else if (
      ts.isElementAccessExpression(node)
      && isProcessEnvExpression(node.expression)
      && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === NODE_ENV
    ) {
      flag(node.argumentExpression.getStart(source), 'bracket read of NODE_ENV on process.env');
    } else if (ts.isObjectBindingPattern(node)) {
      const initializer = bindingPatternInitializer(node);
      if (initializer !== undefined && isProcessEnvExpression(initializer)) {
        for (const element of node.elements) {
          if (bindingElementKey(element) !== NODE_ENV) continue;
          flag(element.getStart(source), 'NODE_ENV destructured off process.env');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** Scan one file's text for both forbidden patterns. Pure — unit-tested. */
export function scanFile(file: string, text: string): PolicyFinding[] {
  const findings: PolicyFinding[] = [
    ...scanLegacySubscriptionTiers(file, text),
    ...scanSqlExecutorTagNames(file, text),
    ...scanWorkerNodeEnvReads(file, text),
  ];
  const lines = text.split('\n');
  const isClientComponent = isClientComponentFile(text);
  // The subscription-status enum rule targets application code only. `scripts/`
  // (CI tooling, audit allowlist DATA that names real queries) legitimately
  // carries status literals as data and cannot meaningfully import the enum.
  const inAppCode = /^(?:src|worker)[/\\]/.test(file);
  const flagBanApplies = !isFlagBanExempt(file);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;

    if (CRYPTO_JS_SPECIFIER.test(lineText)) {
      findings.push({
        file,
        line: i + 1,
        rule: 'crypto-js',
        detail: 'imports the banned crypto-js package — invariant #10: use node:crypto',
      });
    }

    for (const match of lineText.matchAll(NEXT_PUBLIC_ACCESS)) {
      const name = match[1] ?? match[2]!;
      if (!ALLOWED_NEXT_PUBLIC.has(name)) {
        findings.push({
          file,
          line: i + 1,
          rule: 'next-public-allowlist',
          detail:
            `${name} is not allowlisted — invariant #13: feature flags are ` +
            'server-authoritative (no NEXT_PUBLIC_ companion). If genuinely ' +
            'browser-safe and not a flag, add it to ALLOWED_NEXT_PUBLIC.',
        });
      }
    }

    if (flagBanApplies && !isCommentLine(lineText)) {
      for (const match of lineText.matchAll(INLINE_FLAG_ACCESS)) {
        const flagName = match[1] ?? match[2]!;
        findings.push({
          file,
          line: i + 1,
          rule: 'inline-feature-flag',
          detail:
            `inline read of feature flag ${flagName} — invariant #13: route it ` +
            'through the readFlag primitive behind a <feature>/flags.ts accessor ' +
            '(e.g. selfServeSignupEnabled()), never a raw process.env.*_ENABLED read.',
        });
      }
    }

    if (
      inAppCode &&
      !isCommentLine(lineText) &&
      SUBSCRIPTION_STATUS_FIELD.test(lineText) &&
      SUBSCRIPTION_STATUS_LITERAL.test(lineText) &&
      !SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.has(`${file}:${i + 1}`)
    ) {
      findings.push({
        file,
        line: i + 1,
        rule: 'subscription-status-literal',
        detail:
          'bare subscription-status string literal — use the SubscriptionStatus ' +
          'enum (src/lib/shared/subscription-status.ts), not a raw string. If this ' +
          'is a SQL predicate or a type-level discriminant that cannot import the ' +
          'enum, add file:line to SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.',
      });
    }

    if (isClientComponent) {
      for (const { table, pattern } of SERVER_OWNED_BROWSER_FORBIDDEN_TABLE_PATTERNS) {
        if (!pattern.test(lineText)) continue;
        findings.push({
          file,
          line: i + 1,
          rule: 'server-owned-table-browser-access',
          detail:
            `client components must not access ${table} directly; ` +
            'server-owned table reads/writes must flow through server routes',
        });
      }

      // A type-only import (`import type … from`) erases at build time and is
      // harmless; everything else pulls runtime code (and its env secrets).
      if (!/^\s*import\s+type\b/.test(lineText)) {
        for (const match of lineText.matchAll(MODULE_SPECIFIER_RE)) {
          if (!isDbServerSpecifier(match[1]!)) continue;
          findings.push({
            file,
            line: i + 1,
            rule: 'server-db-client-import',
            detail:
              'client components must not import @/lib/db/server (bundles ' +
              'DATABASE_POOL_URL / SUPABASE_SERVICE_KEY into the browser); ' +
              'DB access must flow through server routes',
          });
        }
      }
    }
  }
  return findings;
}

// Replica declarations in Railway config-as-code (#567, arch review R1).
//
// Four boot-time guards and the in-process LLM circuit breaker are correct ONLY
// while the worker is a single replica, and the scaling backlog's P2 pollers
// become duplicate-processing bugs the moment a second one runs. Config-as-code
// OVERRIDES the dashboard (docs.railway.com/config-as-code/reference), so a
// replica count landing in this file is the one scale-out path a static check
// can actually block. `numReplicas` is only reachable nested under
// `deploy.multiRegionConfig.<region>`, so both spellings are banned; replicas
// set in the Railway dashboard are invisible here and are instead surfaced at
// boot by worker/config/replica-identity.ts.
const RAILWAY_REPLICA_KEYS: ReadonlySet<string> = new Set(['numReplicas', 'multiRegionConfig']);

// Matches a banned name used as a KEY, wherever it sits on the line — bare or
// quoted, then `=`/`:` (assignment), `.` (dotted path), or `]`/`}` (table
// header / inline table close). Deliberately NOT line-anchored: anchoring on
// the key made compact JSON, dotted TOML keys, and inline tables slip past
// while still reading as "replicas are banned".
const RAILWAY_REPLICA_KEY_TOKEN =
  /(?:^|[\s.,{[])["']?(?:numReplicas|multiRegionConfig)["']?\s*(?=[=:.\]}])/;

const RAILWAY_REPLICA_DETAIL =
  'Railway replica config must not be declared — the worker is single-replica by ' +
  'invariant (four boot guards + the in-process LLM circuit breaker depend on it). ' +
  'Clear the P2 "multi-replica latent races" items in ' +
  'docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md first.';

/**
 * Drop a TOML `#` comment, honouring quoted strings so a `#` inside a value
 * does not truncate the line. The old rule only ignored comments as a side
 * effect of its line anchor; matching keys mid-line makes this explicit.
 */
function stripTomlComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inBasic) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/** Collect every banned key name appearing at any depth of a parsed JSON value. */
function collectBannedReplicaKeys(value: unknown, hits: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBannedReplicaKeys(item, hits);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (RAILWAY_REPLICA_KEYS.has(key)) hits.add(key);
    collectBannedReplicaKeys(child, hits);
  }
}

/** 1-indexed line where `key` first appears, so a structural hit still points somewhere. */
function firstLineContaining(text: string, key: string): number {
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(key));
  return index >= 0 ? index + 1 : 1;
}

export function auditRailwayConfig(file: string, text: string): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const flag = (line: number): void => {
    findings.push({ file, line, rule: 'railway-replicas', detail: RAILWAY_REPLICA_DETAIL });
  };

  // railway.json parses exactly, so walk the tree rather than pattern-match it:
  // nesting and formatting (compact or pretty) then cannot hide a declaration,
  // and a banned name inside a string VALUE cannot false-fire.
  if (file.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined; // malformed: fall through rather than pass silently
    }
    if (parsed !== undefined) {
      const hits = new Set<string>();
      collectBannedReplicaKeys(parsed, hits);
      for (const key of [...hits].sort()) flag(firstLineContaining(text, key));
      return findings.sort((a, b) => a.line - b.line);
    }
  }

  // TOML (and unparseable JSON) — token scan. A banned name inside a TOML string
  // value can false-fire; that asymmetry is deliberate. A false positive is loud
  // and one rename away, a false negative silently breaks the invariant.
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = file.endsWith('.toml') ? stripTomlComment(raw) : raw;
    if (isCommentLine(line)) return;
    if (RAILWAY_REPLICA_KEY_TOKEN.test(line)) flag(index + 1);
  });
  return findings;
}

/** Forbid crypto-js as a declared dependency. Pure — unit-tested. */
export function auditPackageJson(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): PolicyFinding[] {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (Object.prototype.hasOwnProperty.call(deps, 'crypto-js')) {
    return [
      {
        file: 'package.json',
        line: 0,
        rule: 'crypto-js',
        detail: 'crypto-js must not be a dependency — invariant #10: use node:crypto',
      },
    ];
  }
  return [];
}

async function main(): Promise<void> {
  const root = process.cwd();

  const files = await walk(root, { scanDirs: SCAN_DIRS, scanExt: SCAN_EXT, skipDirs: SKIP_DIRS });

  const findings: PolicyFinding[] = [];
  for (const file of files) {
    if (file === SELF) continue;
    findings.push(...scanFile(file, await readFile(resolve(root, file), 'utf8')));
  }

  // Existing policy rules intentionally skip tests. Legacy-tier removal needs a
  // stronger mechanical proof across fixtures/e2e too, without widening every
  // unrelated rule into test code.
  const legacyTierFiles = await walk(root, {
    scanDirs: LEGACY_TIER_SCAN_DIRS,
    scanExt: SCAN_EXT,
    skipDirs: LEGACY_TIER_SKIP_DIRS,
    skipFile: /a^/,
  });
  const alreadyScanned = new Set(files);
  for (const file of legacyTierFiles) {
    if (file === SELF || alreadyScanned.has(file)) continue;
    findings.push(
      ...scanLegacySubscriptionTiers(file, await readFile(resolve(root, file), 'utf8')),
    );
  }

  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  findings.push(...auditPackageJson(pkg));

  for (const railwayConfig of ['railway.toml', 'railway.json']) {
    const text = await readFile(resolve(root, railwayConfig), 'utf8').catch(() => undefined);
    if (text !== undefined) findings.push(...auditRailwayConfig(railwayConfig, text));
  }

  if (findings.length > 0) {
    console.error('static-policy-audit: failed');
    for (const f of findings) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      console.error(`${loc} [${f.rule}] ${f.detail}`);
    }
    process.exit(1);
  }
  console.log(`static-policy-audit: passed (${files.length} files scanned)`);
  console.log(
    'static-policy-audit: subscription-status literal carve-outs allowlisted: ' +
    `${SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST.size}`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('static-policy-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
