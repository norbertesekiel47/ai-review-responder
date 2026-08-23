# Re-verification of the seven 2026-08-18 handoffs — #890–#896

> ## ⚠ LINE NUMBERS IN THIS FILE ARE PINNED TO `74aee92a`
>
> Four PRs have landed since (#932 `1014aaa6`, #933 `9929c3c7`, #934 `e53302d6`,
> #935 `2f386c52`). **#933 moved `canonicalBatchId` out of `approval.ts`, which
> shrank it 1,352 → 1,333 — every `approval.ts` line below is stale by −19.**
> `outreach.ts` grew +34.
>
> **Re-derive every line number against HEAD before acting on it.** A 2026-08-23
> session did exactly that and caught the drift; copying these numbers forward
> would re-create the staleness class this pass exists to document (§P4).
> The findings are sound; the coordinates are not.

Against `main` @ `74aee92a`. Owner's instruction (2026-08-22): re-verify each and
merge the survivors into ONE ranked backlog with this pass's new findings.

**Nothing prescribed by any of the seven has landed.** Zero hits repo-wide for
`CANCELLABLE_DELIVERY_STATUSES`, `isCancellableDeliveryStatus`,
`WITHDRAWABLE_BATCH_STATES`, `batchDidClose`, `PURGE_TOMBSTONE_SENTINELS`,
`REVIEWED_NOT_TENANT_SCOPED`, `useAdminActionForm`, `lane-writes`,
`merge-ledger` (outside `docs/reviews/`). No `src/lib/solicitation/delivery-status.ts`.
No fan-out audit in `scripts/ci/`.

## #890 (H1) — VERDICT: DRIFTED

The finding holds exactly; every cited line moved (`approval.ts` +210 as
expected). **Still exactly six spellings — the window added none** (exhaustive
grep of `'queued'` across `src` + `worker`: 29 hits, 6 are the cancellable pair).

| Role | Issue said | Current |
|---|---|---|
| SQL (leave literal) | `approval.ts:494` | **`approval.ts:569`** |
| SQL (leave literal) | `approval.ts:1126` | **`approval.ts:1300`** |
| SQL (leave literal) | `batch-view.ts:948` | **`batch-view.ts:957`** |
| TS (rewrite) | `approval.ts:1010-1011` | **`approval.ts:1185`** |
| TS (rewrite) | `ApprovalPanel.tsx:973` | **`ApprovalPanel.tsx:980`** (fn at `:978`) |
| TS (rewrite) | `AskList.tsx:306` | **unchanged `:306`** |

Other corrections: `isWithdrawableState` `:939-941` → **`:1113-1114`**, and it is
now a **single line**, not a 3-line body · `HaltableState` `:144-146` →
**`:144-147`** · the "IN list stays literal" rationale `:1119-1120` →
**`:1289-1290`** · the complement the issue warns against `:1146` → **`:1320`** ·
the two query-shape pins `approval.test.ts:302`/`:570` → **`:303`**/**`:605`** ·
the understating sentence `SolicitationBatchPanel.tsx:403` → **`:409`** ·
`TERMINAL_DELIVERY_STATUSES` still module-private, `outreach.ts:113-116` →
**`:149-156`**.

**New in-window fact the ticket must NOT fold in:**
`worker/jobs/solicitation-send/failed-hook.ts:90` —
`return status === 'queued' || status === 'sending';` — is a **seventh**
two-member delivery-status set, landed this window (#912). It answers "is this
row in flight", not "is it cancellable". **Three distinct subsets now live in the
lane; the anti-pattern guard about not answering three questions with one
constant just gained a concrete instance.**

## #891 (H2) — VERDICT: WORSENED

**Four sites → five, two forms → three. The window added the third form.**

All four route line numbers held: `dashboard/…/halt/route.ts:45`,
`dashboard/…/withdraw/route.ts:43`, `admin/…/halt/route.ts:91` (all
`result.close.status !== 'not_settled'`), `dashboard/…/approve/route.ts:60`
(`result.close !== null`).

**Drifted:** the pre-narrowing ternary `approval.ts:404` → **`:466`**. The union
`outreach.ts:201`/`:359` → **`:204-222`** / **`:372`**.

**The fifth site / third form — `release.ts:465`:**

```ts
if (result?.status === 'closed') tally.handled += 1;
```

A positive match, so it silently **excludes `closed_without_parent`**. Correct
today only because `runBackstopJoin` passes no `failure` and cannot reach that
arm — an argument spelled out in prose at `release.ts:434-439` and nowhere
mechanical. **A third answer to the same question whose correctness rests on a
caller-local argument — precisely the shape H2 exists to eliminate.**

**The concrete defect is confirmed and still false.** `ApprovalPanel.tsx:568-569`
still says *"approve, halt and regenerate do not send them"*; `approve/route.ts:60`
and both halt routes DO send `closed`. Read at `:637`, consumed by
`withdrawnAnnounce` (`:700` → **`:705`**, reads `done.closed` at **`:707`**).
**#886 is still OPEN — the "land before or with #886" constraint is intact.**

## #892 (H3) — VERDICT: DRIFTED

Duplication and the count claim hold **at the exact cited lines** (neither file
changed in the window). **One of the two truth claims is REFUTED.**

**Duplication — all seven pairs verified byte-for-byte** at the issue's own line
numbers: writer `purge-stages.ts:648, 649, 657, 661, 667, 668, 672, 696` ↔
verifier `purge-verification.ts:97, 113, 120, 121, 122, 144, 161, 162`.

**Truth fix 1 — the asymmetry EXISTS, but the stated rationale is FALSE.**
`purge-verification.ts:120` uses `IS DISTINCT FROM`, `:144` uses `<>`. But the
issue's reason — *"`tracked_keywords` is nullable (`014:74`)"* — reads only the
`ADD COLUMN` and misses the rest of the same file:

```sql
-- 014_retention_expansion.sql:116-121
UPDATE businesses SET tracked_keywords = '[]'::jsonb WHERE tracked_keywords IS NULL;
ALTER TABLE businesses
  ALTER COLUMN tracked_keywords SET DEFAULT '[]'::jsonb,
  ALTER COLUMN tracked_keywords SET NOT NULL;
```

No later migration drops it (all of `supabase/migrations/` grepped).
**`tracked_keywords` is `NOT NULL`, so `<>` cannot go three-valued and the
predicate is sound today.** `tone` (`001:71`) genuinely is nullable — **the
asymmetry is justified by the schema, not a latent bug.**

**Corrected version for the issue:** keep the item as a consistency/legibility fix
(`IS DISTINCT FROM` reads identically under either nullability and survives a
future `DROP NOT NULL`), **delete the "contributes nothing to an OR-chain"
argument, drop the severity claim, and retag `enhancement`.**

**Truth fix 2 — both halves CONFIRMED.** `tone` is not the only restored column:
`tracked_keywords = '[]'::jsonb` (writer `:672`) is also the schema default
(`014:120`). **Two members.** Counted mechanically: the `businesses` OR-chain
(`:113`–`:150`) is **28 predicates**; the writer's `SET` clause is **28 tombstone
columns** + `updated_at`. **Corrected doc line: `docs/directory.md:1210`, not
`:1176`** — and it repeats the same one-member `tone` claim.

## #893 (H4) — VERDICT: STILL VALID

Part 1 is at the **exact cited line, unchanged**:
`src/lib/admin/suppressions-service.ts:72` —
`const [rows, corrections] = await Promise.all([sql\`…\`, sql\`…\`]);`. The sibling
counter-instruction still reads
`// SEQUENTIAL — do NOT re-introduce a Promise.all here (#505).` at
`src/app/api/admin/costs/route.ts:20`.

**No new fan-out from the window.** Every `Promise.all` binding ≥2 `sql` tagged
templates was blamed; newest is 2026-08-09, nothing from the seven counting
merges. The new admin breaker routes each issue **one** call.
`send-breaker.ts`, `release.ts`, `dispatch.ts` contain **zero** `Promise.all`.

**Part 2 — the enumeration is unchanged, and it misses a SECOND subject.**
Beyond `lookupSuppressions`, **`getAdminNotifications`
(`src/lib/admin/notifications-service.ts:137`) is a THREE-element `Promise.all`**
— two `sql.unsafe` + one tagged template — in the same directory, reached from a
server page (`admin/notifications/page.tsx:15`) and an API route
(`api/admin/notifications/route.ts:32`), and in **neither** pin. **Fan-out of 3
against `DB_POOL_MAX` = 3.** Add it as a second Part-1 subject; it makes Part 2's
"the enumeration cannot be complete" argument non-hypothetical.

## #894 (H5) — VERDICT: STILL VALID

**Step-1 adoption count: exactly ONE, unchanged.** A repo-wide grep for
`tenant-tables` across `src` + `worker` (excluding `__tests__`) returns a single
production hit: `src/lib/solicitation/batch-view.ts:399`. The exemplar block
moved **`:389-400` → `:395-405`**. Every other tenant-scope comment (~45) is
about the **allowlist** or the analyzer — a different convention. **Zero new
adoptions in the window.**

**The named Step-1 targets are all still uncommented:**
- `src/lib/dashboard/pending-count.ts:29-30` — the false claim is verbatim
  intact. **Do this one first, as the issue says.**
- `src/lib/admin/suppressions-service.ts` `LEFT JOIN users` — `:110` → **`:109`**,
  no comment.

**Steps 2–3 premises verified:** `localScopedBindings` still at
`tenant-scope-audit.ts:942` (exact). The completeness test still asks only one
direction (`tenant-tables.integration.test.ts:50-58` — **corrected from `:52-58`**).
All four tables remain absent from `TENANT_TABLES`.

**One in-window addition worth a line in the ticket:**
`solicitation_send_breaker` (migration 110) is a new `public` table absent from
`TENANT_TABLES`. It carries no `account_id`/`business_id`, so it would **not**
fail Step 3's proposed query — but it is the first table wanting a
`REVIEWED_NOT_TENANT_SCOPED` entry on **platform-scoped** grounds rather than the
four's existing grounds. **A gap in the proposed fix, discovered by a table that
landed after the fix was proposed.**

## #895 (H6) — VERDICT: DRIFTED (item **(b)** is REFUTED — the window delivered it)

**(a) unguarded `HALT_REASON_LABELS` — STILL VALID, and its scenario just fired.**
`SolicitationBatchPanel.tsx:369` → **`:375`**, still unguarded. The file's own two
`Object.hasOwn` uses `:130`/`:138` → **`:136`**/**`:144`**;
`ApprovalPanel.tsx:294-297` → **`:302`**. **The union grew this window** —
`platform_halt` is the sixth `HaltReason`. **A browser cached behind the deploy
that shipped 111 renders `undefined` into the sentence — the exact "server
deployed ahead of the browser" case its sibling `NOT_HALTABLE_FALLBACK` reasons
about.**

**(b) `latchHalt`'s unpinned CAS — REFUTED. Already fixed by #920/#900.** The CAS
moved `:479` → **`:554`** and its docstring at **`:518-524`** now names the issue
by number:

> *"**This arm is the system arm's ONLY defense, and deleting it is silent.**
> Issue #895(b) recorded that both human arms refuse at `state === 'halted'`
> first … `latchSystemHalt` skips that guard, which is what finally makes this
> line load-bearing; the monotonicity property in
> `approval-system-halt.integration.test.ts` goes RED when it is removed."*

Both requested tests exist: `approval-system-halt.integration.test.ts:363`
(example, comment at `:365-366` cites #895(b)) and **`:433`** (property, comment
at `:435`). **F4's agent ran the mutation and confirmed both go RED.**

**Drop (b) from the bundle** — which removes the issue's own "if the bundle has to
shrink, keep (b)" rationale for shipping it at all.

**(c) stale purge contract — STILL VALID, and UNDERCOUNTED.**
`purge-stages.ts:794` still ends *"Unreachable today (recordSuppression has zero
production callers, G6)"*. Not two writers — **four**:
`src/lib/solicitation/contacts-repo.ts:250`, `src/lib/solicitation/unsubscribe.ts:402`,
`src/lib/admin/suppressions-service.ts:168`,
`worker/ingress/resend/solicitation-lane.ts:243`. None references the contract.
**Correct the ticket to four.**

