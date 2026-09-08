# ADR 0029 — Where every `/admin/` link points, and what the Legacy admin portal shrinks to

## Status

Accepted — 2026-09-07. Resolves decision ticket
[#1165](https://github.com/RepWorth/ai-review-responder/issues/1165) on wayfinder
map [#1159](https://github.com/RepWorth/ai-review-responder/issues/1159).

Sharpens the **Legacy admin portal** glossary term with the exact end-state file
set. Does not change ADR 0024 D5's page list.

Terms: `docs/context/core-accounts-channels-admin.md` → **Legacy admin portal** (D2, D5), **Admin app**.

## Context

Once the **Admin app** is live and `/admin/overview` is deleted here, every site
that sends a person to `/admin/overview` sends them to a 404.

The map's ticket listed six such sites. **There are eleven.** The five it missed
are the sharp ones, because three of them are on pages ADR 0024 D5 keeps forever:

| # | Site | Shape | On a survivor? |
|---|---|---|---|
| 1 | `src/proxy.ts:252` | `NextResponse.redirect` | — |
| 2 | `src/app/(authenticated)/layout.tsx:92` | `redirect()` | — |
| 3 | `src/app/onboarding/demo/page.tsx:63` | `redirect()` | — |
| 4 | `src/app/onboarding/business/guard.ts:66` | `{ kind:'redirect', path }` | — |
| 5 | `src/app/onboarding/start/page.tsx:61` | `redirect()` | — |
| 6 | `src/app/onboarding/payment-success/page.tsx:63` | `redirect()` | — |
| 7 | `src/lib/auth/require-owner-access.ts:166` | `redirect()` | — |
| 8 | `src/lib/shared/auth-flow.ts:89` | returned `destination` | — |
| 9 | `src/app/admin/login/page.tsx:9` | `defaultRoute` prop | **yes** |
| 10 | `src/components/admin/EndImpersonationButton.tsx:46` | `router.push()` | **yes** |
| 11 | `src/app/admin/error.tsx:57` | `<Link href>` | **yes** |

Sites 1–8 are the same event: an admin reached an owner surface, and the app
bounces them to the admin home. Sites 9–11 are on pages that outlive the
retirement and would otherwise push an admin at a deleted page.

The remaining `/admin/overview` mentions are nav data or comments
(`AdminSidebar.tsx:180,189`, `nav-config.ts:18`, `ui/AdminPage.tsx:36`, and four
prose comments). They are deleted with the pages they serve, not repointed.

**The impersonation preselect cannot work.** `ImpersonationStartClient` takes four
free-text fields — `accountId`, `impersonatedUserId`, `ticketId`, `reason` — and has
no business input. A business id names an account but not a user, so the admin
still chooses one. And `src/lib/auth/page-gate.ts:59` builds
`/admin/login?from=<from>` where `from` is the page's **static route shape**, by
the page-gate contract. A query string is not in `from`. So an admin who is not
already signed in loses any preselect parameter at the login door.

## Decisions

### D1 — one `ADMIN_APP_URL`, read through one accessor, never by a client component

`ADMIN_APP_URL` is a **server-only** env var — the Admin app's origin, one value per
environment. It is registered in both inventories (`docs/eservices-variables.md`
and `.claude/reference/env-vars.md`) per the `env-flags` rule, and it gets **no
`NEXT_PUBLIC_` companion**, which invariant #13 forbids and `ci:static-policy`
enforces.

One accessor in `src/lib/config/` owns the read. Eleven `process.env` reads would
be eleven places to get the trailing slash wrong, and `ci:process-env` exists to
stop exactly that.

**Two of the three survivor sites are client components, so the value reaches them
as a prop from their server parent**, never from the environment:

- `EndImpersonationButton` is rendered by `AdminShellFrame`, rendered by
  `src/app/admin/layout.tsx` — a server component. The layout reads the accessor
  and passes the value down.
- `LoginFormClient` already receives `defaultRoute` as a prop from
  `src/app/admin/login/page.tsx`, a server component. The prop's value changes; the
  plumbing does not.

Both of those navigate cross-origin, so **`router.push` is wrong for them**.
`next/navigation`'s router does client-side routing within this app; a cross-origin
destination needs a full document navigation. `EndImpersonationButton`'s
`router.push` + `router.refresh` pair becomes one `window.location.assign`, and the
`refresh` is dropped — there is nothing left here to refresh.

### D2 — every site switches in ONE change, at overview parity

The switch happens on the day the Admin app's overview page is live and
`/admin/overview` is deleted here. Not before.

Switching at first-page parity would create a window with two live overviews and
no single answer to where an admin belongs: some redirects landing on the Admin
app, some on a legacy page that still renders. The sites all name the same
destination, so they have one correct switching moment, and it is the moment that
destination stops existing.

Before that day `ADMIN_APP_URL` is unset and nothing reads it. The change is
sequenced by the retirement order ticket
([#1169](https://github.com/RepWorth/ai-review-responder/issues/1169)), which owns
when parity is declared.

### D3 — `src/app/admin/error.tsx` points at `/admin/impersonate`, not the Admin app

It is a Next error boundary and therefore a client component (`'use client'` at
line 1). It has no server parent to take a prop from, and it must not read the
environment.

It does not need to. After the retirement the legacy portal's only reachable
surface is impersonation, so "Back to overview" becomes a link to
`/admin/impersonate` — a same-origin path, on this app, that will still exist.

This is the one site of the eleven that does not take `ADMIN_APP_URL`.

### D4 — the impersonation link-out carries no preselection

The Admin app's business detail links to `<this app>/admin/impersonate` and shows
the account id beside the link for copy-paste. Nothing else.

The page is unchanged. The `/admin/login?from=/admin/impersonate` round trip
already works for a signed-out admin, and it keeps working because `from` stays the
static route shape.

**Accepting `?account=<uuid>` and prefilling is rejected**: the parameter is
silently dropped whenever the admin is not already signed in, because of the
page-gate `from` contract above. A prefill that works only when the admin happens
to hold a session is worse than none — it teaches a habit that fails at the moment
the admin is least able to diagnose it.

**Building the full business → account → user preselect is rejected** by the map's
own Out of scope: *any change to admin features or their behavior*. Parity is the
bar.

### D5 — the Legacy admin portal's end state, made exact

**Pages that survive** (5 of 21 under `src/app/admin/`, plus one outside):

- `src/app/admin/impersonate/page.tsx`
- `src/app/admin/impersonate/[sessionId]/view/page.tsx`
- `src/app/admin/login/page.tsx`
- `src/app/admin/forgot-password/page.tsx`
- `src/app/admin/reset-password/page.tsx`
- `src/app/mfa/challenge/**` (outside `/admin`)

**Chrome that survives**: `src/app/admin/layout.tsx`, `src/app/admin/providers.tsx`,
`src/app/admin/error.tsx`, `src/components/admin/AdminShellFrame.tsx`,
`src/components/admin/ImpersonationBanner.tsx`,
`src/components/admin/EndImpersonationButton.tsx`,
`src/lib/admin/shell-context.ts`, `src/lib/admin/impersonation/**`.

**Deleted with the last non-survivor page**: `src/components/admin/AdminSidebar.tsx`,
`src/components/admin/nav-config.ts`, `src/components/admin/nav-counts-query.ts`,
the three enrollment widgets, `src/components/admin/ui/**` (the Console kit, already
exported in #1167), `src/app/admin/page-sizes.ts`, and the sixteen retiring pages
with their path-pinning tests.

**`AdminShellFrame` keeps identity, the impersonation banner and
`EndImpersonationButton`, drops the sidebar, and gains one "Open Admin app" link**
built from `ADMIN_APP_URL`.

Keeping the sidebar to render one nav item is rejected: it keeps `AdminSidebar`,
`nav-config`, `nav-counts-query`, the nav-counts route and their tests alive to draw
a single link, and leaves a second visual system to maintain in a repo that no
longer owns the admin UI. Deleting the layout's chrome entirely is also rejected —
`EndImpersonationButton` and the impersonation banner live there, and ending a
support session is the one thing this portal still has to do well.

### D6 — the worker health alert keeps its bare path

`worker/background/pollers/health-alert/checks.ts:186` writes "… backlog at
`/admin/flagged`" into alert text. It is a page name for a human reading an alert,
not a link anyone clicks from there.

It stays as it is. Registering `ADMIN_APP_URL` on the Railway worker — a second
inventory row, a `worker/env.ts` entry, and an unset-value branch — to interpolate
one string in a message body is out of proportion to the benefit.

### D7 — the owner-portal impersonation readers are unchanged

`src/app/(authenticated)/settings/auto-approval/page.tsx:16` and
`src/app/api/settings/auto-approval/route.ts:117` read `IMPERSONATION_COOKIE_NAME`.
Impersonation does not move (ADR 0024 D5), the cookie is unchanged, and neither
site names `/admin/`. **Confirmed: no change.**

## Consequences

- One new env var, one accessor, ten call sites repointed and one relinked — a
  single `/feature` run, gated on #1169's parity declaration.
- Two client components change navigation mechanism, not just a string
  (`window.location.assign`, prop-passed value). That is the part a reviewer must
  actually check.
- The retirement PR that deletes `/admin/flagged` is the one that must not "fix" the
  worker alert text. D6 is the standing answer.
- The **Legacy admin portal** term now carries the exact survivor file set, so a
  future session does not re-derive it from the page list.
- `resolvePostLoginDestination` still rejects any `from` that is not a same-origin
  path. That is unchanged and correct: `from` names a page on THIS app, and the
  Admin app is reached through `defaultRoute`, not through `from`.

## Alternatives rejected

- **Switching sites as each page reaches parity** — two live overviews and no single
  admin home (D2).
- **Hardcoding the Admin app origin per environment** — it becomes a
  `NEXT_PUBLIC_` twin in all but name the moment a client component needs it, which
  invariant #13 forbids (D1).
- **`?account=` prefill on `/admin/impersonate`** — silently dropped through the
  login round trip (D4).
- **Full business → account → user preselect** — out of scope on the map (D4).
- **A one-item sidebar** — keeps four modules and their tests alive to draw one link
  (D5).
- **`ADMIN_APP_URL` on the worker** — a second env registration for one alert string
  (D6).
