# Admin split — orchestrator handoff (2026-09-08)

This file hands the BUILD of the admin split to an orchestrator session. It
references the sources of truth by path and number; it restates none of them.
Read the referenced files, not this summary, before any edit.

## 1. Destination and state

- **Destination**: the **Admin app** (repo `RepWorth/admin-app`, Vercel project
  `prj_ofJWgjS87xsApuw6f0s3p0OyzxKc`, `admin.repworth.net` /
  `admin.staging.repworth.net`) calls the **Admin API** in this repo with a
  Supabase bearer; the **Legacy admin portal** retires page by page;
  impersonation never moves. Glossary:
  `docs/context/core-accounts-channels-admin.md` (terms **Admin app**,
  **Admin API**, **Legacy admin portal**, **Admin transport**, **Verified
  admin**, **Admin origin allowlist**, **Admin API contract**, **Admin app
  fetch seam**, **Page parity**).
- **Decisions are LOCKED** in `docs/adr/0024-admin-app-split.md` through
  `docs/adr/0031-admin-page-retirement-order-and-parity.md`. ADR 0024 carries
  amendment boxes where a later ADR changed it; the amended text wins. Do not
  re-litigate a decision. If one looks wrong, stop and report to the owner.
- **Map**: GitHub issue #1159 (Notes, Decisions so far, Out of scope). Every
  decision ticket #1160–#1169 is closed; their resolution comments hold the
  detail behind each ADR.
