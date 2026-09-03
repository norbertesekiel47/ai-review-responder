# Handoff — feat/1092-nav-sidebar-children

Resume with `/feature-resume feat/1092-nav-sidebar-children`. Everything needed
is on disk; never ask for the prior transcript.

## Where this run is

Step 4 (execute tracers). Phase `plan_approved`. Ladder: `.feature/progress.json`.

## Read these, by path

| What | Where |
|---|---|
| Locked scope contract | `docs/superpowers/plans/feat-1092-nav-sidebar-children-intake.json` (+ arming copy `.feature/intake.json`) |
| Plan and tracers | `docs/superpowers/plans/feat-1092-nav-sidebar-children.md` |
| Ticket | `gh issue view 1092 --comments` — **the correction comment supersedes the body** |
| Governing decision | `gh issue view 1089` |
| Parent map | `gh issue view 1084` |
| Deviations | `docs/superpowers/plans/feat-1092-nav-sidebar-children-deviations.md` (created on first deviation) |

## Glossary excerpt — read before editing

`CONTEXT.md` § "Review QR — locked 2026-08-26". Two LOCKED terms bind here:

- **Review QR** — the per-location printable QR code. Its entry names
  `/settings/review-qr`, which this change moves, so **the entry itself must be
  updated**. Do not coin a synonym; `_Avoid_` lists QR token, scan code,
  review-link QR.
- **QR redirect** — `GET /q/<businessId>`. **Does not move.** Printed codes
  point at it, and `src/lib/locations/review-qr.ts` is outside the edit surface.

## The one thing a resumed session must not get wrong

The ticket body says *delete* `ReviewsTabs`, `RequestsTabs` and `AnalyticsTabs`.
**#1089 reversed that.** They are RETAINED and scoped to mobile. Deleting them
strands three routes on every phone, because `console.css:2337` hides `.sidebar`
below 768px and `MobileTabBar` has no children mechanism.

## Tracer state

T1–T5 per the plan. Check `.feature/progress.json` for live status rather than
trusting this list.
