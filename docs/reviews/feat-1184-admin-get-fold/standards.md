# Standards & maintainability review — `feat/1184-admin-get-fold`

Range reviewed: `e8893544..fa2e6e34` (9 commits, 57 files, ~1,246 production lines).
Read-only pass. Green tooling (`lint`, `typecheck`, every `ci:*`, `build`, `diff-coverage`)
is assumed correct and nothing it already covers is re-reported here.

Standards applied: `.claude/CLAUDE.md` (invariants #12, #15; "Working rules" —
no abstractions for a single caller, single authoritative owner per fact),
`.claude/rules/{admin-portal,channels,next-app,supabase-auth}.md`,
`docs/agents/context-layout.md` (800-word rule cap), ADR 0025 D1/D5/D6,
ADR 0026 D1, and the nearest in-tree precedents for each shape.

---

## Verdict

The branch is structurally sound. The seam choices are right: the shared shim is
the correct owner and the correct depth for the mock *logic*; the audit widening
is a tightening (bound handlers) not a loosening (credited shapes), and it is
proven in both directions per verb; invariants #12 and #15 hold across all nine
routes (each still parses → gates → calls one module function; only route files
and pages import the `sql` singleton).

Findings below are all Medium or lower. One is a factual error in a
security-relevant comment. The rest are abstraction-hygiene items: one
speculative export, one untestable failure path, one optional-parameter mode,
one under-extraction the branch's own thesis argues against, one over-claiming
test header, and nine near-duplicate WHY comments.

---

## Findings

### F1 — Medium — `src/app/api/admin/businesses/[id]/channels/route.ts:24-29`

**Smell:** false rationale in a security comment (doc-truth violation), plus an
unexplained divergence from the sibling route.

The comment justifying the gate's move to the first statement reads:

> The gate is now the FIRST statement — it used to run after `await params` +
> `asLocationId`, so a malformed id could answer an unauthenticated caller
> differently from a well-formed one.

That mechanism does not exist. `asLocationId` is a zero-cost cast:

```ts
// src/lib/shared/ids.ts:54-56
export function asLocationId(value: string): LocationId {
  return value as LocationId;
}
```

It cannot throw, and `await params` cannot either, so there is no id shape that
produces a different pre-auth response. The reorder is still the right thing to
do — nothing should run before the gate — but the stated reason is untrue.

This branch's own audit header states the standard being broken here: *"a
security audit that teaches its rule with a citation that is no longer true is
worse than one that teaches it with none"* (`scripts/ci/admin-aal2-audit.ts:175`).

Second-order consequence: because the comment attaches the reorder to a
non-existent hazard, the identical shape in
`src/app/api/admin/businesses/[id]/route.ts:32-35` — which still does
`await params` + `asLocationId` *before* `requireAdminWithAal2` — was left alone.
The branch now ships two orderings for the same handler shape, with a comment on
one asserting the difference matters.