- **Already done and verified 2026-09-08**: migration 119 (`job_outbox`
  deny-all RLS) on staging and production; provisioning (#1166) including the
  developer's write access to `admin-app` and no access here; the Console kit
  and curated docs exported to `admin-app` `main` (#1167); the staging handover
  file delivered to the developer by the owner.

## 2. Owner decisions taken after the ADRs (2026-09-08)

1. **Admin reset instead of enrolment.** Ticket #1182 no longer enrols the
   existing admins. The owner chose to remove every existing admin's access
   now and re-create admins when the transfer is complete. **Implement as
   revoke, never as row deletion**: `users` rows are referenced by
   `businesses.onboarded_by` (`supabase/migrations/001_initial_schema.sql:107`),
   `impersonation_sessions.actor_user_id` NOT NULL (`048_…sql:8`),
   `admin_audit_log.actor_user_id` NOT NULL (`117_…sql:51`), and
   `014`/`034` actor columns. Revoke = the Supabase Auth identity can no
   longer sign in (or `users.role` leaves `admin`), with an
   `account_audit_log` entry via `writeAccountAuditLog`. Then flip
   `MFA_ENFORCEMENT_ENABLED` on (the `flag-flip` skill). Re-mint admins with
   #1178's script; each new admin enrols in MFA at first sign-in under
   enforcement.
2. **Two admins must exist before Gate B (#1197)**: the owner's own account
   and the developer's staging account (`yoknyei@repworth.net`, staging
   only). Re-mint them right after #1178 lands, before #1197 runs.
3. **Cookie mode survives for `/api/admin/impersonation/**`** (ADR 0024 D4
   amendment, ADR 0031 D6, ticket #1203).
4. **The legacy pages are PORTED into `admin-app`, not rebuilt by the
   developer.** Port tickets #1224 (T1 pages), #1225 (overview), #1226 (the
   three businesses pages), #1227 (the remaining ten). Each port: copy
   `src/app/admin/<page>/**` + its client components into `admin-app`,
   replace every direct `lib/admin`/`sql` read and every raw `/api/admin`
   fetch with the **Admin app fetch seam**, type against the **Admin API
   contract**, keep the exported kit, reach **Page parity** (ADR 0031 D2)
   with 390/1440 screenshots and owner sign-off. Each retirement ticket is
   now blocked by its port ticket. The developer maintains the ported app
   from there.
5. **Status 2026-09-08**: L1, L1-owner and L2 are MERGED — #1178, #1183,
   #1186, #1187, #1196 (admin-app PR #2), #1182 (both environments, flag on),
   #1184. Next is L3.

## 3. The build, as ticket layers

Each ticket is ONE `/feature <ticket-ref>` run. Every ticket touching the
gates, `src/proxy.ts`, CORS, migrations, flags or a page deletion is
**RISK = high**: it rides `staging` first, then a PR to `main`, then PAUSES
for the owner's merge approval (CLAUDE.md § Environments; `/feature` step 8).

| Layer | Tickets | Blocked by | Notes |
|---|---|---|---|
| L1 | #1178 mint-admin script; #1183 transport seam; #1186 CORS; #1196 starter Gate A; #1187 preflight WAF log rule | nothing | #1183 and #1186 both edit `src/proxy.ts` → run SERIALLY (#1183 first). #1196 lives in `admin-app`, fully parallel. |
| L1-owner | #1182 admin reset + `MFA_ENFORCEMENT_ENABLED` flip | #1178 (mint script must exist before revoking everyone) | Owner-approved flag flip; use the `flag-flip` skill. Re-mint owner + developer accounts right after. |
| L2 | #1184 fold the nine GETs, widen `ci:admin-aal2` | #1182, #1183 | |
| L3 | #1185 bearer through proxy + CSRF split; #1189 read gaps; #1190 contract + `ci:admin-contract` | #1184 | #1185/#1190/#1189 share `src/proxy.ts` or `scripts/ci/admin-aal2-audit.ts` → SERIAL in that order. |
| L4 | #1191 contract push to `admin-app`; #1197 Gate B handshake proof | #1190; #1184+#1185+#1186 | Gate B needs the two re-minted admins (§2.2). |
| Port | #1224 T1 pages (now); #1225 overview; #1226 businesses ×3; #1227 remaining ten | #1224: nothing; #1225: #1197, #1190; #1226: #1189, #1190, #1197; #1227: #1190, #1197 | Work happens in a worktree of `RepWorth/admin-app` (its own CI; no `/feature` scripts there). Owner signs off **Page parity** per page on the port ticket. |
| L5 | #1200 tranche 1 (security, runbook); #1202 tranche 3 (three business pages) | #1190 + parity sign-off; #1189 too for #1202 | Share `nav-config.ts`, `console-admin-palette.test.ts`, `directory-map-audit.ts` → SERIAL. |
| L6 | ONE PR: #1192 `ADMIN_APP_URL` + eleven redirects and #1201 tranche 2 (overview) | overview parity + #1202 + #1190 | Owner correction 2026-09-11: repoint and retire together; staging ride + one red-team pass. #1193 no longer blocks this cut. |
| L7 | #1242 Costs → #1243 Notifications → #1244 Jobs → #1245 Autonomy → #1246 Flagged → #1247 Offboardings → #1248 Solicitation → #1249 Suppressions → #1250 CSV import → #1251 Demos | #1192 + #1201, then each ticket waits for its predecessor | Owner approved this order and all ten #1227 pages' Page parity on 2026-09-11; one retirement ticket per page. |
| L7-shell | #1193 shrink the shell | #1251 + #1192 | Retain the permanent impersonation pages' minimal UI dependencies and the nav-counts API used by the Admin app (ADR 0029 D5, owner correction 2026-09-11). |
| L8 | #1203 remove cookie mode (except impersonation) + sweep | last tranche + #1193 | |
| Go-live | #1179 production admin account for the developer | owner call | |

Open tickets outside the map's feature label that the build depends on:
#1182, #1187, #1191 (all `wayfinder:task`).

## 4. Orchestration rules

- **One sibling worktree per ticket**: `pnpm worktree:new feat/<ticket>` from
  the main checkout; never nested worktrees for anything that must pass CI.
  Every edit path points at that worktree root.
- **Parallel only when a ticket pair has no blocking edge AND disjoint file
  sets.** The known overlaps (from the 2026-09-08 audit) are in §3 Notes; the
  complete list is `src/proxy.ts` (#1183, #1185, #1186, #1190, #1192, #1203),
  `src/lib/shared/csrf.ts` (#1185, #1186), `src/lib/config/` (#1186, #1192),
  `scripts/ci/admin-aal2-audit.ts` (#1184, #1189, #1190),
  `scripts/ci/__tests__/db-imports-audit.test.ts` and
  `src/components/admin/nav-config.ts` (every retirement ticket),
  `src/lib/admin/shell-context.ts` (#1178, #1193). Land the earlier one
  before starting the later one.
- LEAN (owner, 2026-09-11): each ticket = sibling worktree, implement, tests, `pnpm lint && pnpm typecheck && pnpm test` plus the relevant ci:* audits, one review pass (/code-review), PR, owner merge. No grilling round, no Codex plan review, no red team, no staging ride — EXCEPT #1192 (proxy redirects) and #1203 (cookie removal), which keep the staging ride and one red-team pass.
- **Close each feature ticket with a resolution comment** naming the PR, the
  staging verification evidence, and the merge SHA. The tickets are the
  progress ledger; do not add another one.
- **Never a flag flip, a migration, or a production write without the owner's
  explicit go** in that session. `flag-flip` and `new-migration` skills first.
- **Realign `staging` after every merge** (`deployment-guide.md` § Re-sync
  staging). Migrations: staging first, prod at promotion, both introspected.
- **Stop and report to the owner** on: a red gate after 3 rounds, a second
  surface amendment, any contradiction with an ADR, any touch of
  impersonation beyond the carve-out, or a Dependabot/security finding in the
  touched area.

## 5. Owner gates (the orchestrator waits; it never assumes)

1. Merge approval on every high-risk PR.
2. The #1182 flag flip and the re-mint of the two accounts.
3. **Page parity** sign-off per page, with 390px/1440px screenshots.
4. Tranche 4 priority, when tranche 3 closes.
5. #1179 at go-live.

## 6. Validation record

- ADRs 0025–0031 audited against 0024 and the map on 2026-09-08 (PR #1206):
  one design gap (impersonation carve-out) fixed; four amendment boxes added;
  three cross-references corrected; ticket edges #1189→#1184 and
  #1200/#1201/#1202→#1190 added.
- Live checks the same day: `job_outbox` RLS identical on both projects;
  developer permission `none` on this repo, `write` on `admin-app`.
