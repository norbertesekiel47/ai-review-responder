# Refusal ledger — spec verification against wayfinder map #994

**Audit date:** 2026-09-02
**Repo:** `/Users/norbertesekiel/Developer/startups/RepWorth`
**Branch:** `main` · **HEAD:** `f797d250` (`ux: remediate the 160 findings of the 2026-09-02 frontend UX audit (#1075)`)
**Authority:** wayfinder map [#994](https://github.com/RepWorth/ai-review-responder/issues/994) `## Decisions so far`, and each decision ticket's resolution COMMENT (#995, #996, #998, #1000, #1001, #1002, #1003, #1005, #1006). Ticket titles were not used as the spec.
**Scope:** verify-and-report only. No file in the audited surface was modified.

**Working-tree state at audit time (declared, per skill rule):** the tree is dirty, but only in docs unrelated to this audit —
`D docs/marketing/BRAND-KIT.md`, `D docs/marketing/CLAUDE-PROJECT-SETUP.md`, `M docs/brand-asset-library/brand-guidelines/brand-story.md`,
untracked `docs/help/marketing/`, `docs/roadmap/2026-08-29-launch-explainer-script.md`,
`docs/superpowers/plans/2026-08-31-refusal-swarm-handoff.md`.
No `src/`, `worker/`, `supabase/` or `scripts/` file is modified, so no finding below is affected by uncommitted work.

---

## 1. #1001 — what one `refusal_events` row holds

Authority: #1001's resolution comment, which states the shape in prose **and** in a `CREATE TABLE` block. Where the two disagree the block is the binding artifact (see the arithmetic note below).

| Sub-claim | Status | Evidence |
|---|---|---|
| Column list matches #1001's `CREATE TABLE` block exactly | **VERIFIED** | `supabase/migrations/116_refusal_events.sql:71-172` reproduces #1001's block column-for-column: `id`, `account_id`, `business_id`, `refusal_source`, `refusal_code`, `all_refusal_codes`, `refusal_category`, `vocabulary_version`, `subject_type`, `subject_id`, `occurred_at`, `created_at` |
| "Sixteen columns" | **STALE (decision doc)** | The enumerated block in #1001 holds **twelve** columns, not sixteen; #1006 repeats the same count. Both live databases report `col_count = 12`. The codebase already carries the correction: `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:583` — *"migration 116 creates the **twelve** locked columns with their exact types, nullability and defaults, and no others"*. **Not an implementation defect** — an arithmetic error in the decision prose. |
| Five named CHECK constraints | **VERIFIED** | `116_refusal_events.sql:106` (C1 `refusal_events_source_subject_pairing`), `:121` (C2 `refusal_events_subject_completeness`), `:131` (C3 `refusal_events_business_pairing`), `:139` (C4 `refusal_events_code_pairing`), `:162` (C5 `refusal_events_all_codes_pairing`). Each is exercised by its own rejection test: `migration-116-refusal-events.integration.test.ts:837, 862, 880, 897, 914`, plus C1's fall-through case at `:772` |
| Three indexes | **VERIFIED** | `116_refusal_events.sql:205` `idx_refusal_events_archival (occurred_at, id)`; `:215` `idx_refusal_events_account_window (account_id, occurred_at DESC)`; `:225` `refusal_events_subject_uniq`. Pinned by `migration-116-refusal-events.integration.test.ts:688` |
| Deny-all RLS | **VERIFIED** | `116_refusal_events.sql:229` `ENABLE ROW LEVEL SECURITY` with the load-bearing comment at `:230-233` ("Deliberately NO policies"). Live check: both projects report `rls_enabled = true`, `policy_count = 0`. Pinned by `migration-116-refusal-events.integration.test.ts:560` |
| Idempotency is a **partial** unique index on `(refusal_source, subject_id) WHERE subject_id IS NOT NULL` | **VERIFIED** | `116_refusal_events.sql:225-227`. Partiality proven behaviourally at `migration-116-refusal-events.integration.test.ts:1148` — two `autonomy_suspended` rows for one account both persist |
| Every writer uses `ON CONFLICT … DO NOTHING`, predicate re-spelled byte-for-byte | **VERIFIED** | `src/lib/refusals/write.ts:420-421` (single-row arm) and `:581-582` (set arm), both `ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL DO NOTHING`. There are exactly **two** production `INSERT INTO refusal_events` statements in the repo, both in `write.ts` (`:395`, `:543`) — no lane spells its own. The two clauses are compared **as text** by `src/lib/refusals/__tests__/write.test.ts:414-431`, and inference against the real index is proven live at `migration-116-refusal-events.integration.test.ts:1105`. The reason is stated where it matters: `write.ts:430-434` — *"a bare unique index raises on a duplicate and aborts the transaction it sits in — and that transaction IS the decision"* |
| `all_refusal_codes` is nullable `TEXT[]`, never `NOT NULL DEFAULT '{}'` | **VERIFIED** | `116_refusal_events.sql:81` `all_refusal_codes TEXT[],` — nullable, no default. Live: `all_refusal_codes:ARRAY:YES:-` in both projects. NULL/empty distinction is preserved end-to-end: `write.ts:413` and `:530` keep an explicit `null` arm rather than collapsing to `[]`, and C5 (`:162-171`) rejects an empty array outright |
| No `origin` column | **VERIFIED** | Absent from `116_refusal_events.sql` and from both live databases (12 columns, enumerated above). #1001's follow-up comment made the decline permanent once #1002 closed |

**One documented strengthening of #1001, not a deviation.** C5 as shipped adds two clauses the locked block did not carry — `array_position(all_refusal_codes, NULL) IS NULL` and an outer `IS TRUE` wrapper. `116_refusal_events.sql:146-157` labels this *"A CORRECTION TO THE SHAPE #1001 LOCKED"* and gives the reproduced counter-example (`refusal_code = 'winner'` against `ARRAY['different', NULL]` returns NULL, and a CHECK passes on NULL). This makes the constraint strictly stronger in the direction #1001 intended; it is pinned structurally at `migration-116-refusal-events.integration.test.ts:815`.

**Verdict: PASS** (with one stale count in the decision prose, corrected in code).

---

## 2. #1006 — no `suspension_event_id`; `occurredAt` required, never a round-tripped `Date`

| Sub-claim | Status | Evidence |
|---|---|---|
| No `suspension_event_id` column; the column set stands | **VERIFIED** | Not present in `116_refusal_events.sql:71-96` nor in either live database's 12 columns. `suspension_event_id` survives only where #1006 said it should — in the audit payload: `src/lib/auto-approval/suspension.ts:305` (`suspension_event_id: input.suspensionEventId` inside `auditPayload`) |
| `occurredAt: Date \| 'transaction_time'` is **required, never optional** | **VERIFIED** | `src/lib/refusals/write.ts:97` `export type RefusalOccurredAt = Date \| 'transaction_time';` and `:128` `occurredAt: RefusalOccurredAt;` on `RefusalEventBase` — no `?`, no default. The reason is recorded at `:119-127`: *"An OPTIONAL field lets a lane drift into the transaction stamp silently"* |
| The `autonomy_suspended` site uses the sentinel and shares the audit row's transaction | **VERIFIED** | `src/lib/auto-approval/suspension.ts:309-314` (`writeAccountAuditLog`) and `:331-348` (`writeRefusalEvent`) are consecutive statements on the same `tx`; `:347` `occurredAt: 'transaction_time'` |
| No site reads `transaction_timestamp()` and hands it back as a JS `Date` | **VERIFIED** | Repo-wide, `transaction_timestamp` appears in production code **only inside comments** (`write.ts:334, 342, 448, 600`; `suspension.ts:342`; `persist.ts:869`; `auto-policy-downgrade.ts:190`; `dispatch.ts:1362`; `approval.ts:622`; `ask-generation.ts:708`). The prohibition is stated at `write.ts:342-345`: *"A LANE MAY NEVER read `transaction_timestamp()` and hand it back as a JS `Date`: postgres.js truncates microseconds on decode (#520)"*. The sentinel is resolved server-side in both arms — `write.ts:350` (`tx\`NOW()\``) and `:567` (`COALESCE(event.occurred_at, NOW())`) |
| Every call site's `occurredAt` is either the sentinel or a genuinely app-supplied instant | **VERIFIED** | Sentinel lanes: `suspension.ts:347`, `persist.ts:762` (`policy_gate_held`), `persist.ts:886` (`held_draft`), `auto-policy-downgrade.ts:224`, `approval.ts:651`. Date lanes carry their own decision stamp: `batch-builder.ts:694` (`decidedAtInstant`, built at `:597` from the app-supplied `decidedAt`, not a DB read), `ask-generation.ts:712`, `dispatch.ts:1484` |
| The live-DB equality test #1006 required | **VERIFIED** | `src/lib/auto-approval/__tests__/suspension.integration.test.ts` — *"the refusal_events row suspendAccountAutonomy writes carries occurred_at equal to the account_audit_log row's created_at from the same transaction"*, asserting `pair!.refusal_occurred_at === pair!.audit_created_at` |

**Verdict: PASS.**

---

## 3. #995 — the category is frozen at write; reads never re-derive

| Sub-claim | Status | Evidence |
|---|---|---|
| The row stores the **verbatim** source code | **VERIFIED** | `116_refusal_events.sql:80` `refusal_code TEXT,` with column comment `:185-186` — *"The verbatim code inside the lane, never normalised"*. Written verbatim at every site, e.g. `suspension.ts:338` `refusalCode: input.trigger` under the comment *"The trigger VERBATIM, never normalised"* |
| The row stores the **resolved category** | **VERIFIED** | `116_refusal_events.sql:83-86` `refusal_category TEXT NOT NULL CHECK (…)` over the eight-member closed set; written from the per-lane maps in `src/lib/refusals/vocabulary.ts` (`:271, :291, :314, :331, :382, :411, :464`) and stamped by `write.ts:414` |
| The row stores a `vocabulary_version` | **VERIFIED** | `116_refusal_events.sql:87` `vocabulary_version TEXT NOT NULL`; `write.ts:415` and `:532` bind the frozen literal `REFUSAL_VOCABULARY_VERSION`, defined at `src/lib/refusals/vocabulary.ts:199` as `'refusal_vocab_2026-08-30.1'`. `write.ts:438-439` states it is *"the frozen literal and never a parameter"*; pinned by `vocabulary.test.ts:254` — *"REFUSAL_VOCABULARY_VERSION is a frozen literal, not a value any code derives at runtime"* |
| Reads render the **stored** category and never re-derive | **VERIFIED** | `src/lib/refusals/read.ts:355-356` and `:387-388` select `r.refusal_category` directly. `read.ts` contains **no** re-derivation: no `UNION ALL`, and none of the six parked source tables (`flagged_responses`, `approval_audit_log`, `solicitation_asks`, `solicitation_outreach`, `solicitation_batches`, `auto_approval_policies`) appears in any clause. Its only non-`refusal_events` reads are `businesses`/`accounts` (coverage start, tenant/archive guards), `responses` (link resolution) and `account_audit_log` (the archived-period line). The presentation layer groups by the **stored** value — `RestraintReport.tsx` `groupByCategory` filters on `entry.category`, using `REFUSAL_CATEGORIES` for group **order** only, which #995 classifies as presentation |
| A vocabulary reorder stays presentation-only | **VERIFIED** | Guarded structurally: `vocabulary.ts:493-504` explains that `AUTO_APPROVAL_BLOCK_PRECEDENCE` is an explicit member constant precisely so a `REFUSAL_CATEGORIES` reorder cannot change what future rows record |

**Verdict: PASS.**

---

## 4. #998 + #1003 — the reply lane

| Sub-claim | Status | Evidence |
|---|---|---|
| All 22 `AutoApprovalBlockReason` members accounted for | **VERIFIED** | `src/lib/refusals/vocabulary.ts:464-487` — a total map, `as const satisfies Record<AutoApprovalBlockReason, RefusalCategory \| null>`. Counted from source: **7 `null`** (`policy_not_enabled:465`, `bad_origin_lane:467`, `unsupported_version:468`, `suppressed_notification:469`, `moderation_held:476`, `archived_location:478`, `autopilot_tier_required:486`), **4 `owner_review_required`** (`rating_below_threshold:466`, `triage_high_severity:481`, `rating_below_positive_quadrant:483`, `daily_cap_exhausted:484`), **11 other mapped** = 22 |
| The eighth category `owner_review_required` exists in storage | **VERIFIED** | `116_refusal_events.sql:86` — the eighth member of the `refusal_category` CHECK |
| Exactly one row per decision, never one per code | **VERIFIED** | `resolvePolicyGateRefusal` (`vocabulary.ts:623-674`) returns a single `PolicyGateRefusal` or `null`; `recordPolicyGateRefusal` (`worker/jobs/response-generation/persist.ts:730-767`) issues one `writeRefusalEvent` call. The co-occurring set rides `allRefusalCodes` (`vocabulary.ts:672`), not extra rows |
| **`null` is a veto, not a rank** | **VERIFIED** | `vocabulary.ts:643-648` — one full pass over **every** member before any ranking: `if (POLICY_GATE_HELD_REFUSAL_CATEGORIES[code] === null) return null;`. The reason is stated at `:640-642`: *"the veto is about presence, never position, so a short-circuit on the first ranked member would let a later `null` through"*. Behaviour pinned at `vocabulary.test.ts:555` (*"returns null when any veto member is present, whatever its position"*) and by the concrete case at `:627` (a downgraded Autopilot account on a two-star review resolves to no Refusal) |
| Precedence comes from an explicit member constant, **never** `REFUSAL_CATEGORIES` order | **VERIFIED** | `vocabulary.ts:555-577` `AUTO_APPROVAL_BLOCK_PRECEDENCE` — a 15-member hand-written tuple, tiered exactly as #1003 locked (`unsafe_content` → `watchdog_unavailable` → `autonomy_paused` → `missing_information` → `below_our_bar` → `owner_review_required`). The resolver ranks from it alone (`:650`). Rationale at `:493-504` |
| The write is guarded on `!held` and **NOT** on `activeRun` | **VERIFIED** | `worker/jobs/response-generation/persist.ts:211-217` places `recordPolicyGateRefusal` **outside** the `if (activeRun && !held)` block at `:203`, with the explicit comment: *"it inherits that guard's `!held` arm and NOT its `activeRun` arm … inheriting `!activeRun` would silently drop rows from the lane with the highest design capacity"*. The `!held` half lives at `:743` `if (held) return;` |
| #1003's **exhaustiveness** test exists | **VERIFIED** | `src/lib/refusals/__tests__/vocabulary.test.ts:513` — *"every AutoApprovalBlockReason member appears exactly once across the veto set and the precedence list"*, asserting disjointness, union completeness, no duplicates, and the locked counts 7 / 15 (`:537-539`) |
| #1003's **forbidden** consistency test is absent | **VERIFIED** | No test compares `AUTO_APPROVAL_BLOCK_PRECEDENCE` against `REFUSAL_CATEGORIES`. The one tier test (`vocabulary.test.ts:542`) asserts against a locally restated `LOCKED_TIER_ORDER` (`:503-510`), and the comment at `:493-502` says so in terms: *"`REFUSAL_CATEGORIES` must NOT be used as the expectation — #1003 rejected that agreement test outright"* |

**Verdict: PASS.**

---

## 5. #996 — retention

| Sub-claim | Status | Evidence |
|---|---|---|
| `REFUSAL_LEDGER_RETENTION_DAYS = 180`, a **code constant**, not an env var | **VERIFIED** | `worker/background/pollers/ArchivalPoller.ts:46` `export const REFUSAL_LEDGER_RETENTION_DAYS = 180;` — a bare literal; the file reads no `process.env` for it. Rationale in place at `:43-45`. Negatively confirmed in both registries: `docs/eservices-variables.md` carries only `REFUSAL_LEDGER_ENABLED` (line 213) and no retention row; `.claude/reference/env-vars.md:563` states *"Not an env var and deliberately unregistered: `REFUSAL_LEDGER_RETENTION_DAYS = 180` is a code constant"* |
| A new `ArchivalPoller` arm sweeps it, on `occurred_at` alone | **VERIFIED** | `ArchivalPoller.ts:380-393` — `SELECT id FROM refusal_events` (`:382`) `WHERE occurred_at < NOW() - make_interval(days => ${REFUSAL_LEDGER_RETENTION_DAYS})` (`:383`), `ORDER BY occurred_at, id` (`:384`) matching `idx_refusal_events_archival`, `FOR UPDATE SKIP LOCKED` (`:385`), `LIMIT 5000` (`:386`), `DELETE FROM refusal_events WHERE id IN (SELECT id FROM candidates)` (`:389`). `created_at` appears nowhere in the arm. Reporting wired at `:405, :418, :433, :450` |
| `delete_data` purge is hard-delete | **VERIFIED** | `src/lib/account-offboarding/table-disposition.ts:325-330` — `disposition: 'hard_delete'`, `scopeEvidence: 'direct_account_id'`, `purgeVerification: 'must_be_absent'`. The statement: `worker/jobs/account-offboarding/purge-stages.ts:444-447` `DELETE FROM refusal_events WHERE account_id = …`. Verification twin: `src/lib/account-offboarding/purge-verification.ts:630-633` |
| **No foreign key may delete a Refusal on another table's clock** | **VERIFIED** | `116_refusal_events.sql:74-75` are the file's only two `REFERENCES`, both to `retain_deidentified` parents and **neither carrying `ON DELETE`/`ON UPDATE`**. Live introspection in both projects returns exactly two FK constraints, both bare: `refusal_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id)` and `refusal_events_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id)` — no referential action on either. `subject_id` is a bare `uuid` with no FK (`:92`, comment `:195-196`). No migration above 116 exists, so nothing later adds one |
| Sweep registrations | **VERIFIED** | `scripts/ci/tenant-tables.ts:106` (`TENANT_TABLES` membership) and `:178` (`refusal_events: ['account_id', 'business_id']`); `scripts/ci/tenant-scope-allowlist.ts:1007-1013` (cross-tenant retention-sweep exemption, byte-pinned to the arm) |

**Verdict: PASS.**

---

## 6. #1002 — no backfill, ever

| Sub-claim | Status | Evidence |
|---|---|---|
| No backfill script anywhere | **VERIFIED** | Exhaustive search: the only production `INSERT INTO refusal_events` statements in the repo are `src/lib/refusals/write.ts:395` and `:543`, both live per-decision writers on the caller's deciding transaction. The set arm reads `jsonb_to_recordset` over an in-memory array built in the current transaction (`write.ts:568`), never a historical table. Migration 116 contains **no** `INSERT` at all. The four files with "backfill" in their names (`scripts/zernio-backfill-external-replies.ts`, `scripts/posthog-backfill-activations.ts`, `worker/jobs/zernio/ZernioBackfillWorker.ts`, migrations 028/042/047/100/103) mention `refusal` nowhere |
| No `NOW()` default on `occurred_at` | **VERIFIED** | `116_refusal_events.sql:94` `occurred_at TIMESTAMPTZ NOT NULL,` — no default; `:95` `created_at` is the only defaulted timestamp. Live: both projects report `occurred_at:timestamp with time zone:NO:-` and `created_at:…:NO:now()`. No migration 117+ exists; the only `ALTER TABLE refusal_events` in the repo is `:229` (`ENABLE ROW LEVEL SECURITY`) |
| **Coverage start** = `accounts.created_at` (account) / `businesses.created_at` (location) | **VERIFIED** | `src/lib/refusals/read.ts:301-314` — location arm `SELECT b.created_at FROM businesses b` (`:303-304`), account arm `SELECT a.created_at FROM accounts a` (`:309-310`). It also clamps the window (`:315-317`). Rendered at `src/components/dashboard/restraint/RestraintReport.tsx:124-129` (`coverageLine`), wired at `:331` in the notes block, which renders in the empty **and** the populated state |
| The two rejected alternatives are absent | **VERIFIED** | `refusal_ledger_since` — zero hits repo-wide (no column, no reference). `REFUSAL_LEDGER_COVERAGE_START` — zero hits repo-wide |
| `read.ts` is a ledger reader, not the parked six-arm projection | **VERIFIED** | No `UNION ALL` in the file; the word `UNION` appears only in the prose at `read.ts:15-20` explaining why the parked arms died. Every refusal row comes `FROM refusal_events` (`:363, :395, :426, :470, :484`) |

**Per-lane honesty of the Coverage start — noted, and it is a locked owner decision, not a gap.** `CONTEXT.md:163` and `:166` record that `policy_gate_held` is structurally silent while `AUTO_APPROVAL_ENABLED` is off, so an account-wide `accounts.created_at` overstates that one lane's coverage. Owner decision 2026-09-01 was **"disclose, do not date"**, and that is what shipped: `RestraintReport.tsx:168-171` (`policyGateLine`) renders a separate line naming the lane as not-yet-recording, shown only while the flag is off. No activation marker and no backfill were added — consistent with #1002.

**Verdict: PASS.**

---

## 7. #1005 — the tab has three surfaces

| Sub-claim | Status | Evidence |
|---|---|---|
| (a) The report | **VERIFIED** | `src/components/dashboard/restraint/RestraintReport.tsx:320` (`export function RestraintReport`), orchestrated by `RestraintContent.tsx:40`, routed at `src/app/(authenticated)/dashboard/analytics/restraint/page.tsx:13`, served by `src/app/api/dashboard/refusals/route.ts:60` |
| (b) Account-view archived-location footnote, non-zero only, **no link and no remedy** | **VERIFIED** | `RestraintReport.tsx:194-200` — non-zero guard at `:195` (`if (!summary \|\| summary.refusalCount === 0) return null;`), copy *"{n} more from {1 archived location} are not shown."*. Account scope only, enforced server-side: `src/lib/refusals/read.ts:421` `const archivedLocations = scope.kind === 'account' ? (…) : null;`. Rendered as a plain string inside a `<p>` (`:381-388`) — no `<a>`, no `<Link>`, no reactivate CTA. Rationale at `:186-193`. Pinned by `src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:364-377` (asserts `querySelector('a')` is null and the text matches no `/reactivat\|restore\|unarchive\|click/i`) and `:379-388` (zero-count omission) |
| (c) Per-location archived-period line | **VERIFIED** | `RestraintReport.tsx:207-216`, wired at `:335`; location scope gated server-side at `read.ts:440` |
| (c) reads `account_audit_log` for `location_archived` / `location_reactivated` | **VERIFIED** | `read.ts:442-449` — `FROM account_audit_log l … AND l.event_type IN ('location_archived', 'location_reactivated')` (`:444`, `:447`), bounded by `ARCHIVAL_EVENT_LIMIT = 200` (`:153`), paired by `pairArchivedPeriods` (`:235-271`). Explicitly **not** re-derived from `businesses.archived_at`, which appears in `read.ts` only as a row-exclusion filter (`:372, :405, :430, :479, :494`). Stated at `read.ts:222-226`: *"the tab's ONLY read from a table the ledger does not own. It is CONTEXT … never a re-derived Refusal"* |

**Verdict: PASS.**

---

## 8. #1000 — no all-time claim

| Sub-claim | Status | Evidence |
|---|---|---|
| The exhaustive claim is gone | **VERIFIED** | The parked sentence *"We did not hold anything back… **Everything we were asked to do, we did.**"* no longer exists in rendered copy — the clause survives only inside the retirement comment at `RestraintReport.tsx:177`. The shipped empty state is `RestraintReport.tsx:182-184`: **"We did not hold anything back between {windowStart} and {windowEnd}."** — bounded by two rendered dates, rendered at `:357-360` |
| No Restraint surface claims all time | **VERIFIED** | #1000's locked wording is that the sentence *"loses its absolute form"* and that *"no Restraint surface makes a claim about all time"* — the window-bounded form satisfies both. The rationale is recorded at `RestraintReport.tsx:173-181`. The live region (`:344-348`) says *"in this window"*; the populated summary (`:365-372`) is likewise between two dates. `RestraintReport.test.tsx:308-323` pins the exact string and asserts the absence of `/all time\|at any point\|since you joined\|we have never\|nothing was ever\|always/i` |
| #999's rider — the empty copy names the **Coverage start** | **VERIFIED** | The notes block, which includes `coverageLine` (`:331`), renders in both the empty and the populated branch — see the JSX at `:356-390`, where the empty `<p>` and the `.rst-notes` wrapper are siblings, not alternatives |

> **Auditor's note on a near-miss.** The literal fragment "we did not hold anything back" *does* survive, and read alone it looks like the retired sentence. It is not: #1000 retired the **absolute** claim, and the shipped line is bounded by the window's two dates. Audited against #1000's resolution rather than the fragment, this passes.

**Verdict: PASS.**

---

## 9. Migration 116 lockstep — staging ↔ production

CLAUDE.md flags this as the one check that cannot be done by reading files, and forbids re-deriving lockstep from prose. Both Supabase projects were introspected directly via the Supabase MCP on 2026-09-02.

| Project | Ref | `refusal_events` | Columns | Constraints | Indexes | RLS | Policies | Rows |
|---|---|---|---|---|---|---|---|---|
| RepWorth-staging | `kubdiqdhqbhwmqfditeg` | present | 12 | 2 FK + 1 PK + 8 CHECK | 3 + PK | enabled | 0 | 0 |
| RepWorth (production) | `udeyaqnvpojbwgoaxwdg` | present | 12 | 2 FK + 1 PK + 8 CHECK | 3 + PK | enabled | 0 | 0 |

A single fingerprint was computed on each database over the full definition — every column's name, type, nullability, default **and `COMMENT`**, plus every constraint definition, every `indexdef`, the RLS flag, the policy count, and the table comment:

```
staging     md5 = 6d038d30e80bdb1c2e76172dfa401b72   (5423 bytes)
production  md5 = 6d038d30e80bdb1c2e76172dfa401b72   (5423 bytes)
```

**Byte-identical.** The eight CHECKs are the five named constraints C1–C5 plus the three inline column CHECKs on `refusal_source`, `refusal_category` and `subject_type`; both databases carry all five named constraints with C5's strengthened `array_position(…, NULL) IS NULL` clause and the `IS TRUE` wrapper, matching `116_refusal_events.sql` exactly. Both FKs are bare (no referential action) in both projects. Both tables hold zero rows.

**Verdict: PASS — migration 116 is in full lockstep across staging and production, and matches the checked-in migration.**

---

## 10. Stale documentation found (report-only, per skill rules — not fixed)

These are doc-truth defects, not implementation defects. None changes a verdict above.

| # | Location | What is stale |
|---|---|---|
| D1 | #1001 resolution comment, and #1006's *"Sixteen columns stand"* | The row is **twelve** columns, not sixteen. Both tickets' own `CREATE TABLE` block enumerates twelve; both live databases report twelve; `migration-116-refusal-events.integration.test.ts:583` already says "twelve". |
| D2 | `.claude/reference/migrations-log.md:52` | Says the retention sweep is **"NOT YET ENFORCED … the `ArchivalPoller` arm … and the `tenant-scope-allowlist` exemption … land in #1009"**. Both landed: `worker/background/pollers/ArchivalPoller.ts:380-393` and `scripts/ci/tenant-scope-allowlist.ts:1007-1013`. |
| D3 | `scripts/ci/tenant-tables.ts:104-105` | Comment still reads *"the retention sweep arrives with #1009 and will need its own cross-tenant allowlist exemption then, not now"*. The exemption exists at `tenant-scope-allowlist.ts:1007`. |
| D4 | `CONTEXT.md:165` (**Restraint tab**) | Says *"**Not built yet**: #1014 ships it, and the route today has no Metrics/Restraint page-level tabs"*. #1014 landed in `cf219980`; the route exists at `src/app/(authenticated)/dashboard/analytics/restraint/page.tsx`. |

---

## 11. Validation suite

Run at HEAD `f797d250` after all evidence-gathering completed, against the live local test database (`repworth-testdb`, `postgres:16`), so the live-DB lane executed rather than skipping.

| Gate | Result |
|---|---|
| `pnpm typecheck` | **PASS** (`tsc --noEmit`, clean) |
| `pnpm lint` | **PASS** (`eslint .`, clean) |
| `pnpm ci:tenant-scope` | **PASS** — 373 entries (baseline 373) |
| `pnpm ci:rls-audit` | **PASS** — static coverage, 44 tenant tables enable RLS |
| `pnpm ci:static-policy` | **PASS** — 1,251 files scanned |
| `pnpm ci:env-registry` | **PASS** — 186 declared vars incl. 30 flags, every one with a registry row |
| `pnpm ci:directory-map` | **PASS** — 589 files under `worker/`, `src/lib/` each have a row, no stale rows |
| `pnpm test` (whole repo, live-DB lane awake) | **1118 / 1122 test files passed · 14,702 / 14,725 tests passed** · 3 files / 12 tests failed — **all three failures are local-environment, not code** (see below) |

**The three failing suites, diagnosed rather than waved away.** They are
`src/lib/demos/__tests__/lifecycle.integration.test.ts`,
`src/lib/shared/__tests__/response-status-sql.integration.test.ts` and
`worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts`.
None touches the Refusal ledger, and no failing test name mentions `refusal`, `restraint` or `migration 116`.

Root cause: the run exported `DATABASE_POOL_URL` from `.env.local`, whose credentials no longer authenticate against the local
container — the first suite failed with `PostgresError: password authentication failed for user "postgres"`, which tripped
postgres.js's connection circuit breaker (`ECIRCUITBREAKER: too many authentication failures, new connections are temporarily
blocked`) and cascaded into the other two (the third then hit a 30 s test timeout waiting on a connection it could never get).

Re-run with `DATABASE_POOL_URL` pointed at the same local test database as `TEST_DATABASE_POOL_URL`:

```
Test Files  3 passed (3)
     Tests  21 passed | 1 skipped (22)
```

**Ledger-specific re-run**, to record a concrete figure for the surface under audit — `src/lib/refusals/**`,
`src/components/dashboard/restraint/**`, `migration-116-refusal-events.integration.test.ts`,
`suspension.integration.test.ts`, `ArchivalPoller.integration.test.ts`, `persist.test.ts`, `auto-policy-downgrade.test.ts`:

```
Test Files  13 passed (13)
     Tests  272 passed (272)
```

The live-DB half genuinely executed rather than silently skipping — the verbose run of
`migration-116-refusal-events.integration.test.ts` shows all **20** tests green, including the ones that can only pass against a
real Postgres: the RLS/policy-count introspection, the twelve-column type-and-default check, the FK-referential-action check,
the three-index key/predicate check, each of C1–C5's rejection cases, and the `ON CONFLICT` partial-index **inference** proof.

---

## Verdict

Every locked decision on map #994 that this audit covers — #1001, #1006, #995, #998 + #1003, #996, #1002, #1005, #1000 — is implemented as resolved, with `file:line` evidence for each sub-claim. Migration 116 is byte-identical across staging and production.

Four stale documentation claims were found (§10) and are reported, not fixed. None of the four contradicts shipped behaviour; each is a doc that has fallen behind the code.

The three whole-repo test failures are local-environment credential damage in `.env.local`'s `DATABASE_POOL_URL`, proven by a
clean re-run (§11); they are outside this audit's surface and do not qualify the verdict.

**VERDICT: PASS**
