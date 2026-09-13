# Health baseline — Pathfinder 2026-09-12

Measured at `6edacd0b0`, clean tree, in the sibling worktree
`../RepWorth-worktrees/arch-pathfinder-2026-09-12`. Window for deltas:
`40e79e6a8..6edacd0b0`.

Counting rule: git-tracked `.ts .tsx .js .jsx .css .sql`, excluding any path
containing `__tests__`, `.test.` or `.spec.`. `wc -l` counts physical lines,
so blanks and comments are included.

---

## 1. Size by root

| Root | Prod files | Prod lines | 08-26 files | 08-26 lines | Window delta (files touched / net lines) |
|---|---:|---:|---:|---:|---|
| `worker/` | 195 | 40,114 | 192 | 37,899 | 30 / **+2,215** |
| `src/lib/` | 423 | 79,182 | 389 | 69,455 | 90 / **+9,727** |
| `src/app/` | 330 | 48,498 | 357 | 52,248 | 222 / **−3,750** |
| `src/components/` | 245 | 33,345 | 227 | 30,636 | 170 / **+2,709** |
| **Total** | **1,193** | **201,139** | **1,165** | **190,238** | **526 / +10,901** |
| `supabase/migrations/` | 120 | — | 114 | — | 6 (**115 → 120**) |