**Smallest correction:** replace the two clauses with the real reason ("the gate
runs before anything else; nothing in this handler should execute for a caller
that has not cleared step-up"), and either reorder `businesses/[id]/route.ts`'s
GET to match or say in one place why it does not need to.

---

### F2 — Minor — `src/lib/auth/__tests__/helpers/admin-gate-mocks.ts:55-71, 138-154`

**Smell:** the single owner of a 31-suite mock is not type-bound to the module it
stands in for.

`AdminGateMocks` types all four members as bare `Mock` (no type argument), and
`mockResolveDualModeIdentity` returns an untyped object literal
(`{ authUserId: 'auth-1', aal, transport }`). The real seam exports its contract:

```ts
// src/lib/auth/verified-identity.ts:42-46
export interface VerifiedIdentity {
  authUserId: string;
  aal: string | null;
  transport: AdminTransport;
}
```

Nothing makes the shim conform to it. If `VerifiedIdentity` gains a field the
gate reads, or `resolveDualModeIdentity`'s signature changes, the shim keeps
compiling and 31 suites keep passing against a stale simulation — which is
precisely the drift class #1183 named and this helper exists to close. The
helper already `import type`s `AdminTransport` from `admin-transport.ts`, so its
own "no runtime import of the mocked modules" rule (lines 45-49) does not block
this; `import type` is erased.

**Smallest correction:** `import type { VerifiedIdentity } from '@/lib/auth/verified-identity';`
then declare the resolver as
`Mock<(request: NextRequest) => Promise<VerifiedIdentity | null>>` and annotate
`makeAdminGateMocks`'s inner arrow with that return type. One line each; a seam
change then becomes a compile error in one file instead of silence in 31.

---

### F3 — Minor — `scripts/ci/admin-aal2-audit.ts:198-212`

**Smell:** speculative generality — an export with zero consumers, justified by a
ticket that does not exist in the tree.

`export const HANDLER_VERBS` is documented as exported so `ci:admin-contract`
(#1190) can reuse it. Grep over `scripts/ src/ docs/ .claude/` finds exactly two
references: the internal use at `:538`, and a prose mention in
`.claude/reference/arch-review-log.md:15`. #1190 is not in the tree.

Sharpening it: the nearest possible consumer — this file's own unit test —
declines to use it. `scripts/ci/__tests__/admin-aal2-audit.test.ts` re-spells the
list as a literal (`for (const verb of ['GET','HEAD','POST',…])`). That is the
right call for the test (importing the list under test would be tautological),
but it means the export currently has no consumer at all, present or planned-in-tree.

This is the "no abstractions for a single caller" rule in CLAUDE.md § Working
rules, and it is a rule `ci:fallow`'s unused-export pass would normally catch —
except `ci:fallow` gates nothing, so no tool covers it.

**Smallest correction:** drop the `export` keyword and keep the doc comment's
"#1190 must reuse this list, not write a second reader" note. #1190 restores one
word when it lands.

---

### F4 — Minor — `scripts/ci/admin-aal2-audit.ts:860-878`

**Smell:** hidden control-flow exit in a helper; the branch's new security floor
is untestable and therefore untested. Cuts against invariant #12 (entry points
orchestrate; modules own failure *behaviour*, not process termination).

`assertAuditCoverage` is non-exported and calls `process.exit(1)` through a local
`fail()` closure. Consequences:

- The three fatal cases (any traversal error, zero route files, zero pages) —
  the whole point of the hardening, and the thing ADR 0025 D6 leans on — have no
  test. The new test coverage stops one level below: it pins that
  `auditRoutes()` *reports* `traversalErrors`
  (`scripts/ci/__tests__/admin-aal2-audit.test.ts`, the
  "reports the directories it could not read" case), never that the audit fails
  on them.
- It cannot get one in this shape: a vitest call would kill the worker.

The file's existing precedent supports this correction rather than the current
shape — `main()` already does its own `console.error` + `process.exit(1)` inline
for the zero-pre-auth-paths case (`:884-890`), keeping the exit at the entry
point.

**Smallest correction:** `export function auditCoverageFailures(routes, pages): string[]`
returning the fatal reasons; `main()` prints them and exits. Three cheap unit
tests then pin the policy.

---

### F5 — Minor — `scripts/ci/admin-aal2-audit.ts:717-786`

**Smell:** optional parameter as a mode switch, kept only for test-call-site
convenience.

`errors?: TraversalError[]` is threaded through `collectNamedFiles`,
`collectRouteFiles` and `collectAdminPageFiles`, giving each function two
behaviours (silent, or recording) — and the doc comment has to explain both
(`:753-768`).

The sink is the right *mechanism* (a separate function would duplicate the
recursive walk, so "should have been a separate function" does not apply here).
The *optionality* is what is unearned: both production callers
(`auditRoutes:815`, `auditPages:831`) always pass a sink. The only sink-less
callers are three lines in the unit test
(`admin-aal2-audit.test.ts:816, 826, 836, 842`). So a mode exists in a security
control purely so three test call sites did not have to change.

**Smallest correction:** make the parameter required, update the four test call
sites to pass `[]`, and delete the "WITHOUT the sink … WITH the sink …" half of
the doc comment. One behaviour, one paragraph.

---

### F6 — Minor — the nine route WHY comments

Files: `src/app/api/admin/{businesses,costs,demos,jobs,nav-counts,notifications,overview}/route.ts`,
`src/app/api/admin/businesses/[id]/route.ts:20-27`,
`src/app/api/admin/businesses/[id]/channels/route.ts:24-29`.

**Smell:** one fact, nine owners (CLAUDE.md § Lab notes & memory: "one
authoritative owner per fact").

Seven of the nine are two prose variants of the same three sentences —
"#1184 (ADR 0025 D5): folded onto the admin control-plane gate … an `aal1` admin
is now refused `mfa_required` where it was served, and a non-auth failure is the
gate's clean `internal_error` 500 rather than `requireRoleOr401`'s re-throw." —
about 34 lines of duplicated prose. The fact is already owned three times over:
ADR 0025 D5, the audit header, and the arch-review-log entry.

Only two carry route-specific content: `costs/route.ts:9-16` (the deleted
hand-written catch that answered 401 for any non-`AuthError`) and
`channels/route.ts:24-29` (the reorder — see F1).

In-tree precedent is against the nine-copy shape. Every pre-existing
`requireAdminWithAal2` call site either carries no comment
(`businesses/[id]/keywords/route.ts:22`, `ranking/route.ts:24`,
`suppressions/route.ts:28`) or one route-specific line
(`businesses/[id]/resend-invite/route.ts:87-88`: *"Auth before spend: no
rate-limit budget and no provider round-trip for a caller that has not cleared
MFA step-up."*).

**Smallest correction:** keep `costs` and `channels`; reduce the other seven to a
single line — `// Gated by requireAdminWithAal2 (ADR 0025 D5, #1184).` The
behaviour-change narrative already lives in the ADR and the review log, where it
will not rot at nine sites.

*(The six page comments are deliberately excluded: each names the specific
cross-tenant data that page reads directly through `sql`, so they carry
per-file content the ADR does not.)*

---

### F7 — Minor — `src/lib/auth/__tests__/admin-gate-mocks.test.ts:173-201`

**Smell:** the assertions are weaker than the header claims — a guard that reads
as stronger than it is.

The header calls this block "THE ANTI-VACUITY PIN" and says it "refuses" the
shape where a suite proves nothing. What it actually asserts:

- `expect(text).toContain('admin-gate-mocks')` — satisfied by the header comment
  every migrated suite already carries (e.g.
  `src/app/api/admin/jobs/__tests__/route.test.ts:11-16` names the helper path in
  prose). A suite that deleted the import but kept its comment passes.
- `expect(text).toContain('makeAdminGateMocks')` — same class of match.
- `not.toContain('resolveDualModeIdentity: async')` — a formatting-sensitive
  literal; a line break after the colon defeats it.
- Nothing prevents the actual vacuity route that survives all three: a suite may
  import the shim and then call
  `mockResolveDualModeIdentity.mockResolvedValue({ authUserId, aal: 'aal2', transport: 'cookie' })`,
  bypassing the shim's logic entirely.

The `vi.mock('@/lib/auth/admin-mfa-gate')` half (`:179-181`) is genuinely load-
bearing and correct — the gap is only in the "drives the gate through the shared
shim" half.

**Smallest correction:** either soften the header to what the text scan can
prove, or replace the substring checks with a behavioural pin — assert each of
the nine suites contains a case where `mockRequireCurrentAal2FromSupabase`
resolves `{ ok: false }` and the handler answers 403 `mfa_required`. That cannot
pass vacuously.

---

### F8 — Minor — residual byte-identical mock body across 10 suites

Sites (line of the block): `businesses/__tests__/route.test.ts:51`,
`businesses/[id]/__tests__/route.test.ts`, `businesses/[id]/channels/__tests__/route.test.ts`,
`businesses/[id]/resend-invite/__tests__/route.test.ts`,
`costs/__tests__/route.test.ts:44`, `demos/__tests__/route.test.ts:30`,
`jobs/__tests__/route.test.ts:53`, `nav-counts/__tests__/route.test.ts:32`,
`notifications/__tests__/route.test.ts:30`, `overview/__tests__/route.test.ts:39`.

**Smell:** the branch's own thesis, applied incompletely.

The shim's header declines to own the `@/lib/db/auth` factory on this premise
(`admin-gate-mocks.ts:41-43`):

> The `@/lib/db/auth` factory stays per-suite on purpose: its OTHER members
> differ (some suites need `AuthError` as a local class, some re-export more).

Measured, that is true for ~20 of the 31 consumers and false for 10: normalising
whitespace and hashing the block yields one identical 14-line body in all ten,
including a re-declared `AuthError` class that mirrors the production one:

```ts
vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error { … }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    loadAppUser: mockLoadAppUser,
    cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
    AuthError,
  };
});
```

That is 140 lines of byte-identical paste — the same class of debt, verified the
same way (by hash), that this ticket set out to retire.

**Explicitly not a finding:** the `vi.mock('@supabase/ssr' | '@/lib/auth/mfa' |
'@/lib/auth/verified-identity')` call sites are also identical in 30/31 suites,
but `vi.mock` is hoisted per file and cannot be moved into a helper. That
duplication is a vitest constraint, not a design choice.

**Smallest correction:** export `makeDbAuthModuleMock(mocks)` from the same
helper and let the ten call
`vi.mock('@/lib/db/auth', () => makeDbAuthModuleMock({ mockRequireRole, mockLoadAppUser }))`.
The ~20 suites with genuinely different members keep their own factories, and
the header's sentence becomes true as written.

---

### F9 — Low — `scripts/ci/admin-aal2-audit.ts:571-585` (`routeGetRequiresAal2`)

**Smell:** an abstraction whose discriminating power collapsed under this diff's
own change, defended rather than reassessed.

P2's parity anchor asks "does the sibling route gate its GET with
`requireAdminWithAal2`?". After the ROUTES widening, any tree that *passes* the
audit already guarantees that for every route exporting a GET. So on a passing
tree the anchor reduces to "does the sibling `route.ts` export a GET at all",
and the reachability-walk machinery behind it is redundant.

Two symptoms in the diff:

- The function's doc comment gained a paragraph defending its narrowness
  (only a gate CALL counts, not a `resolveAdminActor` binding) — a distinction
  that is live only for a case the comment itself says does not exist ("no admin
  GET binds it").
- The composed-pass test now has to hold a fixture in a state CI forbids to keep
  exercising the path: *"the jobs fixture stays ungated on purpose, because
  auditPages below needs it as the PLAIN parity anchor"*
  (`admin-aal2-audit.test.ts`, the widened `auditRoutes` case). A test fixture
  that must remain in a CI-illegal shape is a signal the two contracts have
  merged.

Not fully dead — a sibling route exporting only mutations still yields `false`
and correctly skips P2 — so this is Low, and a comment may be the whole fix.

**Smallest correction:** one sentence in the P2 header noting that since #1184
the anchor is implied for any GET-exporting sibling, so P2's live discrimination
is "sibling exports a GET" vs "it does not". A future reader then knows not to
re-derive the collapsed distinction.

---

## Checked and clean — no finding

- **Invariant #15** — all nine routes and six pages are composition roots
  (`route.ts` / `page.tsx`) importing the `sql` singleton and passing it down;
  no `src/lib/**` module gained a `@/lib/db/server` import. The one `src/lib`
  test that now reaches the gate (`src/lib/admin/__tests__/denorm-queries.test.ts`)
  changes mocks only, not module wiring.
- **Invariant #12** — each folded handler is still gate → parse → one module call
  → map errors. `costs/route.ts` got *shorter* (the hand-written 6-line catch is
  gone). No handler grew a branch.
- **`.claude/rules/` caps and ownership** — `admin-portal.md` 597 words,
  `channels.md` 294; both well under the 800-word cap in
  `docs/agents/context-layout.md:36`. The `ci:admin-aal2` sentence belongs in
  `channels.md` per the repo's own declared ownership
  (`admin-portal.md:43`: *"The admin MFA gate sentence (`ci:admin-aal2`) lives in
  `.claude/rules/channels.md` § Traps"*), so the edit is in the right file. The
  `admin-portal.md` addition is a pointer to a concrete new pin
  (`admin-gate-mocks.test.ts` `readFileSync`s the nine suites by name), which is
  exactly what a retirement-order rule needs and could not be derived from the
  ADR.
- **`.claude/reference/arch-review-log.md`** — 592 words, against 588 for the
  immediately preceding `feat/1186` entry and 324 for `feat/1178`; in band for
  this log, not an outlier. It is a faithful record: every claim in it is
  reproducible from the diff, and points (2) and (4) (the traversal-error floor,
  the shim's two-way guard) are branch facts no ADR owns. Its overlap with the
  audit header — the "widening HANDLERS vs widening SHAPES" argument and the
  "false citation is worse than none" line — is restatement rather than
  contradiction, and the log's role is a per-branch record, so I do not raise it
  as a finding.
- **Shim seam placement and depth** — `src/lib/auth/__tests__/helpers/` matches
  established precedent (`worker/__tests__/helpers/mock-sql.ts`,
  `src/lib/shared/__tests__/helpers/*`, `src/__tests__/helpers/*`), and the
  helper sits beside the module it stands in for. Its API is four members, all of
  which every consumer needs (two to drive, two to wire into `vi.mock`) — no
  leak. Deriving transport through the production `isBearerRequest` rather than a
  test knob is the right depth call and is the thing that makes a bearer case
  non-vacuous.
- **`makeAdminGateMocks`'s temporal coupling** — `mockLoadAppUser` reads
  `mockRequireRole.mock.results.at(-1)`, so it depends on the resolver having run
  first. This is inherent to reproducing the gate's call order, is documented at
  the function (`:118-123`) and is pinned by its own test (`:82-95`). Accepted,
  not a finding.
- **Audit widening posture** — bound-handler set widened, credited-shape
  allowlist and its `resolveSpecifier` provenance check byte-identical. Both
  directions pinned per verb, including `HEAD`/`OPTIONS` which the tree does not
  export (the silent-omission risk). The "gated GET must not clear an ungated
  sibling" property is explicitly re-pinned. This is the strongest part of the
  diff.
- **Page parity test** — `src/app/admin/__tests__/page-aal2-parity.test.tsx`
  proves what a source scan cannot (the runtime options object and the
  gate-before-read ordering), and the ordering assertion (`callOrder[0] === 'gate'`)
  is the non-obvious half. Its service mock list covers exactly the modules the
  six pages import; no dead mocks.
- **Dependency growth** — none. Three new files, all test-surface. No migration,
  no flag, no new top-level directory.
