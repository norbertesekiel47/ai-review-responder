import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Design-token single-source guard (refactor/design-tokens-single-source, 2026-06).
//
// The Island (marketing / public) color palette is owned EXCLUSIVELY by
// src/app/globals.css, which loads on every route. The Console (authenticated
// app) token file must NOT re-declare those names. Doing so reintroduced the
// --rw-sage / --rw-sage-soft collision, where one token name meant #D2E0D3 on
// public pages but #97B3AE inside the dashboard — decided only by CSS load order.
// Background + "which palette when": docs/design/README.md
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');
const GLOBALS = 'src/app/globals.css';
const TOKENS = 'src/app/(authenticated)/_styles/tokens.css';

// A DECLARATION (`  --rw-x: …`) at line start — never a usage (`var(--rw-x)`) or
// a mention inside a comment.
const declares = (css: string, token: string): boolean =>
  new RegExp(`^\\s*${token}\\s*:`, 'm').test(css);

// The Island color palette. Single authoritative owner = globals.css.
const ISLAND_COLOR_TOKENS = [
  '--rw-sage',
  '--rw-teal',
  '--rw-teal-strong',
  '--rw-peach',
  '--rw-pink',
  '--rw-beige',
  '--rw-cream',
  '--rw-ink',
  '--rw-ink-soft',
];

describe('design tokens: Island palette is single-sourced in globals.css', () => {
  const globals = read(GLOBALS);
  const tokens = read(TOKENS);

  it.each(ISLAND_COLOR_TOKENS)('globals.css owns %s', (token) => {
    expect(declares(globals, token), `${token} must be declared in ${GLOBALS}`).toBe(true);
  });

  it.each(ISLAND_COLOR_TOKENS)('the Console token file does NOT re-declare %s', (token) => {
    expect(
      declares(tokens, token),
      `${token} is re-declared in ${TOKENS}. Island colors belong to ${GLOBALS} only — ` +
        `re-declaring them reintroduces the cross-file collision (see docs/design/README.md).`,
    ).toBe(false);
  });

  it('the --rw-sage collision is closed: base in globals, -deep/-soft/-line in Console', () => {
    // Bare sage base is owned by globals.css and absent from the Console file.
    expect(declares(globals, '--rw-sage')).toBe(true);
    expect(declares(tokens, '--rw-sage')).toBe(false);
    // The Warm Editorial sage family is Console-owned and not in globals.css.
    expect(declares(tokens, '--rw-sage-deep')).toBe(true);
    expect(declares(tokens, '--rw-sage-soft')).toBe(true);
    expect(declares(globals, '--rw-sage-deep')).toBe(false);
  });

  it('app-only tokens the Console surface needs stay in the Console file', () => {
    for (const token of ['--rw-star', '--rw-white', '--rw-text']) {
      expect(declares(tokens, token), `${token} must stay in ${TOKENS}`).toBe(true);
    }
  });
});