**`src/app/` net-shrank by 3,750 lines and 27 files — the first root to shrink
across any Pathfinder window.** 66 production files were deleted in total
(103 added, 357 modified). The cause is the ten legacy-admin page retirements
(#1240–#1264) and #1233's landing-exploration removal.

**+10,901 net lines against +28 net files** means the growth is
concentration, not sprawl: `src/lib/` took 89% of it.

## 2. Top production files by line count

| # | Lines | Path | 08-26 | Δ |
|---:|---:|---|---:|---|
| 1 | **3,261** | `src/app/(authenticated)/_styles/console.css` | 2,262 | **+999 (+44%)** |
| 2 | 2,101 | `src/lib/solicitation/dispatch.ts` | 2,039 | +62 |
| 3 | 2,000 | `src/lib/solicitation/release.ts` | 1,989 | +11 |
| 4 | 1,976 | `src/lib/solicitation/ask-generation.ts` | 1,739 | +237 |
| 5 | 1,797 | `src/app/(public)/_styles/island.css` | 1,793 | +4 |
| 6 | **1,426** | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx` | 1,059 | **+367** |
| 7 | 1,414 | `src/lib/solicitation/approval.ts` | 1,334 | +80 |
| 8 | **1,261** | `worker/jobs/account-offboarding/purge-stages.ts` | 1,011 | **+250** |
| 9 | **1,240** | `src/components/approval/approval-client.tsx` | 1,092 | +148 |
| 10 | 1,180 | `src/lib/auto-approval/settings.ts` | 1,180 | 0 |
| 11 | **1,167** | `worker/jobs/response-generation/persist.ts` | — | new to the list |
| 12 | **1,162** | `src/lib/refusals/write.ts` | — | **new subsystem** |
| 13 | 1,145 | `src/app/(authenticated)/_styles/settings.css` | 1,106 | +39 |
| 14 | 1,057 | `worker/jobs/publisher/auto-policy-publish.ts` | 1,057 | 0 |
| 15 | 1,030 | `src/lib/solicitation/batch-view.ts` | 1,030 | 0 |
| 16 | **1,027** | `src/lib/shared/job-outbox-helpers.ts` | 976 | **+51 — crossed 1,000** |
| 17 | **1,006** | `worker/index.ts` | 977 | **+29 — crossed 1,000** |

**Sixteen production files exceed 800 lines** under `src/lib/` + `worker/`
(the two crossings the #1270 arch-log entry flagged are #16 and #17 — both
confirmed). Full list in `07-handoff-reverification.md` §G.

**The two fastest-growing files are both CSS or CSS-adjacent** — `console.css`
+999 and `AutoApprovalClient.tsx` +367. This is the second consecutive pass
where the largest single file in the repo is a stylesheet.

## 3. Subsystem sizes — `src/lib/`

| Dir | Files | Lines | 08-26 | Δ lines |
|---|---:|---:|---:|---:|
| **`solicitation`** | **32** | **16,787** | 16,035 | **+752 (+4.7%)** |
| `notifications` | 48 | 5,763 | 5,752 | +11 |
| `shared` | 50 | 5,478 | 4,817 | +661 |
| `account-offboarding` | 23 | 5,442 | 4,820 | +622 |
| `admin` | 27 | 4,790 | 4,344 | +446 |
| **`agents`** | **13** | **3,882** | **2 / 1,189** | **+2,693** |
| `reviews` | 19 | 3,397 | 3,356 | +41 |
| `dashboard` | 15 | 2,950 | — | — |
| `auto-approval` | 10 | 2,841 | 2,807 | +34 |
| `payments` | 11 | 2,482 | 2,482 | 0 |
| **`refusals`** | **3** | **2,466** | **did not exist** | **+2,466** |
| `locations` | 12 | 2,120 | — | — |
| `responses` | 19 | 2,107 | — | — |
| `approval` | 15 | 1,977 | — | — |
| `auth` | 12 | 1,565 | — | — |

**Two results worth naming:**

1. **`src/lib/solicitation` grew 4.7% — the slowest growth in four passes**
   (08-22 → 08-26 was +11.2%). It is still **2.9× the next-largest
   subsystem** and holds **21% of all `src/lib/` production lines**, but it
   is no longer the growth story.
2. **`src/lib/agents/` more than tripled** (2 → 13 files, 1,189 → 3,882
   lines) and `src/lib/refusals/` appeared from nothing at 2,466. The
   platform's growth moved from the solicitation lane to the agentic lane in
   one window.

## 4. Subsystem sizes — `worker/`

| Dir | Files | Lines |
|---|---:|---:|
| `background/pollers/` | 33 | 7,313 |
| `jobs/publisher/` | 18 | 5,116 |
| `jobs/account-offboarding/` | 11 | 3,121 |
| `jobs/response-generation/` | 6 | 2,348 |
| `jobs/zernio/` | 5 | 1,779 |
| `jobs/notification/` | 7 | 959 |
| `background/schedulers/` | 5 | 749 |
| `jobs/billing/` | 5 | 722 |
| `jobs/solicitation-batch/` | 5 | 632 |
| `jobs/pending-post-notice/` | 4 | 604 |
| `jobs/escalation-notice/` | 4 | 532 |
| `jobs/solicitation-veto-notice/` | 4 | 521 |
| `jobs/agent-turn/` | 3 | **488 — new** |

### The notice family — SIX members, unchanged in count

`worker/jobs/{auto-post-notice, autonomy-suspended-notice, escalation-notice,
notification, pending-post-notice, solicitation-veto-notice}`. **No seventh
member appeared**, so the 08-26 pass's stated escalation trigger ("a seventh
member changes 'extract' to 'extract now'") did not fire on member count.

**It fired on a different axis instead.** The *claim contract* grew from two
functions to five (`07-handoff-reverification.md` §E). The trigger was written
about the wrong dimension; the duplication grew 150% in the one the pass did
not watch.

## 5. Test surface

| | |
|---|---:|
| Test files (`.ts`/`.tsx` under `__tests__/` or `*.test.*`) | **1,190** |
| Test lines | **317,797** |
| Integration suites (`*.integration.test.ts`) | **126** |
| Test : production line ratio | **1.58 : 1** |

`src/lib/agents/operator/` is the most heavily tested new subsystem in the
window at **3,456 test lines against 2,683 production** (1.3:1), largest
suite `turn-worker.integration.test.ts` at 1,158 lines.

> **Not measured: the test suite was not executed.** This pass ran
> `pnpm typecheck`, `pnpm lint` and all 22 `ci:*` audits, but not `pnpm test`
> — the live-DB lane needs `TEST_DATABASE_POOL_URL` and a container at
> migrations head 120, and a silently-skipping live-DB suite would produce a
> false pass. **Test health at HEAD is unmeasured.** Same gap the 08-26 pass
> declared.

## 6. `fallow` — a NEW baseline for this metric family

The 08-24 and 08-26 baselines recorded no fallow numbers; 08-22 and 08-18
recorded health percentages only. These are a first full baseline.

```
$ npx fallow health
● Health score: 77 B
  Deductions: hotspots -10.0 · unit size -10.0 · coupling -2.5
              · maintainability -0.3 · dead files -0.1
■ Metrics: 220,434 LOC · dead files 0.3% · dead exports 0.0%
  · avg cyclomatic 3.1 · p90 cyclomatic 7 · maintainability 92.1 (good)
  · 0 churn hotspots (since 6 months) · duplication 1.3%
```

| Metric | Value |
|---|---:|
| Health score | **77 (B)** |
| LOC analysed (incl. tests and scripts) | 220,434 |
| **Duplication** | **1.3%** (`fallow dupes`: **2,185 lines, 1.2%, across 58 files, 64 clone groups**) |
| Maintainability | **92.1 (good)** |
| Dead files / dead exports | 0.3% / **0.0%** |
| Avg / p90 cyclomatic | 3.1 / 7 |
| **Large functions (> 60 LOC)** | **489** |
| **High-complexity functions** | **161** |
| Function size distribution | 66% low (1–15) · 16% medium · 11% high (31–60) · **7% very high (> 60)** |
| Parameter counts | 91% low (0–2) · 8% medium · 1% high · 0% very high |

**Worst large functions:** `worker/background/pollers/ArchivalPoller.ts:66`
`runArchival` **456 lines** · `scripts/ci/admin-contract-types.ts:148`
`describeResponses` 439 · `src/lib/solicitation/ask-generation.ts:1067`
`generateAsksForBatch` 327 · `src/components/dashboard/reviews/edit-reply/useEditReplyDraft.ts:228`
307 · `src/components/sections/how-it-works/HowItWorksContent.tsx:215` 293.

**Worst complexity (CRAP):** `scripts/redis.ts:77` `main` **2450.0** ·
`scripts/ci/admin-contract-types.ts:193` `isProvenRead` 948.7 ·
`scripts/ci/admin-contract-schemas.ts:77` `evaluate` 708.4 ·
`admin-contract-types.ts:284` `resolveBinding` 590.0.

> **Read the complexity table carefully before acting on it.** The top six
> CRAP scores are all in `scripts/` — the **new `ci:admin-contract`
> generator** and a dev script. CRAP is estimated from export references, so
> a single-entry-point CI script scores badly by construction. **This is not
> production hot-path complexity**, and the generator is the machinery that
> keeps the Admin API contract honest (F3). Recorded, not actioned.

`pnpm ci:fallow` itself reported **"0 changed files vs origin/main"** —
it is a diff gate, vacuous on a clean tree, and it is **not** the source of
any number above. `ci:fallow:coverage` was **not** run: it consumes the
`test` job's coverage artifact, which this pass did not produce.

## 7. Migrations — 115 → 120, lockstep VERIFIED by introspecting BOTH databases

| # | File | Objects |
|---|---|---|
| 115 | `qr_scan_analytics_event.sql` | `analytics_events_event_name_check` widened to admit `qr_scan_redirected` |
| 116 | `refusal_events.sql` (235 lines) | table + **5 CHECKs** + 2 indexes + 1 partial unique + deny-all RLS |
| 117 | `admin_audit_log.sql` | table + 2 indexes + RLS |
| 118 | `poller_heartbeats.sql` | 2-column table + RLS + REVOKE |
| 119 | `job_outbox_rls.sql` | `ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY` |
| 120 | `owner_operator.sql` (161 lines) | 4 tables + 3 indexes + RLS on all four |

**Not re-derived from any ledger or commit message.** Both live Supabase
projects were introspected read-only on 2026-09-12 via the Supabase MCP
(`execute_sql`, `SELECT` only) — prod `udeyaqnvpojbwgoaxwdg`, staging
`kubdiqdhqbhwmqfditeg`:

1. **Object presence + RLS state** for all 8 tables touched by 116–120, plus
   `md5(indexdef)` for all 8 named indexes and `md5(pg_get_constraintdef(oid))`
   for `analytics_events_event_name_check`.
2. **Column fingerprints** — `md5(string_agg(column_name || data_type ||
   is_nullable || column_default ORDER BY column_name))` per table.

**Every one of the 18 object rows and all 8 column fingerprints are
byte-identical across the two projects.** RLS is `on` for all eight tables on
both. Column counts: `admin_audit_log` 10 · `agent_conversations` 5 ·
`agent_turns` 16 · `agent_proposals` 23 · `agent_unsupported_requests` 6 ·
`job_outbox` 14 · `poller_heartbeats` 2 · `refusal_events` 12.

**Migrations 115–120 are in full lockstep. No drift.**

> CLAUDE.md's standing statement about 077/078 was **not** re-derived by this
> pass — it explicitly forbids that, and correctly. Only 115–120 were
> introspected.

## 8. Gates — 22 audits, all green

`pnpm typecheck` **rc=0** (4 s) · `pnpm lint` **rc=0** (22 s).

All 22 `lint`-job audits: `ci:tenant-scope` · `ci:rls-audit` ·
`ci:analytics-events` · `ci:static-policy` · `ci:env-registry` ·
`ci:response-status` · `ci:admin-aal2` · **`ci:admin-contract`** ·
`ci:config-coverage` · `ci:process-env` · `ci:reviews-status` ·
`ci:outbox-topics` · `ci:outbox-status` · `ci:db-imports` ·
`ci:feature-surface` · `ci:agent-config` · `ci:live-db-suites` ·
`ci:outbox-seam` · `ci:dropped-columns` · `ci:directory-map` ·
`ci:merge-ledger` · `ci:pool-fanout` — **rc=0, every one.**

**The audit count went 21 → 22.** Exactly one added since the 08-26 baseline:
**`ci:admin-contract`** (`becdb113d`, #1190/#1232). `package.json` holds 24
`ci:*` entries — the 22 plus `ci:fallow` (`UNGATED_BY_DESIGN`) and
`ci:fallow:coverage` (`CI_ONLY_BY_DESIGN`, run in ci.yml's `fallow` job).
`lefthook.yml:21-80` mirrors all 22. `src/__tests__/ci-audit-wiring.test.ts`
(238 lines) is still the enforcer and its two exception tables match
CLAUDE.md's description exactly.

`ci:rls-audit` runs **twice** — in `lint` (self-skips without a DB) and live
in the `test` job (`ci.yml:279`). By design; counted once.

`ci:merge-ledger` output on a clean tree:
`passed (0 changed file(s); no production or governance trigger)`.

## 9. Context-layer caps — three files at or within 0.2% of cap

Measured with `wc -w` against `docs/agents/context-layout.md`'s table.
`npx vitest run src/__tests__/claude-md-shape.test.ts src/__tests__/reference-shape.test.ts`
→ **2 files, 264 tests, all PASS.**

| File | Words | Cap | Headroom |
|---|---:|---:|---|
| **`docs/directory/lib-platform.md`** | **3,000** | 3,000 | **ZERO** |
| **`docs/directory/lib-reviews-responses.md`** | **3,000** | 3,000 | **ZERO** |
| **`docs/context/refusal-ledger.md`** | 2,995 | 3,000 | 5 words |
| `.claude/reference/lab-notes/live-db-test-suites.md` | 2,952 | 3,000 | 48 |
| `.claude/reference/lab-notes/ci-tooling.md` | 2,830 | 3,000 | 170 |
| `docs/directory.md` | 2,717 | 3,000 | 283 |
| `CONTEXT-MAP.md` | 1,158 | 1,500 | 342 |
| `docs/agents/context-layout.md` | 1,078 | 1,200 | 122 (**90%**) |
| `docs/progresstracking.md` | 10,963 | 12,000 | 1,037 (**91%**) |
| `docs/currents.md` | 9,587 | 12,000 | 2,413 |
| `.claude/CLAUDE.md` | 4,575 | 6,000 | 1,425 (76%) |
| `.claude/rules/worker-layout.md` (largest rule) | 743 | 800 | 57 |

**Nothing is over cap. But two `docs/directory/*.md` pages sit at exactly
3,000 with a `<=` assertion (`src/__tests__/reference-shape.test.ts:83-110`),
and that is a LIVE finding** — see `05-process-findings.md` §5. The layer
counts: 18 `.claude/rules/*.md`, 18 `docs/context/*.md`, 24
`docs/directory/*.md`, 20 lab-notes pages.

## 10. New production files in the window (103 added)

The architecturally significant additions:

`src/lib/agents/operator/` × 11 (`authorize` · `catalog` · `context` ·
`flags` · `model-call` · `prompt` · `proposals` · `reads` · `render` ·
`schema` · `turns`) · `worker/jobs/agent-turn/` × 3 · `src/app/api/operator/`
× 3 · `src/lib/refusals/` × 3 · `src/lib/responses/voice-settings.ts` ·
`src/lib/auth/{admin-mfa-gate,verified-identity,admin-transport}.ts` ·
`src/lib/config/{admin-origins,admin-app-url}.ts` ·
`src/lib/shared/{poller-liveness,password-rules,business-categories}.ts` ·
`src/lib/account-offboarding/{stripe-retry-policy,stripe-customer-redaction}.ts` ·
`src/components/ui/{InfoTip,useDisclosurePopover}.tsx|ts` ·
`src/lib/solicitation/contacts-csv-template.ts` ·
`src/components/sections/landing/jobs/` · `docs/admin-api/` (generated,
committed).

## 11. Known gaps

1. **`pnpm test` was not executed.** §5.
2. **`ci:fallow:coverage` was not run** — it needs the `test` job's coverage
   artifact.
3. **Live flag values on Railway and Vercel were not read.** The 08-26 pass
   read them; this one did not. Every reachability verdict that depends on a
   deployed value says so and cites the **code default** instead.
4. **Only migrations 115–120 were introspected.** The 077/078 lockstep
   statement in CLAUDE.md was deliberately not re-derived.
5. **No mutation testing.** Every "no guard catches this" claim rests on
   reading the guard's own scope literal.
6. **`src/app/**` is outside `ci:directory-map`'s scope**, so a stale
   `docs/directory/app-*.md` row after 66 file deletions fails no audit. This
   pass spot-checked the `reveal.tsx` row (now clean) but did not audit every
   `src/app/` row.
