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
// calls requireAdminWithAal2. The helper names are stable; their gating is
// verified by Task 5 tests. Calling any of these is equivalent to calling
// requireAdminWithAal2 directly from the route's perspective.
const GATED_SHARED_HELPERS = [
  'runAdminChannelStart',
  'runAdminChannelCancel',
  'runAdminChannelDisable',
] as const;

/**
 * Pure scan function — no FS access. Returns a list of finding messages
 * (empty array = file is clean).
 *
 * A finding is emitted when ALL three conditions hold:
 *   1. `path` is under `src/app/api/admin/`
 *   2. `text` exports a mutation verb (POST | PUT | PATCH | DELETE)
 *   3. `text` does NOT contain `requireAdminWithAal2`
 */
export function scanRouteFile(path: string, text: string): string[] {
  // Normalize to forward slashes for cross-platform consistency.
  const normalized = path.replace(/\\/g, '/');

  // Only admin routes are in scope.
  if (!normalized.includes('src/app/api/admin/')) return [];

  // No mutation verb → nothing to check.
  if (!MUTATION_VERB_RE.test(text)) return [];

  // Mutation verb found — gate must be present, either directly in this file
  // or via a known pre-gated shared helper (thin delegator pattern).
  if (text.includes(GATE_TOKEN)) return [];
  if (GATED_SHARED_HELPERS.some((helper) => text.includes(helper))) return [];

  return [
    `${path} [admin-aal2] mutation route must use ${GATE_TOKEN}`,
  ];
}

async function collectRouteFiles(dir: string, root: string, out: string[]): Promise<void> {
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
