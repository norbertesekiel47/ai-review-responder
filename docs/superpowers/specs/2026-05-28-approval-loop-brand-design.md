# Design — Brand + complete the approval loop

> **Date:** 2026-05-28
> **Source:** `docs/launch-ready-part2.md` → Prioritized fix list → **P0 #2** (folds in the same-file half of **P0 #3**).
> **Branch / worktree:** `fix/launch-p0-approval-loop` at `/tmp/repworth-approval-loop`.
> **Brand reference:** `~/.claude/skills/repworth-brand-design/SKILL.md` (island system, tokens, motion).

## Problem

The approval loop is *the* core product moment — a logged-out owner opens an
emailed link and approves (or edits / regenerates) a Google reply. Today both
files render an unbranded gray/blue prototype:

- `src/app/(public)/approve/[token]/page.tsx` — `bg-gray-50` shell + a bare gray
  error card; **no `robots: noindex`** despite rendering sensitive,
  token-keyed business review data.
- `src/components/approval/approval-client.tsx` — `bg-blue-*` response card,
  **amber** "Archived" badge + **amber** AI-disclosure banner, **yellow** stars,
  **blue** spinner; the four error meanings (invalid / consumed / revoked /
  expired) have **no recovery path**; the edit `<textarea>` has **no label**;
  and it imports the **dashboard-private `Icon`** component into a public page.

## Goals

1. Re-skin both files into the RepWorth island system (sage field, white
   `rounded-[3rem]` island, teal CTAs, calm parallax).
2. Make the loop *complete*: a real, action-aware success state and a recovery
   path on every error state.
3. Remove every banned color (amber / yellow) and the cross-boundary `Icon`
   import.
