import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard for issue #79. A page under src/app/(public)/ has no auth cookies, so
 * Next 16 tries to STATICALLY PRERENDER it at build time — executing its server
 * component, including any `await sql`…`` query. If such a page does not opt out
 * with `export const dynamic = 'force-dynamic'`, `next build` collects its page
 * data and hard-fails whenever DATABASE_POOL_URL is absent or the DB is
 * unreachable.
 *
 * This guard discovers every public page that DIRECTLY imports the Postgres
 * client module and asserts it declares force-dynamic. New public DB-backed
 * pages are covered automatically — no hand-maintained list.
 *
 * Scope limit: only DIRECT imports of '@/lib/db/server' are detected. A page
 * that reaches Postgres exclusively through a transitive helper is not covered;
 * direct `sql` use is the realistic prerender hazard.
 */
const PUBLIC_ROOT = join(process.cwd(), 'src', 'app', '(public)');
const DB_CLIENT_MODULE = '@/lib/db/server';
const FORCE_DYNAMIC = /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/;

function dbBackedPublicPages(): string[] {
  return readdirSync(PUBLIC_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('page.tsx'))
    .map((entry) => join(PUBLIC_ROOT, entry))
    .filter((file) => readFileSync(file, 'utf8').includes(DB_CLIENT_MODULE))
    .map((file) => relative(process.cwd(), file));
}

const pages = dbBackedPublicPages();

describe('(public) DB-backed pages declare force-dynamic (issue #79)', () => {
  it('discovers the known DB-backed public pages', () => {
    // Fail loudly if the glob matches nothing, so the suite can't pass vacuously.
    expect(pages.length).toBeGreaterThanOrEqual(2);
  });

  it.each(pages)('%s opts out of build-time prerender', (relPath) => {
    expect(readFileSync(join(process.cwd(), relPath), 'utf8')).toMatch(
      FORCE_DYNAMIC,
    );
  });
});
