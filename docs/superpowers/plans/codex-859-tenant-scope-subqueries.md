# #859 — query-block-aware tenant-scope audit

## Fixed point and integration evidence

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-859-tenant-scope-subqueries`
- Base: `2aa9c4fe` (`origin/main`, including #629, squash-merged #651, and #629's post-merge documentation sweep)
- Intake: `docs/superpowers/plans/codex-859-tenant-scope-subqueries-intake.json`
- Risk: high because this CI gate protects service-role tenant isolation.

The surface checker reports the still-armed #651 worktree because its historical
intake names the parser. This is not concurrent work: PR #857 is merged as
`fd0b48f3`, which is in this branch's base, and the `sqlUnsubscribe` parser/tests
are present here. The reviewed #651 worktree remains untouched.

## Design constraints

Analyze SQL as lexical query blocks, not as one flattened statement. Child
blocks are removed from their parent before parent analysis. Model each table
binding as an occurrence keyed by block path plus alias; prove every occurrence
individually, including two aliases of the same table, and deduplicate only
after proof. Alias names never cross lexical blocks, so a child shadow cannot
inherit by name. A child may inherit ancestor proof only through an explicit
tenant-identity equality to a proven ancestor occurrence; row-id correlation is
insufficient. OR and NOT stay fail-closed, and every set-operation arm is
independent.

One lexer produces the representation consumed by block discovery, table
binding, predicate equality, AND/OR/NOT handling, set splitting, and comment
normalization. It masks SQL single quotes (including doubled escapes), E-string
backslash escapes, tagged/untagged dollar quotes, and nested/line comments so
they contribute no table or scope evidence. It preserves quoted identifiers as
identifiers and balanced `${...}` expressions as canonical bind atoms. Ordinary
parentheses are traversed; only a contained SQL statement becomes a child
block, so `COALESCE((SELECT ...), 0)` remains visible. The JavaScript template
extractor separately balances nested braces and quoted `}` characters inside a
placeholder expression. No ignore pragma or parser dependency is introduced.

CTE bindings participate in lexical name resolution: a CTE called `reviews`
shadows the physical table only where PostgreSQL makes that binding visible.
SELECT and data-modifying UPDATE/DELETE CTE bodies are child blocks. LATERAL
children follow the same ancestor-correlation rule as other correlated blocks.

## Tracer 1 — prevent lexical scope laundering

- Observable behavior: nested tenant-table occurrences can neither borrow
  unrelated outer/sibling scope nor disappear from the audit.
- Test seam: `auditSqlText` fixtures in the existing audit suite.
- Exact tests: every parser title locked in the intake, including same-table
  self-joins, alias shadowing, false scope and false table evidence inside each
  lexer atom, nested scalar queries in functions, LATERAL, DML CTEs, CTE-name
  shadowing, and the extractor's nested-brace placeholder case.
- Blocking edges: preserve the existing OR/NOT and scope-laundering tests; the
  parser design must be proved before runtime SQL cleanup.
- Precedent: conservative predicate analysis already in
  `scripts/ci/tenant-scope-audit.ts` and the scanner-hardening rule in
  `docs/security/tenant-isolation.md`.
- Allowed files: parser and parser test only.
- Completion evidence: targeted audit suite green with red-first evidence for
  every new failure-direction test.

## Tracer 2 — repository-wide audit and allowlist triage

- Observable behavior: every repository SQL template is re-audited under the
  new block rules; no new finding is suppressed without source evidence, and
  every unscoped occurrence has a deterministic identity including normalized
  template fingerprint plus same-fingerprint ordinal, statement/set-arm/block
  path, table, alias, and binding ordinal.
- Test seam: `pnpm ci:tenant-scope`.
- Deterministic check: gate passes with the actual allowlist count equal to its
  baseline.
- Blocking edges: Tracer 1 green. Keep the existing `auditSqlText` interface as
  the single deep seam: an unscoped `TenantScopeFinding` gains one optional
  `sqlIdentity`; allowlist-integrity findings may omit it. `auditRepository`
  prefixes the per-template identity with the same-fingerprint occurrence
  ordinal derived from extraction order, so byte-identical templates in one
  file remain distinct. The repository CLI prints the identity; no second
  exported detailed analyzer is introduced.

  Occurrence analysis runs before allowlist matching. Preserve today's exact
  full-template-and-table allowlist semantics: a matching entry remains a
  human-reviewed exception for that table across the exact template, while the
  analyzer can still prove each occurrence when auditing with allowlists
  disabled for triage. Decision rule: parser false positive → fix the parser;
  legitimate global flow → retain/add one exact categorized entry; genuine
  tenant leak → stop for an approved edit-surface amendment and fix the runtime
  query, never suppress it. Inspect every new finding and limitation-worded
  entry before changing the baseline.
- Precedent: categorized exact-match allowlist with dead-entry guards.
- Allowed files: parser, parser tests, allowlist, tenant-isolation guidance,
  and the relevant lab note.
- Completion evidence: `docs/reviews/codex-859-tenant-scope-subqueries/repo-audit-triage.md`
  records the before/after count, allowlist-disabled proof, identity-backed
  disposition, and any required stop/amendment for every removed or newly
  exposed entry.

## Tracer 3 — restore #629's natural approval SQL

- Observable behavior: lock/readiness queries use scoped scalar/`NOT EXISTS`
  shapes without changing approval or halt results.
- Test seam: existing `approveBatch` unit/live-database suites.
- Deterministic check: focused approval integration suite plus tenant-scope
  gate.
- Blocking edges: Tracer 2 proves the parser accepts the intended scoped
  blocks. Preserve request-entry UUID canonicalization from #629/#858.
- Precedent: the original #629 plan SQL and deviation D7.
- Allowed files: `src/lib/solicitation/approval.ts` and its existing integration
  test only if a behavior assertion is required.
- Completion evidence: mixed-case, foreign-account, readiness, exclusion,
  withheld, and replacement cases remain green.

## Tracer 4 — restore independent batch-view subqueries

- Observable behavior: the Requests read model uses natural independent scalar
  aggregates/`NOT EXISTS` without recreating the rejected child-table cross
  product.
- Test seam: statement-shape unit assertion plus existing live-database read
  model cases.
- Deterministic check: batch-view unit and integration suites plus tenant-scope
  gate.
- Blocking edges: Tracer 2; Q5-Q7 may combine only as independent scalar
  aggregates.
- Precedent: `batch-view.test.ts`'s #629 performance-shape guard.
- Allowed files: `src/lib/solicitation/batch-view.ts` and its two test files.
- Completion evidence: result behavior unchanged and the shape test proves no
  child-table cross product.

## Verification and rollback

After each tracer, run its focused command. Then run all intake commands and
`.agents/skills/feature/scripts/verified-gate.sh --review`. Rollback is atomic:
revert the parser, allowlist/baseline, documentation, and SQL cleanup together.
No migration, data repair, flag, or deployment ordering is involved.

## Approved execution amendment — 2026-08-17

The first full review gate measured 1,287 production changed lines, exceeding
twice the intake's 380-line estimate without changing behavior or edit domains.
The user approved re-estimating production/test changes to 1,300/450 lines and
adding `src/lib/solicitation/__tests__/approval.test.ts` as the unit seam needed
to instrument the restored scalar-parent and `NOT EXISTS` approval paths for
changed-line coverage. This is the run's first surface amendment.

The final anti-thrash reclassification keeps the same standard/high/backend
lane and edit surface while updating the test estimate to 1,100 lines. The
increase records the accepted adversarial parser regressions found during
independent review; it does not add behavior, files, dependencies, or authority.

## Branch review round — 2026-08-17

The reviewed branch (fingerprint `936e4757…`) had two analyzer false negatives
that the flattened scanner did not have — proof on a scope column the table
lacks, and grandchild inheritance of a shadowed alias — plus a cosmetic
over-extraction of nested plain literals. All three are fixed on this branch
before merge; the record, evidence and surface amendment are deviation D2 and
`docs/reviews/codex-859-tenant-scope-subqueries/repo-audit-triage.md`
§ Verification evidence. Tracer 1's design constraint now also reads: a scope
predicate is proof only on a column the table physically carries
(`TENANT_SCOPE_COLUMNS`, schema-asserted).