4. Add `robots: { index: false, follow: false }` to the page (P0 #3, same file).

## Non-goals (explicitly out of scope)

- The shared island bugs **P0 #7** (`overflow:hidden` on `.rw-island`) and **M9**
  (`min-height:680px`) live in `globals.css` / `auth-island.css`. This redesign
  reuses `PageShell` (which has *neither* bug), so those files are **not touched**
  here — they remain separate fixes.
- `help/contact` / `feedback/thanks` styling (P0 #6), MFA (P0 #4), onboarding
  funnel (P0 #1) — separate items.
- No change to any `/api/approve/**` route, the approval service, token hashing,
  device/CSRF binding, or the `AI_DRAFT_DISCLOSURE` constant.

## Decisions (locked this session)

| Decision | Choice |
|---|---|
| Outer frame | **Single-pane focused island**, reusing the existing `PageShell` (`sections={[]}` → no dot-nav). One authoritative island; no bespoke shell. |
| In-island top | **Minimal brand header** (teal dot + `REPWORTH` wordmark), **not** the marketing `SiteNav` — wrong context for a logged-out owner mid-task. |
| Error recovery | **Dashboard + support** on every error: primary "Go to your dashboard" → `/dashboard`, secondary "Contact support" → `/help/contact`. |
| Success | **Reassure + dashboard**: action-aware heading + the **verbatim API `message`** + "View your reviews →" → `/dashboard`. |
| Stars | **Teal** (`#97B3AE`) filled / `#97B3AE`/25 empty (point #2 says remove yellow). |
| Scope | **#2 + the noindex one-liner** (#3) in `page.tsx`. |

## Architecture

Composition (server renders the island + header once; the client swaps only its
own subtree below the header):

```
approve/[token]/page.tsx (server, force-dynamic)
└─ <PageShell sections={[]}>            ← reused island: sage field + parallax, no overflow-hidden
   ├─ <BrandHeader/>                    ← teal dot + REPWORTH (inlined; rendered once)
   └─ link OK ? <ApprovalClient/> : <ApprovalErrorState message={…}/>
```

```
approval-client.tsx (client) — renders below the header, inside the island:
  loading  → teal spinner
  active   → <h1> + location chip + neutral "Archived" badge
             review card (teal stars) · AI-disclosure sage note · labeled draft / textarea
             teal "Approve" pill + ghost "Edit" / "Regenerate"  ·  italic expiry note
  success  → <ApprovalSuccessState> : teal check + heading + verbatim message + dashboard CTA
  error&!data → <ApprovalErrorState message/>  (same component the server uses)
  error&data  → branded inline alert above the active view (owner can retry)
```

### One new file (justified)

`src/components/approval/ApprovalErrorState.tsx` — a **shared presentational**
component (no hooks, no `'use client'`) rendering the error island body: a
restrained semantic-red glyph, the situation message, and the dashboard + support
recovery links (`next/link`). It is the single owner of the error/recovery UX,
imported by **both** the server `page.tsx` and the client `approval-client.tsx`,
which otherwise would duplicate a non-trivial block across the server/client
boundary. (Success UI lives only in the client, so it stays inlined there — no
file for it.)

### File-by-file

**`src/app/(public)/approve/[token]/page.tsx`** (server)
- Add `export const metadata = { title: 'Review a draft response · RepWorth', robots: { index: false, follow: false } }`. (`force-dynamic` stays.)
- Keep the existing minimal DB pre-check and the four messages, but render
  branches as `<PageShell sections={[]}><BrandHeader/>…</PageShell>`:
  - link missing / consumed / revoked / expired → `<ApprovalErrorState message={…}/>`
  - otherwise → `<ApprovalClient token={rawToken} />`
- Keep the `<h1>Review a draft response</h1>` text (preserves the page unit test);
  restyle to the brand h1 scale inside the island. Delete the old gray `ErrorPage`.

**`src/components/approval/approval-client.tsx`** (client)
- Remove `import { Icon } from '@/components/dashboard/Icon'`; inline a map-pin SVG
  (inline-SVG only, per brand rules) for the location chip.
- Restyle to tokens: teal spinner; teal location chip; neutral `#D6CBBF`/40
  "Archived" badge (was amber); review card on `#F0EEEA`; **teal** stars (was
  yellow); AI-disclosure restyled to a sage note `bg-[#D2E0D3]/40` +
  `border-[#97B3AE]/30` `text-[#6a6a6a]` (was amber) — `AI_DRAFT_DISCLOSURE`
  text unchanged; teal "Approve"/"Save & Approve" pills + ghost outline buttons.
- **Edit textarea:** add a real `<label htmlFor="approval-edit">Edit your response</label>`
  + matching `id`; brand the focus ring teal.
- **Success state:** action-aware heading (`approve`/`edit` → "Response approved!",
  `regenerate` → "New draft on the way") + the verbatim `successMessage` from the
  API + "View your reviews →" `Link` to `/dashboard`. Wrap in
  `role="status" aria-live="polite"`. Track which action succeeded to pick the heading.
- **Error (no data):** render `<ApprovalErrorState message={error}/>`.
- **Error (with data):** branded inline alert (`role="alert"`) above the active view.

**`src/components/approval/ApprovalErrorState.tsx`** (new, shared/presentational)
- Props: `{ message: string }`. Renders the glyph + message + dashboard (teal pill)
  + "Contact support" (`/help/contact`) links. No client hooks.

## Brand / token mapping (kill-list)

| Today | Becomes |
|---|---|
| `border-blue-600` spinner | teal `#97B3AE` spinner |
| `text-yellow-500` stars | teal `#97B3AE` stars |
| amber "Archived" badge | neutral `#D6CBBF`/40 + `#6a6a6a` |
| amber AI-disclosure banner | sage note `#D2E0D3`/40 + `#97B3AE`/30 border |
| `bg-blue-50 border-blue-200` draft card | white + `#97B3AE`/30 border |
| `bg-blue-600` buttons | teal pill / ghost outline (brand button styles) |
| `bg-gray-50` page + gray error card | `PageShell` island + `ApprovalErrorState` |
| `<Icon name="location"/>` (dashboard-private) | inline map-pin SVG |

Semantic red (error glyph) and teal (success) are retained — they match the
auth-island precedent (`.rw-alert` red, success teal) and are not in the banned
decorative palette.

## Accessibility

- Edit textarea gets an associated visible `<label>`.
- Success → `role="status" aria-live="polite"`; errors → `role="alert"`.
- All CTAs are real `next/link` anchors / `<button>`s with text labels.
- Teal-on-white text/icon contrast verified against tokens; stars are decorative
  with an adjacent `sr-only` "N out of 5 stars".

## Testing (TDD; tests written first)

`approval-client.test.tsx` — **keep** the existing AI-disclosure + Approve assertions; **add**:
- success renders the action-aware heading + verbatim message + a `/dashboard` link;
- the no-data error path renders dashboard + support recovery links;
- the edit textarea is reachable via `getByLabelText('Edit your response')`;
- stars render an `sr-only` rating; no `@/components/dashboard/Icon` import remains.

`approve/[token]/page.test.tsx` — **keep** the h1 assertion; **add**:
- each of invalid / consumed / revoked / expired renders `ApprovalErrorState` with a recovery link;
- `metadata.robots` is `{ index: false, follow: false }`.

`ApprovalErrorState.test.tsx` (new) — renders the message + dashboard + support links.

## Verification before "done"

`pnpm lint && pnpm typecheck && pnpm test` green in the worktree. No DB/schema
change, so tenant-scope / RLS audits are N/A. Then `finishing-a-development-branch`
→ PR with the four CI checks green (land via PR; `main` is protected).
