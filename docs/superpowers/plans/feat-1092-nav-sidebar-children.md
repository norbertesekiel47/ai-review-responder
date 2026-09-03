# feat/1092 — nav: sidebar children on desktop, pill bars on mobile, Review QR under Requests

Ticket [#1092](https://github.com/RepWorth/ai-review-responder/issues/1092) ·
map [#1084](https://github.com/RepWorth/ai-review-responder/issues/1084) ·
decision [#1089](https://github.com/RepWorth/ai-review-responder/issues/1089).

**SIZE = standard · RISK = normal · SURFACE = ui.** Intake:
`docs/superpowers/plans/feat-1092-nav-sidebar-children-intake.json`.

## What #1089 changed about this ticket

The ticket body says *delete* the three pill bars. **It is wrong and the
correction comment supersedes it.** `console.css:2337` hides `.sidebar` below
768px and `MobileTabBar` has no children mechanism, so deleting the pill bars
strands `/dashboard/reviews/history`, `/dashboard/requests/contacts` and
`/dashboard/analytics/restraint` on every phone.

The owner chose: **retain the pill bars, scope them to mobile.** Desktop gets
sidebar children and no pills.

## Ubiquitous language

**Review QR** and **QR redirect** are LOCKED terms (`CONTEXT.md` § Review QR).
The **Review QR** entry names `/settings/review-qr` as where the owner gets the
code, so **moving the route makes the locked definition false** — updating it is
part of this change, not follow-up. The **QR redirect** `GET /q/<businessId>`
does **not** move: printed codes point at it.

## Design decisions

1. **A marker class, not bare `.tabs`.** `CardViewTabs` is a view switch that
   must stay on desktop; it uses `card-view-tabs`, so hiding `.tabs` would work
   today. It is still wrong to rely on that — a future `.tabs` user would be
   silently hidden. The three route bars gain `tabs--routed`, and only that is
   scoped to the breakpoint.
2. **One breakpoint number.** The rule joins the existing
   `@media (max-width: 768px)` block in `console.css`. No second number.
3. **The thirteen call sites do not change.** Each component decides whether it
   renders, so this stays in three components plus one CSS block instead of
   thirteen edits.
4. **The old settings URL redirects** rather than 404s — an owner may have
   bookmarked it.
5. **`deriveNavSection` keeps one owner.** The moved QR route already folds into
   `requests` via the `/dashboard/requests` prefix; a test pins it so a later
   reorder cannot break it silently.

## Tracers

Each is a thin vertical slice. T1 is the eval task and lands first.

| # | Slice | Blocked by |
|---|---|---|
| T1 | Eval tests for every `tests_to_add` title, committed failing | — |
| T2 | Sidebar children for Reviews, Requests, Analytics + `deriveNavSection` QR pin | T1 |
| T3 | `tabs--routed` marker + the breakpoint rule; the three bars render mobile-only | T1 |
| T4 | **Review QR** route move, old-path redirect, Settings row removal, QR pill | T1 |
| T5 | Docs: `CONTEXT.md` **Review QR**, `docs/directory.md`, `docs/currents.md`, merge ledger | T2, T3, T4 |

T2, T3 and T4 touch disjoint files and may run in either order after T1.

## What must not break

- Every sub-route reachable on a phone today stays reachable on a phone.
- `GET /q/[businessId]` and `src/lib/locations/review-qr.ts` are untouched.
- `solicitationEnabled` still hides the Requests parent **and** its children.
- `SETTINGS_DEFAULT_HREF` stays `/settings/voice`.
- `past-reply-card-states.test.tsx:422` guards that **All Reviews** is always
  reachable (#678). The guarantee survives; the assertion moves to the sidebar.
