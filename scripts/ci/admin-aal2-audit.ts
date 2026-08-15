import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Enforces invariant #3 (no unapproved posting) and the admin-AAL2 contract
 * (deep-scan §F-1): every admin route that exports a state-mutating HTTP verb
 * (POST, PUT, PATCH, DELETE) must call `requireAdminWithAal2` before doing
 * any work, so MFA step-up is uniformly enforced on all admin mutations.
 *
 * Scope: `src/app/api/admin/**\/route.ts` only.
 * Detection: file-level text scan — if a mutation verb export is present AND
 * `requireAdminWithAal2` is absent, the file is flagged.
 */

// Matches: `export const POST = ...` OR `export async function POST(`
// Covers POST, PUT, PATCH, DELETE in both declaration styles.
const MUTATION_VERB_RE =
  /export\s+(?:const\s+(?:POST|PUT|PATCH|DELETE)|async\s+function\s+(?:POST|PUT|PATCH|DELETE))\b/;

const GATE_TOKEN = 'requireAdminWithAal2';

// Thin route files that delegate entirely to a shared helper which itself
// calls requireAdminWithAal2. Naming one of these is equivalent to calling
// requireAdminWithAal2 directly from the route's perspective.
//
// This list names the RESOLVER, not the runners, and that distinction is
// load-bearing. Before the channel-route unification it named
// runAdminChannelStart/Cancel/Disable — admin-only helpers that called
// requireAdminWithAal2 unconditionally. Their successors
// (runChannelStart/Cancel/Disable, src/app/api/_shared/channels/) are
// PORTAL-AGNOSTIC: they call `config.resolveActor`, which is resolveAdminActor
// on an admin route and resolveOwnerActor on an owner route. Listing a runner
// here would therefore pass an admin route that bound resolveOwnerActor,
// silently exempting an admin mutation from MFA step-up.
//
// resolveAdminActor (src/app/api/_shared/channels/resolve-actor.ts) is the
// function that actually calls the gate, so it is the only safe token — and
// this is strictly stronger than the three names it replaces.
const GATED_SHARED_HELPERS = ['resolveAdminActor'] as const;

// The owner-portal resolver. An admin route has no legitimate reason to name it:
// resolveOwnerActor runs behind requireRoleOr401 against the SESSION with no MFA
// step-up, so an admin route that binds it is an admin mutation with the AAL2
// gate silently removed.
//
// This deny rule exists because the allowlist above is a SUBSTRING test over the
// whole file, which a mere MENTION satisfies — a header comment naming
// resolveAdminActor (every channel route carries one) or a leftover import would
// clear a route that actually binds the owner resolver. The allowlist alone
// therefore could not catch the very regression it was repointed to catch.
// Flagged unconditionally: an admin route naming BOTH resolvers is still wrong.
const OWNER_ONLY_RESOLVER = 'resolveOwnerActor';

/**
 * Strips comments so every check below reads CODE, not prose.
 *
 * A whole-file substring test is wrong in BOTH directions, and this audit hit
 * each one: a header comment naming `resolveAdminActor` would CLEAR the
 * allowlist for a route that actually binds the owner resolver (every channel
 * route carries such a header), and a header comment naming `resolveOwnerActor`
 * would TRIP the deny rule on a correctly-bound route — which is exactly what
 * `admin/channels/telegram/start/route.ts` does when it documents its owner
 * counterpart.
 *
 * Only FULL-LINE `//` comments are removed, so a string containing `https://` is
 * never mistaken for one. Block comments are removed outright; a `/*` inside a
 * string literal would over-strip, which is acceptable for a route-file
 * heuristic and fails safe (less text to clear the allowlist, not more).
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Pure scan function — no FS access. Returns a list of finding messages
 * (empty array = file is clean).
 *
 * A finding is emitted when `path` is under `src/app/api/admin/`, the file's CODE
 * (comments stripped) exports a mutation verb (POST | PUT | PATCH | DELETE), and
 * EITHER:
 *   - the code does NOT contain `requireAdminWithAal2` nor a gated shared helper, OR
 *   - the code references `resolveOwnerActor` at all (deny rule — see above).
 */
export function scanRouteFile(path: string, text: string): string[] {
  // Normalize to forward slashes for cross-platform consistency.
  const normalized = path.replace(/\\/g, '/');

  // Only admin routes are in scope.
  if (!normalized.includes('src/app/api/admin/')) return [];

  // Every check below reads code, never prose — see stripComments.
  const code = stripComments(text);

  // No mutation verb → nothing to check.
  if (!MUTATION_VERB_RE.test(code)) return [];

  // Deny rule first — it outranks the allowlist, so naming the admin resolver in
  // live code cannot buy absolution for also binding the owner one.
  if (code.includes(OWNER_ONLY_RESOLVER)) {
    return [
      `${path} [admin-aal2] admin mutation route must not reference ${OWNER_ONLY_RESOLVER} ` +
        `(it runs behind requireRoleOr401 with no MFA step-up)`,
    ];
  }

  // Mutation verb found — gate must be present, either directly in this file
  // or via a known pre-gated shared helper (thin delegator pattern).
  if (code.includes(GATE_TOKEN)) return [];
  if (GATED_SHARED_HELPERS.some((helper) => code.includes(helper))) return [];

  return [
    `${path} [admin-aal2] mutation route must use ${GATE_TOKEN}`,
  ];
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
      await collectRouteFiles(join(dir, entry.name), root, out);
    } else if (entry.isFile() && entry.name === 'route.ts') {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const adminDir = resolve(root, 'src', 'app', 'api', 'admin');

  const files: string[] = [];
  await collectRouteFiles(adminDir, root, files);

  const findings: string[] = [];
  for (const file of files) {
    const text = await readFile(resolve(root, file), 'utf8');
    findings.push(...scanRouteFile(file, text));
  }

  if (findings.length > 0) {
    console.error('admin-aal2-audit: FAILED');
    for (const finding of findings) {
      console.error(finding);
    }
    process.exit(1);
  }

  console.log(`admin-aal2-audit: passed (${files.length} admin route files scanned)`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('admin-aal2-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