**(d) one-sided lock-order doc — STILL VALID.** `purge-stages.ts:396-402` →
**`:392-403`**; still only the FK rationale. The dependent side is intact at
`approval.ts:42-46`.

**(e) `recordFailure` missing `business_id` — STILL VALID, DRIFTED heavily.** The
file **did** change this window (#904) and the omission survived. `recordFailure`
is now at **`solicitation-lane.ts:433`**, its log block at **`:457-463`**. The four
siblings `:298`/`:328`/`:356`/`:368` → **`:357`, `:389`, `:417`, `:429`**, all four
still logging `business_id`.

**(f) `auth-island.css` outside the guards — STILL VALID, with a refinement.**
`:5-15` confirmed exactly: 8 colour tokens (`:6-13`) + 2 font tokens (`:14-15`).
The three token/scope guards scope to `globals.css`, `sections/landing`,
`(public)/_styles`, `(authenticated)/_styles` — **`src/components/auth/**` is in
none.** **Refinement the ticket lacks:** the file is *not* entirely unwatched —
`island-overflow.test.ts:21` and `no-yellow-star-colors.test.ts:46-47` both name
it — so **the fix must extend the *token* guards specifically**, not "add the
directory to the design tests". **Font divergence confirmed and DRIFTED:** the
rebrand moved the reference declarations `globals.css:121-122` → **`:156-157`**.

## #896 (H7) — VERDICT: DRIFTED (Part 1) / STILL VALID (Part 2)

**Part 1 — premise confirmed by the log itself; the numbers are stale.**

No `ci:merge-ledger` anywhere. **Every path in the governance path set still
exists**, verified individually; `scripts/feature-*.sh` resolves to four files.
**The path set needs no revision.**

**Drifted:** the counter no longer reads 8. HEAD `74aee92a` (#929) hand-corrected
it to **7** with a derivation table at `arch-review-log.md:13-45`. That block
calls itself *"the THIRD consecutive pass to find this counter wrong by its own
rule"* (`:17-19`), **names #896 as the mechanical fix** and says *"until it lands,
this number is hand-kept and should be re-derived, not believed"* (`:19-20`), and
records **#905 with 51 production files and "Counted before? no"** (`:30`), adding
at `:41-45` that *"nothing outside the `/feature` workflow's step 8 ever
increments it, so any merge that does not run that workflow is invisible by
construction."*

**That is #896 Part 1's premise restated verbatim by the artifact it describes.**
Corrected framing: the recurrence is now documented *in the repo*, four merges
were missed in one window (#901, #905, #925, #926), and the fix is a
hand-correction on a hand-kept number — **one more data point, not a resolution.**

**Part 2 — STILL VALID, and there are TWO hooks, not one.**

`.claude/hooks/typecheck-on-stop.sh:53-62` still blocks unconditionally on any
non-zero eslint over changed files. No mutation sentinel exists anywhere. No
unused-symbol carve-out. **`.codex/hooks/typecheck-on-stop.sh:40-45` is a second,
structurally identical copy** — the issue named only `.claude/hooks/`; **the fix
must land in both or the Codex lane keeps the hole.**

Partial mitigation the ticket does not mention: the hook is stamp-limited
(`BLOCKED_STAMP`, `:34-35`), so a given dirty-tree hash blocks **once**. That
prevents a loop; it does not prevent the dangerous edit, because the blocking turn
still feeds the model *"fix before finishing the turn"* alongside the orphaned-import
error.

Measurement subject intact: the invariant #3 conjunct is at
`worker/jobs/publisher/auto-policy-publish.ts:491` — **corrected from `:489`**.

## Ranked list

**Criterion, stated:** rank by **expected cost of NOT doing it before the next
window** = `(live-defect severity × reachability) + (rate at which the window is
adding new instances) + (work it unblocks) − (implementation cost)`. A
maintainability risk outranks a live defect only when the window is actively
multiplying it. Ties break toward the cheaper item.

| # | Issue | Why here | Cost |
|---|---|---|---|
| **1** | **#896 (H7)** | The only item that changes the **rate** at which the other six accumulate. Part 1's premise is now confirmed in the repo's own words; four merges missed in one window; corrected by hand for the third recorded time — a process that has demonstrably not converged. Part 2 is an **active safety hole** in an agent workflow whose mechanically obvious remedy deletes a posting precondition (invariant #3), in **two** hook copies. **Part 2 is ~10 lines and should not wait for Part 1.** | P2 trivial; P1 one path/diff script + wiring |
| **2** | **#893 (H4)** | The only **live production defect**: two concurrent statements against a pool of three on a Vercel admin route, with the counter-instruction written in code one directory away. Part 2 now has **two** proven misses, not one. Ship Parts 1 and 2 together. | P1 two lines; P2 one AST audit + wiring |
| **3** | **#891 (H2)** | **The only issue the window made worse**, and the brief's own tiebreak says a worsened finding outranks a new one of equal size. Carries a real, currently-false comment and a hard ordering dependency: **#886 is open and asks to extract exactly that section**, and an extraction trusting that sentence drops a field two routes populate. | one 3-line fn + 3 call sites + one comment |
| **4** | **#890 (H1)** | Not worsened — still six spellings. But it **blocks nothing and is blocked by nothing**, its LOCKED third-caller trigger has fired, and the window handed it a fresh argument: `failed-hook.ts:90` is a *seventh* subset, so "one constant must not answer three questions" is no longer hypothetical. Below #891 only because #891 has a deadline. | one leaf + 3 rewrites + 1 test + directory row |
| **5** | **#895 (H6)** | **Re-scope to five items — (b) is done.** That removes the bundle's stated reason for existing, so it becomes what it looks like: five cosmetic/truth fixes. **Split it.** (a) has a newly live trigger. (c) now misstates by four writers and carries the only real adjacent risk (the Resend-retries-forever gap). (d), (e), (f) are one-liners. | five independent 1–5 line edits |
| **6** | **#892 (H3)** | Untouched by the window, and **one of two truth claims is refuted** — removes the "bug" framing and the severity argument; **retag `enhancement`**. Nothing has moved these files since #882. **Edit the issue before working it** or the implementer chases a nullability hazard that does not exist. | one leaf + 7 substitutions + 2 doc fixes |
| **7** | **#894 (H5)** | Correctly last. Step 1 has **zero** new adopters, so nothing is compounding. The issue's own measurement (77 bindings, 63 red, **zero live leaks**) says the naive fix buys nothing. **Within Step 1 the single highest-value edit is two lines: `pending-count.ts:29-30`, which states a FALSE reason for correct scoping** — worth pulling into whatever ships next rather than waiting for the whole ticket. | Step 1: N comments; Steps 2–3 correctly deferred |

**Ship-together pairs:** #891 with (or before) #886 · #893 Part 1 with Part 2 ·
#893's and #896's new `ci:*` scripts both touch ci.yml + lefthook.yml +
`ci-audit-wiring.test.ts` — **sequence them or expect a conflict**.

## What changed since 2026-08-18 that nothing anticipated

1. **A production docstring now answers an open GitHub issue by number.**
   `approval.ts:518-524` cites *"Issue #895(b)"*. #900/#920 read the handoff,
   delivered its fix, and left the issue open — **so the issue tracker and the
   source disagree about whether (b) is done.** Anything re-deriving H6 from the
   issue text alone will re-do finished work.
2. **`release.ts:465` opened a third form of the close-settled predicate** —
   nobody flagged it, and it is safe only because that one caller passes no
   `failure`.
3. **`failed-hook.ts:90` added a third two-member delivery-status subset.**
   Neither #890 nor the scope brief lists it. It is the strongest new argument
   *for* #890 and simultaneously the thing #890's anti-pattern guard forbids
   folding in.
4. **`platform_halt` made `HaltReason` six members, which armed H6(a).** Nobody
   connected #917 to the unguarded admin-panel lookup that renders those reasons.
5. **`solicitation_send_breaker` is absent from `TENANT_TABLES` on grounds none
   of H5's four tables share.** H5 Step 3's proposed completeness query would not
   catch it.
6. **The Stop hook exists in two copies**, and the `.codex/` one was modified
   `Aug 18 01:35` — the same day the pass ran. #896 Part 2 names only one.
7. **`purge-stages.ts:794`'s "zero production callers" is now wrong by four, not
   two.**

## Confidence and gaps

**High confidence** on #890, #891, #892, #893 Part 1, #894 Step 1, #895
(a)(c)(d)(e)(f), #896 both parts — every claim is a line read at HEAD, and the
negative claims come from exhaustive greps plus `git blame` on every candidate.

**Gaps:**
- **#893's severity is UNVERIFIABLE without a live pooler.** The pin file's own
  "SEAM HONESTY" note (`pool-fanout-sequential.test.ts:23-29`) says the pipelining
  effect cannot be reproduced without real Supavisor. The verdict covers code
  shape only; **the issue's "latency and contention, not the old permanent wedge"
  framing still stands and should not be upgraded.**
- **#894 allowlist-instance counting deliberately skipped** (F8's agent owns it).
- **No `pnpm test`, `pnpm typecheck` or `ci:*` script was executed.** All
  CI-surface claims are read off `package.json`, `scripts/ci/` and the workflows.
- `docs/directory.md:1210` vs the issue's `:1176` — current line and content
  confirmed; not diffed to find which merge shifted it.
