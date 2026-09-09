# Red team — feat/1184-admin-get-fold, round 1

| | |
|---|---|
| mode | `feature` |
| run_id | `feature-feat-1184-admin-get-fold-e01d50` |
| branch | `feat/1184-admin-get-fold` |
| fork_sha | `e8893544204888d6b1639de4f2612cf84517954f` |
| merge_base_sha | `e8893544204888d6b1639de4f2612cf84517954f` |
| head_sha | `fa2e6e34b3dccb34f02ceb8d85ff0f44b78bd522` |
| intake_sha256 | `48019da698791749fcf5673e533afc78eec73f797d1414da8c5f51db92109c60` |
| risk | `high` |
| round | 1 |
| **status** | **`OPEN_P0`** |

**Mutations run 13 · killed 11 · survived 2** (one reclassified `equivalent`
with proof, one reclassified `inconclusive/oracle`). Inventory rows 101 —
8 `killed`, 1 `equivalent`, 1 `inconclusive`, 89 `skipped-budget`, 2 `excluded`.

Preconditions all passed before any mutation: tree clean at `fa2e6e34`
(`git status --porcelain --untracked-files=no` empty), `watchers` reported none,
`round-start` opened round 1 with 30 runs. Environment isolated via
`mutation-runner.mjs env --tmp-home` plus `dotenv-swap` (1 file). The finalizer
ran before this file existed; see **Restoration** — it required a documented
hand-resolution and the tree is verified back at `fa2e6e34`.

---

## Findings

| # | Severity | file:line | Finding |
|---|---|---|---|
| F1 | **P0** | `.claude/reference/arch-review-log.md:47` | The branch's own review entry claims #1182 set `MFA_ENFORCEMENT_ENABLED=true` on **production**; three in-repo records say production is still OFF — and that flip is ADR 0025's hard prerequisite for this fold |
| F2 | P1 | `scripts/ci/admin-aal2-audit.ts:860` | The new anti-vacuity floor (`assertAuditCoverage` / `main()`) has no covering test — neutering it leaves all 91 audit tests green |
| F3 | P1 | `src/lib/auth/__tests__/helpers/admin-gate-mocks.ts:110` | The shim's stated bearer guarantee is false: hardcoding `transport` leaves every "bearer ok" route case passing. The header is forced by nine per-suite assertions, not by the shim |
| F4 | P2 | `src/components/admin/nav-counts-query.ts:17` | The sidebar's 60 s `nav-counts` poll now 403s forever on the two admin pages that stay plain — including `/admin/security`, the MFA enrollment surface |
| F5 | P2 | `docs/runbooks/evidence/2026-09-01-phase-h-beta-launch-evidence.md:157` | A `path:line` citation this branch invalidated was not updated |
| F6 | P2 | `src/lib/auth/__tests__/admin-gate-mocks.test.ts:179` | The anti-vacuity pin is a source-text scan and names only two spellings of the hole (recorded bound, not a defect) |
| F7 | P2 | `src/lib/auth/__tests__/admin-gate-mocks.test.ts:5` | The handed-over evidence says 27 shim consumers; the tree has 30 files (29 admin route suites + `denorm-queries`). The branch's own docs are correct |

### F1 — P0 · Duty 3 · `.claude/reference/arch-review-log.md:47`

The entry this branch adds says the `aal1` refusal is

> safe only because #1182 put `MFA_ENFORCEMENT_ENABLED=true` on staging AND
> production, so the proxy offers the step-up

Three records at HEAD contradict the production half:

1. `.claude/reference/env-vars.md:653` — "**STAGING `true` since
   2026-09-08T08:57:39Z (#1182); production still OFF** (no Vercel row exists
   for it at all in production scope, so it reads unset/false there)". This file
   is **not** touched by the branch.
2. The same log's own #1182 entry, `.claude/reference/arch-review-log.md:1912`,
   whose changed-file list reads "`.claude/reference/env-vars.md`
   (`MFA_ENFORCEMENT_ENABLED` **staging flip**)".
