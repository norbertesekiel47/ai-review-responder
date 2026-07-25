# Step 7 — Standards & Maintainability Review

**Branch:** `feat-544-watch-mode-batch-ui`
**Diff:** `git diff b266ca00..HEAD` (32 files, +4206 / −34)
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-544-watch-mode-batch-ui`
**Reviewer posture:** thermo-nuclear code-quality review + repo standards
(`.claude/rules/repworth.md`, `engineering.md`, `design.md`, `.claude/CLAUDE.md`)
+ `codebase-design` deep-module discipline + `CONTEXT.md` glossary + Fowler
smells + accessibility.
**Read-only:** no file in the diff was modified.

---

## Findings (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| medium | `src/app/(authenticated)/dashboard/requests/requests.css:357-359` | `prefers-reduced-motion` override is scoped `.rq-stack .section-enter`, but `LoadingCard`, `ChooseLocation` and `FailureCard` render `section-enter` outside any `.rq-stack`, so three of the six screens still animate — the file's own stated compensation for `console.css`'s unguarded `.section-enter` does not cover them. |
| medium | `src/app/api/dashboard/solicitation/scope-param.ts:16` | `SOLICITATION_SCOPE_PARAM` is documented (and listed in `docs/directory.md:242`) as the single owner of the `scope` param, but the actual reader `src/app/api/dashboard/policy.ts:48` uses the literal `'scope'` and four sibling client call sites hardcode `?scope=` — engineering.md "one authoritative owner for each piece of system knowledge" is asserted, not achieved. |
| medium | `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:282-299` | `useCompletionAnnouncement` never clears `message`; a second `building → built` transition (reachable via the location switcher, since `wasBuilding` survives scope changes) calls `setMessage` with an identical string, React bails out, and the live region is never re-announced. |
| low | `src/lib/solicitation/batch-view.ts:292-309` | `markBatchReviewed`'s documented return contract — "so the caller can tell 'already reviewed' (0) from 'recorded' (1) — a silent 0 must not be indistinguishable from a failure" — is honored by no caller: the only production call site (`batch/reviewed/route.ts:59`) discards the value and returns 204 either way. Speculative generality (repworth.md "no abstraction for a single caller") plus a comment stating a contract the code does not implement. |
| low | `src/app/(authenticated)/dashboard/requests/GhostPipeline.tsx:42-52` | The props model admits invalid states: `stalled` and `onCheckAgain` are meaningful only when `mode === 'building'`, and `onCheckAgain` is optional — `<GhostPipeline mode="no_batch" stalled />` typechecks, and `stalled` without `onCheckAgain` renders a dead "Check again" button. design.md: "define away invalid states instead of making every caller repeat defensive ceremony"; a discriminated union also deletes the `subhead(building, stalled)` boolean pair. |

---

## What was checked and found clean

Recorded so the next reviewer does not re-litigate these.

### Repo invariants

- **Invariant #15 (explicit DB client).** `src/lib/solicitation/batch-view.ts` takes
  `sql: Sql` / `tx: TransactionSql` as parameters and never imports
  `@/lib/db/server`. The two route handlers and the page are composition roots
  and import the singleton correctly.
- **Invariant #13 (server-authoritative flags).** No `NEXT_PUBLIC_*` companion
  added. `solicitationWatchEnabled()` is read in `(authenticated)/layout.tsx` and
  passed to `Sidebar` / `MobileTabBar` as a prop; both pages and both API routes
  gate before auth (`batch/route.ts:29`; `requireContactsWriteAccess` checks the
  flag ahead of `requireWritableOwner`).
- **Invariant #8 (tenant scope).** Every statement in `batch-view.ts` carries both
  `account_id` and `business_id`; `solicitation_contacts` (no `account_id`
  column) is scoped by the `businesses` join, matching `contacts-repo.ts`.
  Tenant keys are repeated on the outer join rather than hidden inside the CTE,
  which is what keeps them visible to `ci:tenant-scope`.
- **Invariant #12 (entry points orchestrate).** Both routes are flag gate → auth →
  location resolution → one module call → response. No business logic.
- **PgBouncer JSONB carve-out.** `parseEvidence` (`batch-view.ts:94-104`) uses the
  sanctioned `typeof x === 'string' ? JSON.parse(x) : x` guard, validates the
  discriminant, and throws rather than rendering a blank row. The site is added
  to the `.claude/CLAUDE.md` allowlist (16 → 17) in the same diff. No `any`
  anywhere in the branch.
- **Timestamps.** All `timestamptz` reads are `::text` (`batch-view.ts:244`,
  `:186`), correctly avoiding the postgres.js microsecond-truncation trap.
- **Logging.** `logger.log('batch_view_read', …)` emits counts + `businessId`
  only — no contact names, handles, notes, or evidence text. Client
  `console.error` calls carry status codes, not payloads.

### Glossary (`CONTEXT.md` "Solicitation (watch-mode)")

No violations. The code uses **Solicitation batch**, **Ask**, **Withhold
reason** (verbatim codes from `WITHHOLD_REASONS`, never re-typed as literals),
**Evidence snapshot**, **Spoilage report**, **Velocity banking**
(`velocity_banked` glossed as "Saved for the next batch" / "banked", explicitly
*not* a refusal), and **Requests** as the owner-facing surface name. The
forbidden synonyms — "refusal code", "skip reason", "solicitor", "outreach" —
appear nowhere in owner-facing copy or identifiers. `CONTEXT.md` is amended in
the same diff to coin **Requests** and to record that `expired` is deliberately
unimplemented in watch-mode, which is the right place for that fact.

### Deep-module discipline

- **`src/lib/solicitation/batch-view.ts` is genuinely deep.** Interface is
  `readLatestBatch(sql, accountId, businessId) → BatchView` plus
  `markBatchReviewed`. Behind it: a REPEATABLE READ / READ ONLY snapshot, a
  window-function CTE that produces funnel totals + per-reason totals + a
  bounded evidence sample in one statement (correctly justified against a
  cascade-delete tear), `::int` casts against bigint-as-string, zero-fill of the
  closed enum so the UI can never branch on a missing group, server-side name
  truncation, and the JSONB parse. Callers see none of it. The `BatchView`
  discriminated union is the right shape — `no_batch` / `building` / `built` are
  the three things the screen can be, and `built` carries all six groups so the
  renderer has no conditional.
- **The component split earns its keep.** `RequestsClient` (phase machine +
  transport), `BatchReport` (built), `GhostPipeline` (not-built) each hide real
  complexity; none is a pass-through. `GhostPipeline` correctly refuses to split
  `no_batch` / `building` into two shallow components.
- **No file crosses the 1k-line threshold** (largest new file: `requests.css` at
  360; largest new TSX: `RequestsClient.tsx` at 349).
- **No new top-level directory**; the route folder is colocated and deletable,
  matching the stated `landing-experience.css` / `auth-island.css` precedent.
  The contacts page move (`dashboard/contacts` → `dashboard/requests/contacts`)
  is a pure move with the API path deliberately unchanged, and both
  `docs/directory.md` and `.claude/reference/env-vars.md` are updated to say so.

### SQL correctness (spot-checked, not the spec reviewer's job)

- `ranked` computes `group_total` over all withheld asks partitioned by reason,
  so the per-reason total is exact even though only `rn <= 10` rows survive.
- Zero-withhold and zero-ask batches both still return their funnel row, because
  `totals` is an unfiltered aggregate on the left of the join chain.
- `ORDER BY a.withheld_reason, r.rn` gives alphabetical group order, which
  `toGroups` immediately re-orders into `WITHHOLD_REASONS` precedence — the
  within-group `rn` order is what actually matters and it is preserved.
- `markBatchReviewed`'s `GREATEST(NOW(), built_at)` + the two `WHERE` guards are
  correctly reasoned against migration 088's
  `solicitation_batches_reviewed_after_built` CHECK and the worker-clock /
  db-clock skew.

### Accessibility (beyond the finding above)

- Semantic headings: `h2` per card, `h3` per reason group with
  `aria-labelledby` wiring on the `<section>`. (The absence of an `h1` is a
  pre-existing shell fact — `TopBar` renders `.page-title` as a `div` on every
  dashboard page — not introduced here.)
- `aria-busy` on the loading card and on the building ghost (correctly dropped
  when `stalled`, since nothing is in flight).
- `LiveRegion` mounted unconditionally, which is the correct pattern.
- **`console.css` gap correctly compensated locally.** `.btn` (`console.css:1227`)
  has neither `min-height` nor a `:focus-visible` rule; `.rq-action`
  (`requests.css:247-256`) adds `min-height: 44px` plus a visible ring, and
  `.rq-footnote-link` does the same. Every interactive element on this surface
  opts in. This is the right fix at the right scope.
- Colour is never the sole encoder: the hold/bank distinction carries a text
  label, a distinct count noun ("held back" / "banked"), and the verbatim code
  chip; funnel rungs carry captions.
- Contrast is reasoned about explicitly in the stylesheet header, with
  `color-mix` fallbacks layered after the plain token so a non-supporting
  browser still gets the brand hue.
- Ordered lists (`<ol>`) used where order is semantic (funnel, gates), with the
  chevron connector as a decorative `::before`.

### Tests

Unit + integration + component coverage is present and non-trivial:
`batch-view.test.ts` (282), `batch-view.integration.test.ts` (407, with a
5,000-ask perf budget and a localhost-only refusal guard),
`requests-client.test.tsx` (385, covering every non-happy phase including the
`queued: 0` trap-guard), `batch-report.test.tsx` (266), route tests (191). The
integration suite self-documents that it is not hard-gated by
`pnpm test:integration` — but it *is* matched by the `pnpm test` glob and skips
loudly through `describeWithDb`, so it is not the silent-suite class from #520.

---

## Low-confidence appendix (NOT findings — style, judgement calls, precedent-consistent)

1. **`RequestsClient.tsx:269` — `(await response.json()) as BatchView`.** An
   unvalidated cast of a network payload into the union the entire screen
   switches on. production.md's trigger rule says to validate dependency
   responses before they affect state. Weighed down because the three sibling
   files on this surface do exactly the same (`ContactList.tsx:164`,
   `UploadCard.tsx:266`), it is a same-origin first-party API, and the response
   shape is produced by a typed function in the same repo. Fixing it here alone
   would create a fourth convention.

2. **Duplicated `NUMBER_FORMAT`** — `new Intl.NumberFormat()` at module scope in
   both `BatchReport.tsx:198` and `GhostPipeline.tsx:40`. Two owners for one
   trivial fact, in two files that already share a stylesheet. Trivial enough
   that hoisting it may not be worth a shared module.

3. **`GhostPipeline.tsx:138-140` — `headline(stalled)`** is a one-line function
   wrapping a ternary used once. design.md: "reject tiny split-outs that add
   names without reducing reader burden." Inlining it at the call site would be
   marginally clearer. Its sibling `subhead` does earn a name (three branches).

4. **Inline `style={{ marginBottom: 0 }}`** at `BatchReport.tsx:78` and
   `GhostPipeline.tsx:69` — the same override, twice, in two files that own a
   colocated stylesheet where it belongs as a modifier class.

5. **`useLatestBatch` takes `currentScope: string`** rather than the
   `LocationScope` type it is actually given, then compares against `'all'`.
   Same for `withSolicitationScope(path, locationId: string)`. Primitive
   obsession; the widened type discards the discriminant the function then
   re-derives from a string literal.

6. **`useLatestBatch`'s effect body** (`RequestsClient.tsx:189-239`) carries four
   pieces of mutable closure state (`stopped`, `inFlight`, `latest`, `timer`)
   and a hand-rolled deadline check. It is correct and unusually well-commented
   — the deadline-before-`inFlight` ordering rationale is a real insight — but
   it is the densest 50 lines in the diff. I could not identify a specific
   restructuring I have conviction in without knowing whether other polling
   surfaces would adopt it, so this is a note, not a recommendation.

7. **`GATE_COPY` (GhostPipeline) vs `REASON_META` (BatchReport)** are two
   `Record<WithholdReason, …>` maps over the same closed enum in two files. The
   diff justifies this explicitly (teach-the-rule vs explain-this-person), and
   `Record<WithholdReason, …>` makes both exhaustive by construction, so a
   seventh reason cannot be half-added. Accepted.

8. **`GATE_COPY.suppressed` uses the word "skipped".** `CONTEXT.md` lists "skip
   reason" as an avoided *term*; "skipped" here is ordinary prose in owner copy,
   not a competing name for the Withhold reason concept. Not a glossary
   violation, but worth a glance if the glossary tightens.

9. **The GET route inlines its flag gate while the POST uses the shared
   `requireContactsWriteAccess` preamble.** Asymmetric, but the GET has no write
   gate to share, so a second helper for one caller would be worse.

10. **Test doubles use `sql as never`** (`batch-view.test.ts:30, 39`). Hard casts
    in test scaffolding, following the stated `uploads.test.ts` precedent.
