// Guards the client/server value-import boundary for App Router server pages.
//
// A non-component value exported from a `'use client'` module is NOT that value
// on the server: the bundler replaces it with a client-reference stub. A server
// page that imports one and passes it onward — most damagingly as a SQL bind
// parameter — ships a FUNCTION where it meant a number:
//
//   PostgresError: invalid input syntax for type bigint:
//   "function(){throw Error("Attempted to call PAGE_SIZE() from the server but
//   PAGE_SIZE is on the client. ...")}"   (SQLSTATE 22P02)
//
// This is LATENT, which is what makes it worth a static guard rather than trust:
// whether the bundler inlines the constant or emits the stub depends on how the
// module graph happens to be chunked, so the same source can work for months and
// then break after an unrelated change shifts chunking. It went live on staging
// 2026-08-10 and took out seven admin pages with "Admin page failed to load",
// each having imported `PAGE_SIZE` from its sibling `*Client.tsx`.
//
// The cure is a server-safe owner module (src/app/admin/page-sizes.ts). Only the
// server-importing-from-client direction is a problem; client components may
// freely import from server-safe modules.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ADMIN_DIR = resolve(__dirname, '..');

/** Every `src/app/admin/**"/"page.tsx`, recursively (route groups included). */
function findServerPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...findServerPages(full));
    } else if (entry.name === 'page.tsx') {
      out.push(full);
    }
  }
  return out;
}

function isClientModule(file: string): boolean {
  if (!existsSync(file)) return false;
  // The directive must be the first statement; reading the head is enough.
  return /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(
    readFileSync(file, 'utf8'),
  );
}

/** Resolve a relative import specifier to a concrete .tsx/.ts file, if any. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe('admin server pages never import a VALUE from a client component module', () => {
  const pages = findServerPages(ADMIN_DIR);

  it('finds the admin server pages (guards the guard)', () => {
    // A traversal bug that returned [] would make every assertion below vacuous.
    expect(pages.length).toBeGreaterThan(5);
  });

  for (const page of pages) {
    const rel = page.slice(page.indexOf('src/app/admin'));

    it(`${rel} imports only components from its client modules`, () => {
      const src = readFileSync(page, 'utf8');
      // Server pages are not client modules themselves; if one ever is, the
      // whole question is moot and the page-chrome suite already covers it.
      if (/^\s*['"]use client['"]/.test(src)) return;

      const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](\.[^'"]+)['"]/g;
      const violations: string[] = [];

      for (const [, clause, spec] of src.matchAll(importRe)) {
        // Both groups are non-optional in the pattern, so a match always carries
        // them; the guard is for the type, not a real case.
        if (!clause || !spec) continue;
        // `import type { … }` is erased at build time and is always safe.
        const target = resolveRelative(page, spec);
        if (!target || !isClientModule(target)) continue;

        for (const raw of clause.split(',')) {
          const name = raw.trim();
          if (!name || name.startsWith('type ')) continue;
          const local = (name.split(/\s+as\s+/).pop() ?? name).trim();
          // Components are the ONE thing a server page may import from a client
          // module — they are rendered, not called. Convention: PascalCase.
          if (!/^[A-Z][A-Za-z0-9]*$/.test(local) || /^[A-Z0-9_]+$/.test(local)) {
            violations.push(`${local} from '${spec}'`);
          }
        }
      }

      expect(
        violations,
        `${rel} imports non-component value(s) from a client module: ` +
          `${violations.join(', ')}. Move them to a server-safe module ` +
          `(see src/app/admin/page-sizes.ts) — the bundler hands the server a stub, not the value.`,
      ).toEqual([]);
    });
  }
});
