# Pathfinder 2026-08-15 — feature inventory (Phase 0, boundaries approved)

Scope: the entropy window — 6 merges since the 2026-08-10 pass (#793, #805,
#821, #827, #831, #833). **Windowed, not repo-wide**, by owner decision: five of
the six merges landed in the two portals plus the onboarding funnel, so the pass
charts those surfaces and treats everything else as an external dependency.

Boundaries proposed by the discovery agent from source + `CONTEXT.md` locked
vocabulary + the import graph; approved by the orchestrator with the six
adjustments recorded below.

| # | Feature (glossary term where one exists) | Entry points | Size (non-test) |
|---|---|---|---|
| F1 | **Business summary** + **At-risk list** — admin business console | `business-summary.ts:160` `getBusinessSummaries`; `overview-service.ts:117` `getAdminOverview` (filter→sort→cap `:170-179`); `admin/businesses/[id]/page.tsx:13` | ~41 files, ~6,080 LOC |
| F2 | Owner dashboard portal — shell, account-state gating, KPI read stack | `(authenticated)/layout.tsx:51` shell gate; `api/dashboard/route.ts:481`; `dashboard/service.ts:115`; `kpi/fragments.ts:44` **Review-time anchor** | ~79 files, ~8,470 LOC |
| F3 | Owner settings & policy configuration | `settings/layout.tsx:5`; `api/settings/route.ts:203`/`:293`; `api/settings/auto-approval/route.ts:21`/`:134` (sole path to `auto_approval_policies`, inv #14) | ~52 files, ~7,140 LOC |
| F4 | **Channel actor** seam — mobile channel enrollment | `_shared/channels/start.ts:39` `runChannelStart`; `action.ts:46`/`:75`; `resolve-actor.ts:65`/`:114`; 12 route shims | ~52 files, ~4,695 LOC |
| F5 | **Funnel entry** + **Admin invite** — onboarding funnel | `funnel-entry.ts:81` `resolveFunnelEntry` (pure); `admin-onboarding-service.ts:218`; `api/onboarding/start/route.ts:189` | ~85 files, ~11,020 LOC |
| F6 | **Checkout attempt** + **Beta comp coupon** — subscription activation | `plan-activation.ts:350` `applyTierSnapshot`; `create-checkout-session.ts:437`/`:146` | ~20 files, ~4,050 LOC |
| S1 | **Auth gate seam** (cross-cutting — *not* a feature) | `page-gate.ts` (16 admin pages); `admin-mfa-gate.ts` (20+ admin routes **and** F4's `resolve-actor.ts:23`); `route-helpers.ts` (every portal API route) | seam chart only |

## Orchestrator adjustments

1. **`src/lib/auth/**` is a seam (S1), not a feature.** Discovery is right that the
   import graph refuses to give it one home: its three member groups fan out to
   different owners (`get-request-scope`/`resolve-owner-scope` → F2;
   `provision-auth-user`/`flags` → F5; `admin-mfa-gate` → F1 **and** F4). It gets
   a seam chart and **no unification proposal may assign it a single feature
   owner.** It is load-bearing for this pass specifically because
   `admin-mfa-gate.ts` is the thing #831 converted from structure to
   configuration.

2. **F5 excludes `src/components/auth/auth-island/**` (~3,490 LOC).** Login/signup
   presentation chrome — `Robot.tsx`, `Showcase.tsx`, `ParallaxField.tsx`,
   `fireConfetti.ts` — untouched by all six merges and carrying no control flow.
   Charting it would inflate F5 by a third and teach nothing. F5's effective size
   is ~7,530 LOC.

3. **`/admin/businesses/new` + `POST /api/admin/businesses` → F5, not F1.**
   `CONTEXT.md:126` settles it: an **Admin invite** is an Account minted by staff
   *whose owner then walks the same self-serve funnel*. The form is three fields
   precisely because the funnel owns the rest. Cost of this call, which both
   flowchart agents must know: **`src/app/api/admin/businesses/route.ts` is split
   across two features** — its `GET` (`:25`) is F1, its `POST` (`:55`) is F5.

4. **`settings/channels` → charted by F4, referenced by F3.** The page is an F3
   shell slot rendering an F4 payload: its server component reads F4's flag, env
   and override modules directly (`page.tsx:20-26`). F4 charts it as the read side
   of enrollment; F3 lists it as an external dependency and does not redraw it.
   This resolves discovery's double-count.

5. **`src/components/admin/ui/**` is NOT F1-owned.** `DataTable`, `StatTile`,
   `StatusBadge` and `AdminPage` serve nine admin pages outside this window
   (jobs, costs, notifications, flagged, offboardings, suppressions, demos,
   impersonate, autonomy). Only **`HealthBadge.tsx`** — added by #833 as the
   single owner of churn-level presentation — is in F1's surface. The shell
   (`AdminShellFrame`/`AdminSidebar`) stays out, as discovery proposed.

6. **No seventh feature.** The Reviews list / Needs Action / Requests surfaces sit
   inside the `(authenticated)/` glob but were touched by none of the six merges,
   **and were already charted by the 2026-08-10 pass** as its F3 (On-demand
   generation) and F4 (Reviews list). Re-charting them would duplicate a current
   artifact, not extend coverage.

## Inherited constraints — binding on Phases 2 and 3

Carried from `docs/reviews/PATHFINDER-2026-08-10/03-unified-proposal.md` §P4
(DO-NOT-UNIFY register). One entry lands directly inside this window's F4 and
**must not be re-proposed as a duplication finding**:

> **Account-scope vs cookie-location-scope tenancy** (documented D-C).

That is the `resolveAdminActor` (body `businessId`, behind `requireAdminWithAal2`)
vs `resolveOwnerActor` (session `locationId`, behind `requireRoleOr401`)
asymmetry. `.claude/CLAUDE.md` states it plainly: *"that asymmetry is a
tenant-isolation boundary."* The two resolvers must stay two functions. A
finding may examine how the *binding* between route and resolver is enforced —
that is exactly #831's open question — but may not propose merging them.

Two further do-not-unify pairs surfaced by this window's discovery, both verified
deliberate in-code and promoted here so Phase 2 does not re-litigate them:

- **`src/lib/auto-approval/types.ts`** — `autoApprovalThresholdLabel` (`:31`) is
  deliberately shared by F1's admin diagnostics panel and F3's owner settings
  screen, while the two `AutoApprovalReadinessBlockReason` maps (`:18-23`) are
  deliberately **not** shared: different registers, both exhaustive over one
  union. #827 made this call explicitly. Any chart placing auto-approval in
  exactly one feature is wrong.
- **F3 `settings/billing` vs F6 checkout** — same Stripe subscription, but two
  different read models by invariant #9a: billing reads the **stored** `accounts`
  quota/price (point-in-time, grandfathered), F6 reads the immutable
  **Checkout attempt** snapshot. Neither reads live `TIER_CONFIG`. Not duplication.

## Health baseline (repo-wide, for the pass record)

| Metric | 2026-07-27 | 2026-08-10 | **2026-08-15** |
|---|---|---|---|
| Health score | 77 B | 77 B | **77 B** |
| Maintainability | 92.2 | 92.2 | **92.2** |
| Duplication | 1.7% | 1.3% | **1.1%** |
| Churn hotspots | 0 | 0 | **0** |
| Dead files | 0.3% | — | **0.4%** |
| High-complexity fns | 153 | — | **132** |

164,007 LOC analyzed. CRAP remains **not quotable** repo-wide per #581 — fallow
matched Istanbul coverage for 6,020 of 29,612 functions; the rest are estimated
from export references.

Flat-to-improving across six more merges, three of them structural refactors.
The code is not where the entropy is accumulating — the same conclusion the
2026-08-10 pass reached, now on an independent window.