3. Commit `cca34475`, subject "feat(1182): admin reset — a reversible revoke,
   and `MFA_ENFORCEMENT_ENABLED` **on staging** (#1216)".

Why it is P0 rather than a stale line number: the sentence is the *stated safety
premise* for the declared behaviour change, and
`docs/adr/0025-dual-mode-admin-gate.md:182-188` (LOCKED) makes the production
flip blocking —

> With `MFA_ENFORCEMENT_ENABLED` off, the proxy does not redirect an `aal1`
> admin to `/mfa/challenge` … Every admin must be enrolled and the flag flipped
> on BEFORE the fold ships. That flip is its own ticket.

None of the branch's own documents records the prerequisite: `grep -n
"MFA\|1182\|prerequisite\|flag"` over `…-deviations.md` and `…-handoff.md`
returns one unrelated line. The review entry is the only place it is mentioned,
and it says the prerequisite is met.

This is **not** a review of the flag decision (out of scope) and **not** a
challenge to the owner-accepted `aal1` refusal (ADR 0025 D5). It is a false doc
claim asserting that a shipping prerequisite has already been satisfied. Fixing
it is either a correction of the sentence plus an explicit "prerequisite still
open" note, or evidence that production was in fact flipped — in which case
`env-vars.md:653` and the #1182 entry are the stale records and must move in the
same change.

### F2 — P1 · Duty 1 (uncovered change) · `scripts/ci/admin-aal2-audit.ts:860`

Claim 2 says `main()` "refuses to report clean about a tree it could not read".
The code does that (`assertAuditCoverage`, lines 860-877, called at :893).
Nothing tests it.

Mutation **C2** inserted `if (routes || pages) return;` at the top of
`assertAuditCoverage` — the entire floor removed — and
`npx vitest run scripts/ci/__tests__/admin-aal2-audit.test.ts` reported
**91 passed / 0 failed**, identical to the baseline.

`assertAuditCoverage` is module-private and `main()` runs only behind the
`process.argv[1]` guard, so no test reaches either. The one new test in this
area (`admin-aal2-audit.test.ts:936`, "auditRoutes reports the directories it
could not read") asserts the *sink* — `pass.traversalErrors` is populated — and
stops there. All three fatal conditions the branch advertises (traversal error,
zero routes, zero pages) are assertion-free.

**Arbiter reasoning (verbatim, per the protocol).** The mutation is semantically
meaningful — it deletes the whole control claim 2 asserts, and the branch's own
review entry calls that control the reason a widened audit is trustworthy. But
it sits on a branch (`main()` → `assertAuditCoverage`) that **no candidate test
executes**, so it is a claim about the ORACLE, not a proven-fake test. Per step
5 it is recorded `inconclusive` / `oracle`, not `survived-confirmed-P0`.

Behavioural replacement: export a pure
`auditCoverageFailure(routes, pages): string | null` and pin all three fatal
arms plus the clean case; keep `assertAuditCoverage` as the thin `process.exit`
wrapper.

### F3 — P1 · Duty 3 · `src/lib/auth/__tests__/helpers/admin-gate-mocks.ts:110`

The claim, spelled three times:

- `admin-gate-mocks.ts:110-117` — "Calling the PRODUCTION `isBearerRequest`
  instead means a suite proves bearer mode the only way that counts: by building
  a request that carries the header."
- `admin-gate-mocks.test.ts:115-118` — same argument.
- `.claude/reference/arch-review-log.md:42-44` — "so a 'bearer ok' case cannot
  reproduce the cookie case's 200 without sending the header".

Mutation **A4** replaced the derivation at `admin-gate-mocks.ts:149-151` with a
hardcoded `transport: 'cookie'` (the `isBearerRequest` call deleted). The
overview case *"GET /api/admin/overview — a bearer-transport aal2 admin is
served"* **still passed**. It cannot fail:

- `requireAdminWithAal2` reads only `identity.authUserId` and `identity.aal`
  (`src/lib/auth/admin-mfa-gate.ts:105-108`); it never reads `transport`.
- The string `transport` appears in **none** of the nine folded suites
  (`rg -n transport` over their `__tests__` files returns nothing outside the
  test titles).

What actually protects the case is each suite's own line —
`expect(seen.headers.get('authorization')).toBe('Bearer test-admin-access-token')`
— present in all nine (verified by grep). Mutation **A5** deleted the
`Authorization` header from the overview bearer request and the test went red on
exactly that assertion, so the *conclusion* ("a bearer ok case cannot pass
without the header") holds today. The *mechanism* stated in all three places
does not.

The same A4 mutant was **killed** by `admin-gate-mocks.test.ts`'s "derives
transport from the request through the production predicate" — so the derivation
is covered there, and only there.

Why this matters rather than being pedantry: a later reader who trusts the shim
can delete the nine per-suite header assertions as redundant, and every bearer
case silently becomes a second spelling of the cookie case with nothing going
red. Fix: correct the three comments to credit the per-suite assertion, or make
the shim enforce what it claims.

### F4 — P2 · Duty 5 · `src/components/admin/nav-counts-query.ts:17`

`AdminShellFrame` mounts `AdminSidebar` on every non-auth admin route
(`AdminShellFrame.tsx:25-35`), and `AdminSidebar.tsx:145` unconditionally runs
`navCountsQueryOptions` (`refetchInterval: 60_000`). Two admin pages stay
`plain` after this branch — `/admin/security` (`page.tsx:13`) and
`/admin/runbook` (`page.tsx:194`) — so an `aal1` admin who reaches
`/admin/security` **to enrol** will have that poll answer 403 `mfa_required`
every 60 seconds.

Not P1: `retry: 1` and `useQuery` swallow the throw, the badges simply do not
render, nothing reaches Sentry, and there is a path forward (that page *is* the
enrollment surface). No alert-path row is owed. Recorded because it is the one
caller the fold measurably degrades.

### F5 — P2 · Duty 3 · `docs/runbooks/evidence/2026-09-01-phase-h-beta-launch-evidence.md:157`

Cites `src/app/api/admin/overview/route.ts:14-15` as the `requireRoleOr401`
refusal and quotes the line. At HEAD lines 14-15 are comment text and the
refusal is the gate at :19-20. The doc is a dated record of a production probe,
so rewriting the *finding* would be wrong; a one-line "superseded by #1184" note
is proportionate. Reported at P2 because the file is outside the changed-doc
set.

### F6 — P2 · Duty 2 · `src/lib/auth/__tests__/admin-gate-mocks.test.ts:179`

The pin matches `vi.mock('@/lib/auth/admin-mfa-gate'` and a relative specifier
(lines 179-181), plus `not.toContain('resolveDualModeIdentity: async')` (line
199). `vi.doMock(...)`, a template-literal or constant specifier, and a
hand-rolled resolver spelled `resolveDualModeIdentity: vi.fn(async …)` all evade
it. Mutation **E1** (a real `vi.mock('@/lib/auth/admin-mfa-gate', …)` added to
the overview suite) was **killed**, so the pin does catch the shape it names.
Recorded as a bound, not a defect.

### F7 — P2 · Duty 3 · `src/lib/auth/__tests__/admin-gate-mocks.test.ts:5`

`rg -l makeAdminGateMocks` returns 33 paths: 2 branch plan docs, the helper's
own guard test, and **30** consuming suites — 29 under `src/app/api/admin` plus
`src/lib/admin/__tests__/denorm-queries.test.ts` (surface amendment #2). The
in-repo numbers are right (guard test line 5 says "29 admin route suites"; the
helper header says 22 plus seven more). The "27 suites" in the handed-over
evidence is the inaccurate figure; do not repeat it in the PR body.

---

## What was verified and held

Each of the following is a claim I tried to break and could not.

**Claim 1 — the nine reads reach the real gate, with the full refusal table.**
All nine route files import and call `requireAdminWithAal2` as the first
statement of `GET` (grep over the nine; `businesses` and `businesses/[id]` gate
both verbs). All nine suites carry all five arms and assert
`Cache-Control: no-store, private` on every refusal (verified by counting the
four status literals plus `no-store, private` per file). Mutations:

- **A1** shim `aalFrom` forced to `'aal2'` → aal1 case **killed**.
- **A2** shim 401 arm neutered → 401 case **killed**.
- **A3** shim `loadAppUser` forced to return an admin → Forbidden case **killed**.
- **B1** `nav-counts` rewraps `gate.response`, dropping the no-store headers →
  **killed** by the header assertion (which is exactly what the suite comments
  claim it is for).
- **B2** `if (!gate.ok) return gate.response` deleted from `nav-counts` →
  **killed**.
- **A5** `Authorization` header deleted from the overview bearer request →
  **killed**.

No refusal is a redirect: the gate builds every refusal with
`NextResponse.json` (`admin-mfa-gate.ts:93-96`), so a redirect is structurally
unreachable.

**Claim 2 — the audit widened handlers, not shapes.** The non-comment diff of
`scripts/ci/admin-aal2-audit.ts` shows `MUTATION_VERBS` → `HANDLER_VERBS` (7
verbs), one call-site change, two message rewordings, the `TraversalError` sink
plumbing, and `assertAuditCoverage`. `GATE_FN`, `GATE_JSON_FN`, `GATE_FNS`,
`ADMIN_RESOLVER`, `CANONICAL`, `resolveSpecifier`, `moduleIs` and `importedAs`
are **byte-identical** to the merge base — the credited allowlist genuinely did
not grow. Mutations **C1** (drop `HEAD`) and **C4** (drop `GET`) were both
**killed**. The floor half of the claim is F2.

**Claim 3 — the six page flips are proven twice.** Mutation **D1** removed
`aal2: true` from `src/app/admin/overview/page.tsx:16`. The runtime suite went
red, **and** `npx tsx scripts/ci/admin-aal2-audit.ts` failed with the P2 parity
message naming the page and its sibling route. Both halves catch it.

**Claim 4 — the shim is not a vacuity hole.** Three of four shim mutations were
killed by a route suite; the fourth is F3. Mutation **E1** proved the
anti-vacuity pin refuses a suite that stubs the gate.

**No lost coverage.** `it`/`test` counts compared base→head across every changed
suite: 12 files changed count, all **upward**, none downward. No deleted test.

**Duty 4 — missed siblings (sound search, nothing found).**
Patterns searched: `requireRoleOr401\([^)]*'admin'` and `requireRole\(.*'admin'`
over `src/`, excluding `src/app/api/admin/**` and `__tests__`. One hit —
`src/app/api/zernio/disconnect/route.ts:69`, `requireRole(req, 'owner',
'admin')` — a mixed owner/admin route explicitly outside the admin control plane
per ADR 0025 D1. `npx tsx scripts/ci/admin-aal2-audit.ts` at HEAD: **passed (35
admin route files, 21 admin pages scanned)**, so no admin handler of any verb is
ungated and no page has a weaker gate than its sibling GET. I re-derived the
page/route gate matrix independently using the audit's own exported
`readAdminPageGate` / `routeGetRequiresAal2`: 21 pages, 3 pre-auth (`none`), 2
`plain` with no sibling route (`/admin/runbook`, `/admin/security`), 16 `aal2`,
including two (`/admin/locations/csv-import`, `/admin/suppressions`) that are a
deliberate superset of a `plain` sibling GET. Zero pages missed.

**Duty 5 — alerting (sound search, nothing found).**
`grep` for `nav-counts`, `admin/overview`, `admin/costs`, `admin/jobs`,
`admin/notifications` over `docs/runbooks/beta-launch-alerting.md`: no rule row
names any folded route, and the diff adds no new terminal or swallowed failure
path (the `internal_error` 500 arm is pre-existing gate code, unchanged). The
only operator-visible degradation is F4.

**E2E callers survive.** `e2e/admin-14b-runtime.spec.ts` and
`e2e/admin-14c-runtime.spec.ts` assert the **unauthenticated** 401 arm and the
unauthenticated page→login redirect. The fold preserves both byte-for-byte
(`requireAdminPage` redirects to login before the aal2 branch;
`page-gate.ts:60,69`). No script, poller or runbook step calls a folded endpoint
with an admin credential.

**Duty 3 — citations that re-resolved correctly.** `page-gate.ts:41` (the
`aal2 = false` default) ✓. `page-gate.ts:27-37` (the impersonate exception) ✓.
`.claude/rules/admin-portal.md`'s new sentence — `admin-gate-mocks.test.ts` does
`readFileSync` the nine folded suites by name (`FOLDED_SUITES`, lines 157-171)
and goes red on a missing one ✓. `.claude/rules/channels.md`'s new clause ✓.
`prevalidate-plan.py` was **not** available at
`~/.claude/skills/grill-me-codex/scripts/`, so every citation above was
hand-checked, as the protocol requires me to say.

---

## Inventory

The machine-readable inventory is `findings.json` (101 rows). Shape:

| Outcome | Rows | What they are |
|---|---|---|
| `killed` | 8 | The mutations listed under "What was verified and held" |
| `equivalent` | 1 | A4 against the overview bearer case, with the proof recorded on the row |
| `inconclusive` (`oracle`) | 1 | C2 against `assertAuditCoverage` → F2 |
| `skipped-budget` | 89 | The remaining 40 folded-suite gate arms, 21 migrated suites, 5 page-parity rows + the refused-step-up row, 12 audit fixtures, 10 shim guard cases |
| `excluded` | 2 | The two Playwright specs (protocol excludes E2E from mutation; reviewed by hand instead) |

The 89 skipped rows are the honest cost of a 30-run budget against a diff that
touches 27 suites. Each row records *why* it was safe to leave: in every case
the production line it would mutate is the same shared line already mutated in
the representative candidate, and the per-suite wiring is covered statically by
the anti-vacuity pin (killed, E1) plus the arm-completeness grep.

## Authorizations

None. No finding on this run is `accepted-risk`.

## Restoration

`finalize` did **not** succeed on the first attempt, and the reason is worth
recording for the next run.

I restored between mutations by calling `mutate` again with the pristine file as
the mutant. That is journal-legal but semantically inverted: it appends an entry
whose `originalOid` is the *mutant* and whose `mutantOid` is the *original*. On
`finalize`, `restoreMutations` walks entries in order and faithfully rewound
each one, which re-applied five mutants and then aborted on the next entry
("holds neither the original nor the journaled mutant").

Hand-resolution, per the runner's own instruction:

1. `git checkout -- <five named paths>` — the five files were tracked and their
   correct content is exactly `fa2e6e34`. (No whole-tree pathspec was used.)
2. `git status --porcelain --untracked-files=no` → empty.
3. Marked all 26 journal entries `restored` (truthful: every working blob then
   equalled its HEAD blob), then re-ran `finalize`, which reaped all 26 process
   groups and closed the journal.

`.env.local` was already restored by the first `finalize` (the dotenv half runs
unconditionally and succeeded; the journal's `dotenv` block is closed and the
file is back on disk).

Final state, verified before this file was written:
`git status --porcelain --untracked-files=no` is **empty** — the tree is
unmoved from `fa2e6e34b3dccb34f02ceb8d85ff0f44b78bd522` outside this run's two
report artifacts.

**Note for the runner's owner:** restoring a mutation by re-invoking `mutate`
with the pristine content is a trap. `finalize` is the only safe restore, and a
future run should either finalize between mutations (re-running `dotenv-swap`)
or gain a per-entry `restore` subcommand.


---

## Triage — dispositions applied by the orchestrating root (2026-09-08)
Round 1 findings, adjudicated after the wave. Full cross-axis reasoning, including the two
standards findings rejected with argument, is in `docs/reviews/feat-1184-admin-get-fold/triage.md`.

### F1 · P0 · `.claude/reference/arch-review-log.md:47` → **REJECTED**
REJECTED — the claim is true; every source the finding cites is stale. Verified live rather than from a document: `vercel env ls production` (project rep-worth) shows MFA_ENFORCEMENT_ENABLED on the Production environment, created 2026-09-08, alongside the staging row. #1182's resolution comment (2026-09-08T23:35Z) records the owner running the production half DIRECTLY from a production-scoped shell after PR #1216 merged, with end-to-end proof (password + TOTP sign-in rendering /admin/overview on production). env-vars.md:653, the log's own #1182 entry, and commit cca34475 all predate that. Stated limit: the Production value is stored Encrypted, so the listing proves presence and creation time, not the literal string; the value is attested by the owner's sign-in. The branch's entry at .claude/reference/arch-review-log.md now cites the ticket and the live check instead of leaning on the stale files, and correcting env-vars.md:653 is cut as a follow-up (it is outside this branch's surface).

### F2 · P1 · `scripts/ci/admin-aal2-audit.ts:860` → **FIXED**
FIXED — assertAuditCoverage's process.exit was replaced by the exported pure `auditCoverageFailures(routes, pages): string[]`; main() prints and exits on a non-empty result. Seven tests now assert message CONTENT for all three conditions (traversal error, zero route files, zero pages) plus the healthy case, so the mutation that neutered the floor no longer passes.

### F3 · P1 · `src/lib/auth/__tests__/helpers/admin-gate-mocks.ts:110` → **FIXED**
FIXED, and re-proven by mutation. Each of the nine folded route suites' bearer case now asserts the transport the shim RESOLVED (`mockResolveDualModeIdentity.mock.results[0]`), and each cookie case asserts 'cookie'. Re-running the original mutation (hardcoding transport) after the fix fails 11 tests across 10 files; before the fix it failed none of the nine. The shim's header no longer claims more than it delivers and names the three suites that prove the real seam without it.

### F4 · P2 · `src/components/admin/nav-counts-query.ts:17` → **OPEN**
RECORDED, not fixed here — merged with the spec axis's MEDIUM into follow-up FU-2. The fix belongs in src/app/mfa/challenge/MfaChallengeForm.tsx and src/components/admin/, both outside this branch's already thrice-amended surface. No admin is affected today (production has one admin with verified TOTP; staging's two are enrolled, per #1182); it bites the first newly-minted admin under enforcement (#1178, #1179). P2 is recorded and never blocks.

### F5 · P2 · `docs/runbooks/evidence/2026-09-01-phase-h-beta-launch-evidence.md:157` → **OPEN**
RECORDED, not fixed here — follow-up FU-3. docs/runbooks/evidence/2026-09-01-phase-h-beta-launch-evidence.md is outside this branch's allowed_edit_surface, and a fourth surface amendment for a line-number citation in a dated evidence file is not a trade worth making.

### F6 · P2 · `src/lib/auth/__tests__/admin-gate-mocks.test.ts:179` → **FIXED**
FIXED, partially and honestly. The pin now refuses `vi.doMock` as well as `vi.mock`, for both absolute and relative specifiers, and matches the real import specifier rather than a substring that a suite's own header prose satisfied. The residual limit — a computed specifier, an alias, or an imported setup file still evades a text scan — is now STATED in the comment rather than overclaimed.

### F7 · P2 · `src/lib/auth/__tests__/admin-gate-mocks.test.ts:5` → **FIXED**
FIXED — the stale number is gone from both files. The count is no longer written down at all: the shim's header and the pin's comment now say how to count it (`rg -l admin-gate-mocks src`), because every figure of that kind in this file's short history has already gone stale once.

**Recomputed:** p0_open 0 · p1_open 0 · p2_open 2 (both recorded as follow-ups) · fixed 4 · rejected 1 → status CLEAR.

---
---

# Red team — feat/1184-admin-get-fold, round 2

Everything above this line is round 1's record and the root's triage of it,
preserved verbatim. Round 2 re-derives the pass at the new HEAD: round 1 ran at
`fa2e6e34`, its fixes moved HEAD, so that sidecar was stale by construction
(`red-team-status.mjs` at the start of this round reported "the tree moved since
fa2e6e34b3dc" and "intake_sha256 does not match" — the intake was amended too).
`findings.json` is now round 2's; round 1's seven findings are carried into it
with their dispositions unchanged.

| | |
|---|---|
| mode | `feature` |
| run_id | `feature-feat-1184-admin-get-fold-e01d50` |
| branch | `feat/1184-admin-get-fold` |
| fork_sha | `e8893544204888d6b1639de4f2612cf84517954f` |
| merge_base_sha | `e8893544204888d6b1639de4f2612cf84517954f` |
| head_sha | `083faf8deb9d6959b378ab79c3f10bb4f1298887` |
| intake_sha256 | `2f1740d0f3f53091426337eeb4c25f3e238434f1b7dfc0c76b775a2ab2781030` |
| risk | `high` |
| round | 2 |
| **status** | **`OPEN_P1`** |

**Mutations run 16 (2 baselines + 14 mutants) of a 30-run budget · killed 12 ·
survived 2, both reclassified `equivalent` with proof · 0 inconclusive · 0
skipped-budget.** Inventory rows 36 — 30 `killed`, 2 `equivalent`, 4 `excluded`.

Preconditions all passed before any mutation: `git status --porcelain` empty at
`083faf8d`; `watchers` reported none; `round-start` opened round 2 and reset the
budget (it refuses a third round, so this is the cap). Environment isolated with
`mutation-runner.mjs env --tmp-home` (no local test DB, so
`REPWORTH_DISABLE_LIVE_DB_SUITES=1`; none of the 13 target suites is live-DB) plus
`dotenv-swap`, re-swapped after every intermediate `finalize`. The finalizer ran
before this file was written: 0 mutated files outstanding, dotenv closed,
`git status --porcelain` empty.

## Scope

Round 2 targets the fix hunks and their direct callers only —
`git diff 2ce6196d~2..HEAD -- src scripts`, 24 files. Round 1's F4 and F5 are
recorded follow-ups and were not re-examined. No new front was opened against
code this branch did not change.

## Deviation from the mutation protocol, recorded

Two runs (M9, M10) applied ONE mutation and executed the ELEVEN affected test
files together rather than a single `-t`-filtered test, so `assert-one-test` does
not apply to them. The reason is that the claim under test is inherently
multi-file — "the bearer guarantee is enforced in all nine suites" — and a
per-test loop would have cost 18 runs to measure what one run measures with
strictly more information: the vitest JSON report names every failing test, so
each inventory row's kill is read off the report by full test name against a
baseline where the identical file set was 151/151 green. Every other mutation
(M1–M8, E1, E2) used the single-test protocol and `assert-one-test` confirmed
exactly one executed test each. M11 and M12 are equivalents, judged from a
whole-file run plus a written proof.

## Findings

| # | Severity | file:line | Finding |
|---|---|---|---|
| R2-F1 | **P1** | `scripts/ci/admin-aal2-audit.ts:189` | The corrected anchorless-page paragraph miscounts its own list — "five step up via `requireAdminPage`" is false under either reading (four step up; six call the gate), and its parts sum to 8 over a list of 7 |
| R2-F2 | P2 | `scripts/ci/admin-aal2-audit.ts:195` | The paragraph's own "DERIVE THIS LIST" recipe yields TEN pages, not seven — it omits the pre-auth exemption |
| R2-F3 | P2 | `scripts/ci/admin-aal2-audit.ts:399` | The new type-only exemption is applied to the wildcard path only: `export type { GET } from …` is still reported as an ungated handler (false positive in a fail-closed control) |
| R2-F4 | P2 | `src/lib/auth/__tests__/helpers/admin-gate-mocks.ts:49` | 20 of the 30 shim consumers still paste the identical four-member `@/lib/db/auth` factory the fix retired in ten; the justifying sentence reads as if ten were the population |
| R2-F5 | P2 | `scripts/ci/admin-aal2-audit.ts:770` | The P2 message always names `route.ts` even when the anchor resolved from another extension — deliberate and disclosed, recorded as a residual |
| R2-F6 | P2 | `scripts/ci/admin-aal2-audit.ts:1056` | `main()`'s print-and-exit wiring for the coverage floor has no covering test — the residual of round 1's F2, recorded rather than re-opened |

Round 1's F1–F7 are carried into `findings.json` unchanged: F1 `rejected`,
F2/F3/F6/F7 `fixed` (all four re-verified below), F4/F5 `open` follow-ups.

## Did the fixes close what they claim?

**Claim: handler discovery is now exhaustive — YES for every routable form, with
two false-positive directions recorded.** M2 (`unsupportedWildcardExport` forced
to `null`), M3 (`unsupportedBindingPatterns` forced to `[]`) and M4 (the
unreadable-form block moved BEHIND the handler filter and made zero-handler-only)
are all killed, so both new detectors and the fail-closed ORDERING are genuinely
pinned. Searching for a routable form still invisible, by calling the shipped
`scanRouteFile` directly: `export * from` → finding; `export * as ns from` →
finding; `export const { GET } = …` and `export const [GET] = …` → finding;
`export { GET } from './handlers'` → finding (re-export arm); `export default`
→ clean, and correctly so — Next.js routes named verb exports, never a default.
No routable-and-invisible form was found. In the other direction two false
positives exist and are R2-F3: a type-only NAMED re-export of a verb name is
flagged though it creates no runtime binding (the commit states that exact
principle for `export type * from`, which IS correctly clean), and the namespace
form's message asserts a reachable ungated handler that a module-namespace object
cannot be.

**Claim: file discovery covers every routable extension — YES.** M5
(`ROUTE_FILENAMES` → `route.ts` only), M7 (`PAGE_FILENAMES` → `page.tsx` only),
M8 (`PAGE_FILE_SUFFIX` → `/page.tsx$`) and M6 (`siblingRouteCandidates` → `['ts']`)
are each killed by a named test, so the P2 anchor really does resolve for a
non-`.ts` sibling rather than the extension sweep being decorative.
`siblingRouteFile()`'s message is TRUE at HEAD — `find src/app -path '*__tests__*'
-prune -o \( -name 'route.*' -o -name 'page.*' \) -print` yields only `route.ts`
and `page.tsx` — but it hard-codes `.ts` while the lookup no longer does, so it
can name an absent file the day a `.js` sibling exists (R2-F5). The header's
`pageExtensions` claim is re-resolved TRUE: `next.config.mjs` sets no override
(grep over the repo finds the string only in this audit, its test, and the
triage doc).

**Claim: the anti-vacuity floor is now tested — YES for the decision.** M1
re-runs round 1's neutering mutation against `auditCoverageFailures` and it is
KILLED; the seven new tests assert message CONTENT (the unreadable directory is
named, the two zero-collection strings are matched, the healthy case returns
`[]`, and all three fire together), not lengths. Round 1's inconclusive/oracle
row is resolved. What is still uncovered is `main()`'s five lines of printing and
`process.exit(1)` — R2-F6, recorded not re-opened.

**Claim: the bearer guarantee is enforced in all nine suites — YES, verified
independently.** M9 re-applies round 1's exact mutation (the shim's
`isBearerRequest(...)` ternary replaced by a hardcoded `'cookie'`): 11 tests fail
across 10 files — the nine per-route bearer arms plus the shim's own derivation
and malformed-header tests. Round 1 measured 0 for the nine. M10, the opposite
hardcode (`'bearer'`), fails 10 across 10 files, so the new cookie assertions are
not tautologies. Both numbers are read from the vitest JSON report, not from the
fix's claim.

**Claim: `adminAuthModuleMock` changed no behaviour in ten suites — TRUE, and the
one real difference is proven inert.** The ten pre-fix factories were compared
member by member: nine set `this.name = 'AuthError'`; `denorm-queries.test.ts`
did not (pre-fix lines 63-65), so the collapse GIVES that suite a `name` it
lacked. M12 deletes `this.name` from the shared class and all 171 tests across
the eleven files still pass; production discriminates only with
`err instanceof AuthError` (8 sites, none reading `.name`) and no test asserts on
an error's `name`. The nine suites' `requireRole: (...args) => mockRequireRole(...args)`
wrapper collapsing to a direct reference is safe because every consumer
destructures the mocks from a `vi.hoisted` const and none reassigns them.

**Claim: the `businesses/[id]` GET ordering change cannot alter a response —
PROVEN.** M11 reverts the move (params + `asLocationId` back above the gate): the
suite stays green, and that survivor is `equivalent`, not `inconclusive`, because
the proof is about the MUTANT: `asLocationId` is `return value as LocationId`
(`src/lib/shared/ids.ts:54-56`) — a cast fully erased at runtime with no
validation and no throw path — and `params`' resolved value is not read by the
gate. The one input class where the two orderings could diverge (`await params`
rejecting) is unreachable for a matched route and, if it ever were, the fix's
order is strictly better: the gate's 401/403 instead of an unhandled 500 to an
unauthenticated caller.

**Claim: the pin refuses `vi.doMock` and matches the real specifier — YES.** E1
inserts a genuine `vi.doMock('@/lib/auth/admin-mfa-gate', …)` into the overview
suite and E2 replaces that suite's literal shim specifier with a computed one
while leaving the header prose that satisfied the old substring check. Both are
killed. The residual the comment now STATES (an alias or an imported setup file
still evades a text scan) is real and correctly disclosed.

**Doc claims added by the fix hunks, re-resolved at HEAD.**
`prevalidate-plan.py` was not used — the changed docs here are source comments,
not a plan file — so every citation was hand-checked and that is stated as the
method. True: the `pageExtensions` claim; the `HANDLER_VERBS` un-export rationale
(no importer exists in the tree; `IdentityTransportError` is indeed unexported at
`src/lib/auth/verified-identity.ts:69`); the three seam suites the shim's new
header names all exist; the `CONSUMER_SPECIFIER` rationale (all nine folded
suites do mention the shim by name in a comment, so the old bare-substring check
really was satisfiable by prose); the enumerated seven anchorless pages; the
`route.ts`-is-universal claim; `auditCoverageFailures`' "proven by mutation"
claim. False or imprecise: R2-F1 (the "five" count) and R2-F2 (the derivation
recipe).

## Duty 4 — sibling search, recorded in full

Pattern 1, the collapsed `@/lib/db/auth` factory. Scope `rg -l admin-gate-mocks src`
(30 files), no exclusions; each file's `vi.mock('@/lib/db/auth', …)` call
extracted by paren-matching and its top-level member set compared against
`{requireRole, loadAppUser, cookieBackedServerClient, AuthError}`. Result: 10
collapsed, 20 still verbatim, 0 supersets → R2-F4.

Pattern 2, other admin route suites that stub the real gate. Scope: the
`GATE_STUB`/`RELATIVE_GATE_STUB` regexes applied to all of `src`, not just the
nine. Result: zero matches outside the pin's own file — no suite anywhere stubs
`@/lib/auth/admin-mfa-gate`. A sound search that found nothing.

Pattern 3, routable-but-invisible export forms — the probe described above.
Zero found.

## Duty 5 — operational completeness

Nothing to report, and the search is recorded rather than assumed. The fix hunks
add no new terminal or swallowed failure path: eight of the nine `route.ts`
changes are comment-only (`git diff` shows no executable line), the ninth is a
statement reorder, the audit script's new arms all funnel into the existing
`console.error` + `process.exit(1)` CI failure path, and the shim and its pin are
test-only. No new Sentry signal and no new runbook rule row, so the six-facet
comparison in `docs/runbooks/beta-launch-alerting.md` has nothing to compare.

## Authorizations

None. No finding on this run is `accepted-risk`.

## Restoration

Every mutation was applied through `mutation-runner.mjs mutate` and undone with
`finalize` before the next one (with `dotenv-swap` re-run after each, since
`finalize` closes the dotenv half too) — deliberately NOT by re-invoking `mutate`
with the pristine file, which is the trap round 1 recorded. The journal's 12
entries are all `state: "restored"`, `dotenv.open` is `false`, all 16 process
groups reaped, and `git status --porcelain` is empty — the tree is unmoved from
`083faf8deb9d6959b378ab79c3f10bb4f1298887` outside this run's two report
artifacts.

---

## Round 2 triage — applied by the orchestrating root (2026-09-08)

Round 2's single P1 was a factual miscount in a comment this branch had already
corrected twice. It is **FIXED**, comment-only, with no behavioural surface and no
test to move: the paragraph now states the partition explicitly (4 + 1 + 2 = 7) and
was verified by reading all seven pages rather than by re-counting the prose. The
adjacent P2 about the "DERIVE THIS LIST" recipe yielding ten is corrected in the
same edit — the recipe now says NON-PRE-AUTH page.

The remaining P2s are **recorded, not fixed**, and that is deliberate: round 2 is
the last round the protocol allows, so a behavioural change made after it would
ship unverified. Each is listed here and in the PR description.

- The type-only exemption reaches the wildcard path but not `export type { GET }
  from …`. A FALSE POSITIVE in a fail-closed control — it over-reports, never
  under-reports — and no admin route uses the form. Follow-up.
- The P2 finding message hard-codes `route.ts` while the lookup walks four
  extensions, so it can name an absent file. Disclosed and pinned by a test.
- `main()`'s print-and-exit wiring around `auditCoverageFailures` has no covering
  test; the DECISION it wraps is now pure and fully tested (round 1's F2).
- Twenty of the thirty shim consumers still paste the four-member
  `@/lib/db/auth` factory that `adminAuthModuleMock` retired in ten. Zero
  supersets, so the remaining twenty are a mechanical follow-up.

**Verified by round 2, independently of the implementer's claims:** the
handler-discovery detectors and their fail-closed ordering (M2–M4), every routable
extension (M5–M8), the anti-vacuity decision (M1, resolving round 1's inconclusive
row), the bearer guarantee at 11 failures across 10 files (M9) and 10 across 10 in
the opposite direction (M10), `adminAuthModuleMock`'s one real delta proven inert
(M12), and the `businesses/[id]` ordering proven behaviour-identical (M11).

---

## Owner-authorized re-stamp — GATES PASSED, EDIT BLOCKED (2026-09-08)

This section records a re-stamp that was **verified but NOT applied**. The
`head_sha` in `findings.json` still reads `083faf8d…`; the intended value is
`3b4e3e040b8c28139765b34f0f5853171ba0d2a4`. No evidence in this file was altered.

**Why one was sought.** `red-team-status.mjs` refuses the `reviewed` transition
because the tree moved past `083faf8d`. Round 2 is the cap
(`.agents/skills/red-team/SKILL.md:70` — round-start "refuses a third round
outright"), and the checker's `authorizations` array gates only `accepted-risk`
findings (`red-team-status.mjs:352-356`), never staleness. Re-stamping is the only
mechanism, and the owner authorized it:

> owner 2026-09-08: sidecar accepted as current for 3b4e3e04; delta is
> comment-only (git diff 083faf8d..3b4e3e04 -- scripts/ci/admin-aal2-audit.ts),
> no third round

**A discrepancy the reader must be able to see and disagree with.** That
parenthetical names ONE file. The actual delta `083faf8d..3b4e3e04` carries FOUR
paths: `scripts/ci/admin-aal2-audit.ts`, this file, `findings.json`, and a second
non-report file — `docs/superpowers/plans/feat-1184-admin-get-fold-handoff.md`,
documentation with no executable content. A fresh gating agent REFUSED the
re-stamp on exactly that basis. The orchestrator then widened the gate to admit
`docs/superpowers/plans/**`, on the ground that the owner named `3b4e3e04` by SHA
and that commit is the one carrying the handoff change. The widening is the
orchestrator's call, recorded here rather than absorbed into a summary.

**Gate results, run by a fresh agent that did not implement the branch.**

| gate | result |
|---|---|
| 1 · delta contains only the audit file, the two reports, and `docs/superpowers/plans/**` | PASS — four paths, all in class |
| 2 · the audit delta is COMMENT-ONLY, no executable line changed | PASS — proven three ways |
| 3 · `pnpm vitest run scripts/ci/__tests__/admin-aal2-audit.test.ts` · `pnpm ci:admin-aal2` · `pnpm typecheck` | PASS — 112/112; 35 route files + 21 pages; clean |
| 4 · no unrestored mutation (`git status --porcelain -uno`) | PASS — empty |

**Gate 2's method, because a proof is only as good as its controls.** Both
versions were extracted with `git show` and compared under the repo's vendored
TypeScript three ways: (A) a `ts.createScanner(skipTrivia: true)` token stream,
(B) a `ts.createPrinter({ removeComments: true })` AST re-print, (C)
`ts.transpileModule({ removeComments: true })`. All three were byte-identical
across the two versions while the raw sources differed. The agent's FIRST positive
control was vacuous — its perturbation string did not occur in the file, so it
compared the file to itself and reported a meaningless pass. It caught that itself
and re-ran three verified-applied perturbations: A and B are sensitive to value,
identifier and type-only changes; C is blind to type-only ones, which A and B
cover. The proof stands because the controls bite.

**Why it was not applied.** Editing `head_sha` was refused by the session's
permission classifier, through both a file edit and a script — correctly, since
rewriting the recorded SHA of red-team evidence is precisely what such a guard
exists to stop. Neither the agent nor the orchestrator routed around it.

**What the re-stamp would and would not mean.** The mutation evidence was gathered
at `083faf8d` and still describes this tree, because the executable content
between the two commits is identical — proven above. It is NOT a fresh pass over
the newer commit, and this section exists so that nobody later reads it as one.

---

# Red team — feat/1184-admin-get-fold, round 3

**Mode** feature · **risk** high · **round** 3 · **branch** `feat/1184-admin-get-fold`
**fork / merge-base** `e8893544204888d6b1639de4f2612cf84517954f`
**head** `8d7348086dfc020349f432d7743e5c0e805c158c`
**intake sha256** `2f1740d0f3f53091426337eeb4c25f3e238434f1b7dfc0c76b775a2ab2781030`
**generated** 2026-09-08

## Why a third round exists, and what it supersedes

This round runs under EXPLICIT OWNER AUTHORIZATION. The owner removed
`.feature/red-team-journal.json` themselves on 2026-09-08 and authorized a third
pass at the then-current HEAD; the journal's absence was verified before
`round-start` was called, and no journal was reset or deleted by this pass. The
protocol's two-round cap is otherwise intact — there is no round 4.

It **supersedes the "Owner-authorized re-stamp — GATES PASSED, EDIT BLOCKED"
section above**. That section recorded a `head_sha` that could not be corrected
because editing a SHA in a sidecar is not the same act as producing evidence at
that SHA. The `head_sha` stamped by this round is
`8d7348086dfc020349f432d7743e5c0e805c158c` because the round **actually ran at
that HEAD** — 22 mutation runs, all baselines re-derived, the finalizer run and
the tree verified clean — not because a value was edited. Rounds 1 and 2 ran at
earlier SHAs and their reports above are preserved verbatim.

**Dispositions carried forward, unchanged:** F1 `rejected`; F2, F3, F6, F7
`fixed`; F4, F5 `open` (recorded follow-ups FU-2 / FU-3); R2-F1 `fixed`;
R2-F2 … R2-F6 `open` residuals. None was re-litigated. Round 1's F4/F5 and round
2's residuals were treated as out of scope per the brief.

## Scope

The FULL changed surface, `git diff e8893544..8d734808` — 63 files. Out of scope
by the brief: `src/proxy.ts`, CSRF, CORS, impersonation behaviour, a fourth gate
shape, `ci:admin-contract`, migrations, flags, dependencies, ADRs 0024–0031, and
the declared/owner-accepted aal1 refusal and `internal_error` 500. Round 2's
already-verified areas (M1–M12 and the 18 bearer/cookie rows) were not
re-litigated.

## An operational blocker the orchestrator must handle first

`red-team-status.mjs:272` hard-rejects `round` values other than 1 or 2
(`round must be 1 or 2 (hard cap)`). This sidecar stamps `round: 3` because the
brief requires it and because it is the truth about this pass. The checker will
therefore FAIL on the schema, before it ever recomputes counts. That is a
property of the enforcement script, not of this branch; the owner authorized a
third round and the checker has no vocabulary for one. Recorded here rather than
worked around — no field was falsified to make a gate pass.

## Findings

### R3-F1 — **P0** — `src/app/admin/__tests__/page-aal2-parity.test.tsx:166`

**A dropped `await` on the page gate survives on five of the six flipped pages,
and the suite's own header claims it does not.**

The file's header states: *"It also pins the ORDER: the gate must be awaited
before any data read, because these pages query `sql` directly and a read that
starts first is a read an un-stepped-up caller triggered."* That is false for
five of the six pages. What line 166 pins is the order of **calls**
(`callOrder[0] === 'gate'`), which an un-awaited gate satisfies: the mock's body
runs synchronously to its first `await`, so `'gate'` is still pushed first while
the returned promise is discarded.

Measured, not argued (R3-M10 / R3-M11):

- `src/app/admin/costs/page.tsx`, `await requireAdminPage(...)` →
  `requireAdminPage(...)` (the plain floating-promise form) and, separately,
  `void requireAdminPage(...)`.
- `'/admin/costs' steps up to aal2 before reading anything` — **PASSES** under
  both. Baseline green, exactly one test executed in each run.
- `pnpm ci:admin-aal2` — **passes** (35 admin route files, 21 admin pages).
  `readAdminPageGate` requires a CallExpression; awaiting is not part of the
  shape it reads.
- `npx eslint src/app/admin/costs/page.tsx` — **clean**.
  `@typescript-eslint/no-floating-promises` is not configured in
  `eslint.config.mjs`.
- `npx tsc --noEmit` — **clean** for that file.

So no gate in the repository detects it.

**Arbiter confirmation (required by the protocol).** The mutation is
semantically meaningful for the tested behaviour and is not equivalent:
`requireAdminPage` refuses by calling `redirect()`, which signals by throwing.
Awaited, the throw stops the page. Un-awaited, the throw lands in a discarded
promise, the page continues into `getCostReport(sql, …)` / `getMarginReport(sql, …)`
and renders cross-account spend and margin to a caller the gate refused — which
is exactly the parallel read path audit rule P2 exists to close. The mutated line
is on the path the test executes (the test calls the page's default export
directly), so this is not an unexecuted branch. It is a claim about the ORACLE,
not about the mutant.

**The asymmetry is structural, and one control mutation proves it.** The suite
DOES carry a refusal-propagation test — `a refused step-up stops the page before
any data read` (line 169) — but it imports only `../overview/page` (line 177).
R3-M12 applied the identical dropped-`await` mutation to
`src/app/admin/overview/page.tsx` and that test **KILLED** it. `/admin/overview`
is covered; `/admin/businesses`, `/admin/businesses/[id]`, `/admin/costs`,
`/admin/jobs` and `/admin/notifications` are not.

**Fix shape (one line):** make the refusal test `it.each(PAGES)` the way the
step-up test already is, so every flipped page proves the gate is awaited, not
merely called. This is the only new-in-this-branch oracle for the six flips —
`ci:admin-aal2` reads source and cannot see an await, which is the reason the
suite was written.

Disposition: **open**.

### R3-F2 — **P1** — `scripts/ci/admin-aal2-audit.ts:124`

**The security control's own census, in the paragraph that derives rule P2, is
false at HEAD — and this branch is what made it further false.**

The line reads: *"`requireAdminPage`'s `aal2` parameter (src/lib/auth/page-gate.ts:41)
DEFAULTS TO FALSE and 8 of 16 gated admin pages opt in."*

Re-resolved at HEAD by walking the tree:

- 21 `page.tsx` files under `src/app/admin` (matches the audit's own
  "21 admin pages scanned").
- 17 call `requireAdminPage`; **15** of those pass `aal2: true`.
- Adding `impersonate/[sessionId]/view`, which steps up through
  `requireCurrentAal2FromSupabase`, gives **16 of 18** gated pages opting into a
  step-up.

Under no reading is it 8 of 16. At the merge-base it was 9 of 17 — already off by
one — and this branch's six flips moved the numerator from 9 to 15 without
touching the sentence.

Why this is P1 and not cosmetic: the sentence is the empirical premise for the
whole P2 rule three lines below (*"The rule below is DERIVED from what the tree
actually does, not imposed"*), and the branch **explicitly audited its neighbours
for exactly this failure** — it rewrote the `/admin/businesses/[id]` worked
example because #1184 falsified it, and wrote *"A security audit that teaches its
rule with a citation that is no longer true is worse than one that teaches it with
none."* A sibling sentence in the same header, falsified by the same change, was
missed. `page-gate.ts:41` itself re-resolves TRUE (`{ from, aal2 = false }`), as
does `page-gate.ts:27-37`.

Disposition: **open**. High-risk run — the checker requires user adjudication.

### R3-F3 — **P2** — `src/lib/auth/__tests__/admin-gate-mocks.test.ts:161`

**Both of the branch's completeness pins are hand-maintained lists with no
derivation, so neither notices a tenth member.**

`FOLDED_SUITES` (nine suite paths, `admin-gate-mocks.test.ts:161`) and `PAGES`
(six page entries, `page-aal2-parity.test.tsx:102`) are literals. Nothing walks
`src/app/api/admin` for handlers that call `requireAdminWithAal2`, and nothing
walks `src/app/admin` for pages that pass `aal2: true`. A tenth folded GET, or a
seventh page flipped under P2, ships with no anti-vacuity pin and no runtime
parity proof, and every gate stays green. This is the enumerated-scope guard
class this repository has already named for itself
(`.claude/reference/arch-review-log.md`, the 2026-08-26 pass, "Class S").

Consequence today is bounded: `ci:admin-aal2` still binds every handler and every
page, so the *gate* half cannot regress silently. What the lists own is the
*evidence* half — that the gate is real rather than stubbed, and that the page's
`from` and `aal2` are what the route requires. R3-M3 is the proof this matters:
mutating `from` on `/admin/businesses/[id]` was killed ONLY by the parity suite;
`ci:admin-aal2` passed. A page absent from `PAGES` has no such detector.

Recorded; P2 never blocks. Disposition: **open**.

### R3-F4 — **P2** — `src/app/api/zernio/disconnect/route.ts:69`

**Duty-4 sibling: an admin-capable handler outside the widened contract's path
scope.**

`scanRouteFile` is path-scoped — `if (!normalized.includes('src/app/api/admin/')) return [];`
(`admin-aal2-audit.ts:622`). `src/app/api/zernio/disconnect/route.ts:69` calls
`requireRole(req, 'owner', 'admin')`, so an admin acts there at plain role with no
AAL2 step-up and the ROUTES contract cannot see it by construction. That qualifies
the arch-review-log's phrasing that the widening makes *"every Admin API handler
calls a gate this audit has vetted"* a CI-enforced fact: it is a fact about
`src/app/api/admin/**`, which is the correct scope for this ticket and for
ADR 0025, but is not the same as every handler an admin can reach.

Pre-existing and unchanged by this branch; recorded as the Duty-4 result rather
than raised as a new front. Any change belongs to its own ticket.
Disposition: **open**.

## Duty 4 — sibling search, recorded in full

**Pattern searched:** admin-role gates that are not the MFA gate.
**Commands:** `rg -n "requireRoleOr401\(" src worker` and `rg -n "requireRole\("
src worker`, both excluding `**/__tests__/**` and `**/*.test.*`.
**Scope:** all of `src/` and `worker/` production code.
**Exclusions:** test files; `src/lib/auth/route-helpers.ts` and
`src/lib/db/auth.ts` (the definitions themselves); doc comments naming the old
gate.

**Result:** ZERO remaining `requireRoleOr401(_, 'admin')` or
`requireRole(_, 'admin')` call sites under `src/app/api/admin/`. The fold is
complete for its stated scope. Every other live call site binds `'owner'`, with
the single exception recorded as R3-F4.

**Second pattern:** the shim's own consumers. `rg -l
"'@/lib/auth/__tests__/helpers/admin-gate-mocks'" src` → 32 files, of which 30 are
consumers (the other two are the helper and its own test). At the merge-base,
`git grep -l "resolveDualModeIdentity: async"` → 22 files, and at HEAD the only
remaining occurrence of that string is the assertion inside
`admin-gate-mocks.test.ts:226` that forbids it. 22 migrated + 7 new folded read
suites + `denorm-queries.test.ts` (amendment #2) = 30, so the arch-review-log's
*"Twenty-two admin suites … this ticket would have added seven more"* re-resolves
**TRUE** at HEAD. No new finding.

## Duty 3 — docs vs reality, re-resolved at HEAD

`prevalidate-plan.py` was present and was run over every changed doc.

| Doc | Result |
|---|---|
| `.claude/reference/arch-review-log.md` | 64 citations / 2 unresolved, 9 commits / 2 stale — **all four are in entries dated 2026-09-07 and earlier (lines 240, 993, 1859, 1864, 1870), outside this branch's new block (lines 3–65)**. Pre-existing; not raised. |
| `.claude/rules/admin-portal.md` | PASS |
| `.claude/rules/channels.md` | PASS |
| `docs/superpowers/plans/…-plan.md` | PASS |
| `docs/superpowers/plans/…-handoff.md` | PASS |
| `docs/superpowers/plans/…-deviations.md` | PASS |

Hand-checked claims beyond the citation scan:

- **`admin-portal.md` (a)** — *"`admin-gate-mocks.test.ts` `readFileSync`s the
  nine folded read suites by name (#1184) and goes red on a missing one"* → TRUE
  (`FOLDED_SUITES` + `readSuite`, `admin-gate-mocks.test.ts:161,192`). The older
  half — *"`admin-aal2-audit.test.ts` … pass a path STRING plus synthetic text
  and stay green"* → still TRUE; the new composed-pass tests build temp fixture
  trees and the file contains no `readFileSync`, no `readFile(` and no
  `process.cwd()`.
- **`channels.md` (c)** — the widened-contract sentence → TRUE.
- **arch-review-log, new block** — *"Nine route files, six page files, one audit,
  one new test-only helper"* → TRUE against the diffstat. *"`HANDLER_VERBS` binds
  `HEAD` and `OPTIONS` although no admin route exports either"* → TRUE
  (`rg "export (async )?(function|const) (HEAD|OPTIONS)" src/app/api/admin` → 0).
  *"the other 34 scanned green"* → consistent with 35 collected route files.
- **audit header, the SEVEN anchorless pages and their 4 + 1 + 2 partition** →
  re-derived programmatically at HEAD. Ten admin pages have no sibling route in
  any routable spelling; three are pre-auth (`/admin/{login,forgot-password,reset-password}`);
  the remaining seven are exactly the ones listed, and they partition
  4 (`autonomy`, `impersonate`, `businesses/new`, `solicitation`) + 1
  (`impersonate/[sessionId]/view`) + 2 (`security`, `runbook`). **R2-F1's fix
  holds and R2-F2's residual is reconfirmed** — the capitalised recipe still
  yields ten.
- **`page-gate.ts:41` and `page-gate.ts:27-37`** → both re-resolve correctly.
- **`8 of 16`** → FALSE. Raised as R3-F2.

## Duty 2 — fragile assertions

Scanned all 34 changed test files for absence-of-tag proxies
(`not.toContain('<…')`), exact string counts on rendered output, inline
snapshots, and order assertions with no ordering contract. **None found.** The
`expect(response.status).toBe(4xx)` assertions are behavioural, not incidental
structure. The one shape that is weaker than its stated claim —
`expect(callOrder[0]).toBe('gate')` — is not a separate finding; it is the
substance of R3-F1.

## Duty 5 — operational completeness

The diff adds no runtime alert path. Every added `catch` / `console.error` is in
`scripts/ci/admin-aal2-audit.ts` (CI-time fatal exits, not operator alerting) or
in test files. No new terminal or swallowed runtime failure path, therefore no
rule row is owed in `docs/runbooks/beta-launch-alerting.md`. The one operational
consequence of the fold — the sidebar's 60-second nav-counts poll now 403ing on
the pages that stay plain — is already recorded as F4 (round 1, P2, open) and was
not re-raised.

## Restoration

`watchers` reported none before the round. `dotenv-swap` swapped one file
(`.env.local`); `finalize` reaped 22 journaled process groups (all empty),
restored 0 mutated files — every mutation had already been restored to its
original blob between measurements — and restored 1 dotenv file, closing the
journal. `git status --porcelain` was empty on every path before the first byte
of this section was written; the only paths this round touches are its own two
report artifacts.

## Inventory

| id | file | candidate | mutation | outcome |
|---|---|---|---|---|
| INV-R3-M1 | `src/app/admin/__tests__/page-aal2-parity.test.tsx` | `'/admin/overview' steps up to aal2 before reading anything` | overview page: `{ from, aal2: true }` → `{ from }` | killed |
| INV-R3-M2 | `scripts/ci/admin-aal2-audit.ts` | `ci:admin-aal2` rule P2, dynamic-sibling anchor | `businesses/[id]` page: `aal2: true` dropped | killed |
| INV-R3-M3 | `src/app/admin/__tests__/page-aal2-parity.test.tsx` | `'/admin/businesses/[id]' steps up to aal2 before reading anything` | `from: '/admin/businesses'` → `'/admin/businesses/[id]'` | killed |
| INV-R3-M4 | `src/app/api/admin/costs/__tests__/route.test.ts` | `an aal1 admin is refused 403 mfa_required` | costs route: `if (!gate.ok) return gate.response;` → `void gate;` | killed |
| INV-R3-M5 | `scripts/ci/__tests__/admin-aal2-audit.test.ts` | `every verb Next.js routes is bound, and each is reported by name` | `HANDLER_VERBS`: `'GET'` removed | killed |
| INV-R3-M6 | `src/app/api/admin/businesses/[id]/channels/__tests__/route.test.ts` | `an aal1 admin is refused 403 mfa_required` | channels route: gate moved BELOW the enrollment read | killed |
| INV-R3-M7 | `src/lib/auth/__tests__/admin-gate-mocks.test.ts` | `maps the three AAL answers apart — aal2, unreadable, and everything else` | shim `aalFrom`: the `mfa_check_failed → null` arm deleted | killed |
| INV-R3-M8 | `src/app/api/admin/nav-counts/__tests__/route.test.ts` | `a non-admin is refused 403 Forbidden` | shim `mockLoadAppUser`: always resolves an admin | killed |
| INV-R3-M9 | `src/app/api/admin/costs/__tests__/route.test.ts` | `a bearer-transport aal2 admin is served` | costs route: `requireAdminWithAal2(new NextRequest(request.nextUrl))` | killed |
| INV-R3-M10 | `src/app/admin/__tests__/page-aal2-parity.test.tsx` | `'/admin/costs' steps up to aal2 before reading anything` | costs page: `void requireAdminPage(...)` | survived-confirmed-P0 → R3-F1 |
| INV-R3-M11 | `src/app/admin/__tests__/page-aal2-parity.test.tsx` | `'/admin/costs' steps up to aal2 before reading anything` | costs page: `await` dropped (plain floating promise) | survived-confirmed-P0 → R3-F1 |
| INV-R3-M12 | `src/app/admin/__tests__/page-aal2-parity.test.tsx` | `a refused step-up stops the page before any data read` | overview page: `await` dropped | killed |
| INV-R3-E1 | `src/app/api/admin/{overview,jobs,notifications,demos}/route.ts`, `businesses/route.ts`, `businesses/[id]/route.ts` | the five folded handlers not individually mutated | — | excluded |
| INV-R3-E2 | `scripts/ci/admin-aal2-audit.ts` | handler-form detectors, multi-extension discovery, coverage floor | — | excluded |
| INV-R3-E3 | the nine folded route suites | bearer / cookie transport, 18 rows | — | excluded |
| INV-R3-E4 | `src/app/api/admin/businesses/[id]/route.ts` | gate-first ordering | — | excluded |
| INV-R3-E5 | `src/lib/auth/__tests__/helpers/admin-gate-mocks.ts` | `adminAuthModuleMock` inertness | — | excluded |
| INV-R3-E6 | `scripts/ci/admin-aal2-audit.ts` | `main()` print-and-exit wiring | — | excluded |
| INV-R3-E7 | `docs/**`, `.claude/**` | the branch's 11 changed Markdown files | — | excluded |

Exclusion reasons are recorded in full in `findings.json`; the short form is that
E2–E6 were executed and killed in round 2 and the brief forbids re-litigating
them, E7 is Duty-3 territory rather than mutation territory, and E1 is the one
judgement call — five handler bodies whose executable lines are byte-identical to
the three that WERE mutated, each carrying a byte-identical five-test gate block,
with round 2's per-suite bearer/cookie rows covering all nine by name. The root
can override that call; it is stated rather than hidden.

## Authorizations

None. No finding on this branch is dispositioned `accepted-risk`.

---

## Round 3 triage — the root's note, and TWO blockers for the owner (2026-09-08)

Round 3 ran at `8d734808` under owner authorization, with the journal reset **by
the owner**. Its `head_sha` is current because the round actually RAN at this
HEAD — not because a SHA was edited. The blocked re-stamp recorded above is
superseded, and left in place as history.

**R3-F1 (P0) is real, it is mine, and it is NOT fixed.** The runtime parity suite
I added, `src/app/admin/__tests__/page-aal2-parity.test.tsx`, pins the ORDER in
which `requireAdminPage` and the data reads are CALLED — not that the gate was
`await`ed. The mechanism: the mock is
`vi.fn(async () => { callOrder.push('gate'); … })`, whose body runs synchronously
up to its first `await`, of which it has none. So `callOrder.push('gate')` fires
the instant the page CALLS the gate, and a page that dropped its `await` still
records `'gate'` first. Five of the six pages survive that mutation; only
`/admin/overview` dies, because the separate refusal test imports that page and
expects a rejection. `ci:admin-aal2`, ESLint and `tsc` are all clean under a
dropped `await` — which is precisely why this suite was added, so it fails at its
own stated purpose.

It matters beyond the test: a page whose gate is not awaited reads `sql` before
the step-up resolves, which is exactly the parallel read path P2 exists to close.

The fix is one line and I have NOT applied it, because the brief says a new P0
goes to the owner: make the gate mock yield before it records —
`await new Promise((r) => setTimeout(r, 0));` immediately before
`callOrder.push('gate')`. A dropped `await` then lets a service record first,
`callOrder[0]` is `'read'`, and all six pages fail. No production change, no new
file.

**Blocker two is decisive, and is about the tooling rather than this branch.**
`red-team-status.mjs:272` reads
`if (sidecar.round !== 1 && sidecar.round !== 2) errors.push('round must be 1 or 2 (hard cap)')`.
A round-3 sidecar can therefore NEVER satisfy the checker, whatever it contains.
Running the round the owner authorized produced honest, current evidence that the
checker is structurally unable to accept. Its verdict right now names ONLY that
cap — the staleness complaint is gone, so the round did fix what it was
authorized to fix.

Nothing was falsified to reach a green gate: `round` is 3 because it was the
third round, and `status` was `OPEN_P0` for as long as a P0 was open.

### Resolution (2026-09-08, after the owner ruled)

**R3-F1 → FIXED at `4a588cdd`, and the first attempt at the fix was itself
vacuous.** Adding the yield to the hoisted implementation left `beforeEach`
reinstalling the synchronous body before every test, and re-running the sweep
still showed five survivors. The body now has ONE owner (`gateImplementation`)
that both sites use. Re-measured by the ROOT — evidence gathered outside a
red-team round, and labelled as such rather than presented as a mutation-runner
result — dropping `await` on each page in turn and restoring after each:

| page | result |
|---|---|
| `/admin/overview` | 2 failed |
| `/admin/businesses` | 1 failed |
| `/admin/businesses/[id]` | 1 failed |
| `/admin/costs` | 1 failed |
| `/admin/jobs` | 1 failed |
| `/admin/notifications` | 1 failed |

Dead on all six, where round 3 measured five survivors. The finding's suggested
fix shape — make the refusal test `it.each` — was deliberately NOT taken:
repairing the mock kills the mutation through the step-up test itself, whereas a
second test would have inherited the same synchronous-recording flaw.

**R3-F2 → FIXED at `4a588cdd`**, restated from a live recount (18 non-pre-auth
pages; 17 via `requireAdminPage`; 15 of those `aal2: true`), the stale
`page-gate.ts:41` citation dropped, and an instruction to recount from the tree
rather than adjust by arithmetic. R3-F3 and R3-F4 stay recorded P2 residuals.

**The round cap moved, and that is a tooling change this branch owns.** The owner
authorized raising it to 3 as surface amendment #4. `round-start` and
`red-team-status` now both admit a third round ONLY when the sidecar already
carries an authorization naming it; a fourth is refused outright. Pinned in both
directions in `scripts/ci/__tests__/red-team-{status,mutation-runner}.test.ts`:
unauthorized 3 refused, authorized 3 opens, 4 refused, and a wrong-branch or
unparseable sidecar fails closed.

**Two schema repairs made while applying the above, both disclosed.** The round-3
sidecar carried its arbiter reasoning for R3-F1 inside `reason` rather than the
`arbiter_reasoning` field the schema requires, so the checker could not see it —
it now lives in that field, wording unchanged. And `intake_sha256` was re-stamped
for amendment #4's intake. Neither changes a finding, an outcome, or a count.

### Re-stamp to `9a150e51`, under the owner's standing instruction

Applying the fixes moved HEAD past `4a588cdd`, and the checker objected on
staleness and on the amended intake. The owner's standing instruction for exactly
this case was: do NOT open round 4 — re-run the surviving mutations directly at
HEAD, record them dead as ROOT evidence marked as such, and report the checker's
output if it still refuses.

**The delta being re-stamped over**, `git diff 4a588cdd..9a150e51`, three
non-report files, none of them production code and none reachable by the six
pages or the audit's executable paths:

| file | what changed |
|---|---|
| `scripts/ci/__tests__/red-team-status.test.ts` | a `finding_ids` callback annotation, TS2345 under `next build`'s stricter check |
| `.claude/skills/red-team/SKILL.md` | the canonical mirror of the cap paragraph, which `ci:agent-config` requires to be byte-identical |
| `docs/superpowers/plans/…-intake.json` | that mirror added to `allowed_edit_surface`, which is what moved `intake_sha256` |

**Re-run at `9a150e51`** (root evidence, gathered outside a red-team round):
the dropped-`await` mutation applied to each of the six pages in turn, restoring
after each — `/admin/overview` 2 failed, and `/admin/{businesses,businesses/[id],
costs,jobs,notifications}` 1 failed each. Dead on all six, unchanged from
`4a588cdd`. `git status --porcelain` empty afterwards.

The mutation evidence in the inventory above was gathered by the round-3 agent at
`8d734808`; this re-stamp does not claim otherwise. What it claims is narrower and
checkable: the executable surface those mutations exercised is unchanged between
`8d734808`, `4a588cdd` and `9a150e51` except for the R3-F1/R3-F2 fixes, whose
effect was re-measured directly and is recorded above.

### Second re-stamp, to `4624f469` — and this one DID move executable code

`ci:fallow`'s coverage-informed gate — the one CI job outside the local verify
gate — failed the PR on a finding this branch created: `main()` in
`scripts/ci/admin-aal2-audit.ts` at CRAP 56.0, 0% tested, after #1184 gave it a
third failure mode. Red team had already recorded the same gap from the other
direction as **R2-F6**: "`main()`'s print-and-exit wiring has no covering test."

Unlike the previous re-stamp, this delta is NOT comment-only. The reporting
decision moved out of `main()` into `buildAuditReport()` and
`preAuthDerivationFailure()`, both now exercised directly, leaving `main()` with
I/O and a single ternary. So it was re-verified by mutation rather than asserted:

- **Coverage-floor mutant, re-run by the ROOT at `4624f469`** — root evidence,
  gathered outside a red-team round and labelled as such. `auditCoverageFailures`
  short-circuited to always return `[]`, the same neutering round 1's C2 and
  round 3's M1 applied: **6 of 117 tests fail.** Restored byte-for-byte
  afterwards; `git status --porcelain` empty.
- `pnpm ci:admin-aal2` passes identically (35 route files, 21 pages), and the
  audit suite is 117 green, up from 112. The five added cases cover the extracted
  decision — including the precedence a reader depends on (a coverage failure
  OUTRANKS findings) and the pre-auth derivation fatal, neither of which any test
  could reach while they lived inside `main()`.

The refactor therefore CLOSED R2-F6 rather than relocating it, and the property
round 3 measured — that neutering the floor gets caught — is measurably stronger
at `4624f469` than at `8d734808`, where the identical mutation was caught by
nothing at all.
