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
