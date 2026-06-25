# RepWorth design systems

RepWorth ships **two coexisting visual systems under one brand**. Pick one per
surface; never mix them on the same screen.

|  | Island | Console (Warm Editorial) |
|---|---|---|
| Used on | Public / marketing: landing, features, pricing, how-it-works, demo, security, login, signup, legal, approval page | Authenticated owner app: dashboard, settings, account (plus the admin tool, more utilitarian) |
| Route group | `src/app/(public)/*` (also auth island, admin) | `src/app/(authenticated)/*`, wrapped in `.rw-console` |
| Feel | Warm, tactile. A white `rounded-3xl` "island" floating on a sage field with parallax cards | Warm cream editorial. Double-bezel cards, espresso ink, muted accents |
| Display font | Plus Jakarta Sans | Young Serif (single weight, display only) |
| Body font | DM Sans | DM Sans |
| Token source of truth | [`src/app/globals.css`](../../src/app/globals.css) `:root` | [`src/app/(authenticated)/_styles/tokens.css`](../../src/app/(authenticated)/_styles/tokens.css) `:root` |
| How to build one | [`brand-island.md`](./brand-island.md) (mirrors the `repworth-brand-design` skill) | [`dashboard-redesign/design-spec.md`](./dashboard-redesign/design-spec.md) |

## Tokens live in code, not in this doc

This README points at the owners. It deliberately does not list hex values, so it
can never drift from them.

- **Island palette** is owned by `src/app/globals.css` `:root` (`--rw-sage`,
  `--rw-teal`, `--rw-teal-strong`, `--rw-peach`, `--rw-pink`, `--rw-beige`,
  `--rw-cream`, `--rw-ink`, `--rw-ink-soft`, status, fonts). It loads on **every**
  route, so authenticated screens inherit it by fall-through.
- **Console palette** is owned by `src/app/(authenticated)/_styles/tokens.css`
  `:root` (the Warm Editorial set: `--rw-app-*`, `--rw-card`, `--rw-tray`,
  `--rw-sage-deep` / `-soft` / `-line`, `--rw-blush*`, `--rw-danger`, `--rw-violet`,
  `--rw-star`, plus shape, elevation, and motion). It loads only inside `.rw-console`.

### Single-source rule (CI-enforced)

The Console file must **not** re-declare any Island color token. Re-declaring them
reintroduced the `--rw-sage` collision, where one name resolved to `#D2E0D3` on
public pages but `#97B3AE` inside the dashboard, decided only by CSS load order.

Guards: [`design-token-single-source.test.ts`](../../src/__tests__/design-token-single-source.test.ts),
`console-admin-palette.test.ts`, `no-yellow-star-colors.test.ts`.

## Accessibility: the two teals

`--rw-teal` (`#97B3AE`) is **decoration only**; it fails WCAG AA for text. For links,
button fills, and any text, use `--rw-teal-strong` (`#557069`), which passes AA on
white and cream. Rationale: [`docs/adr/0004-accessible-teal-token-split.md`](../adr/0004-accessible-teal-token-split.md).

## Known follow-ups (not in this pass)

- **Tailwind v4 `@theme` migration.** Tokens are CSS custom properties; ~51 component
  files still hardcode `bg-[#hex]` literals. Exposing tokens via `@theme` (so
  components write `bg-sage`) is a separate, larger PR.
- **`--rw-blue-*` rename.** The Console primary accent is sage, but the token names are
  still `--rw-blue-*` (values are sage, not blue). A deferred repo-wide rename to
  `--rw-accent-*`.
