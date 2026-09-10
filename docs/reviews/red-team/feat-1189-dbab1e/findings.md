# #1189 — adversarial verification, round 1

**Status: CLEAR.** All 16 in-scope individual cases had a green baseline and killed one semantic production mutation. The complete inventory contains those 16 cases and one explicitly excluded Playwright case. There are no findings, confirmed survivors, equivalent mutants, inconclusive cases, or budget skips.

This is the fresh verifier's evidence for the pinned change. It is not browser or staging acceptance, a new full-gate run, or permission to merge.

## Provenance and restoration

- Role: fresh adversarial VERIFIER, `/root/feature_1189/red_team`; no implementation or other reviewer conclusions used as evidence.
- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1189`.
- Branch: `feat/1189`; mode: `feature`; round: **1**, retained across the precondition pause without reopening or resetting.
- Fork and independently resolved merge-base: `c951bc2ebbafba310cc35f11f6e06fc5d8b57414`.
- Reviewed HEAD: `bf84c855b947f0cd4c8587b880968cacb7b7caa9`.
- Locked intake SHA-256: `731b6032694768465173872dd79a5d9ab70593dcf8c84585c225cdc725f77d81`.
- Generated: `2026-09-10T11:30:21.940Z`.
- Detail route original blob: `285ebf6ba623865cc7d0c2d5c3aa9f29c3160a42`.
- Options route original blob: `c258d7c5a355c0611d0c6d9ac777800241c577bc`.

The verifier reversed each exact production mutation with `apply_patch`, checked `git diff --exit-code` before continuing, and independently compared both final file blob OIDs to the pinned HEAD. The journal recorded each original blob before mutation. All 32 supervised process groups were inactive after their runs.

**Before any report byte was written**, the verifier notified the invoking lead that measurements were complete. The lead ran the ORIGINAL canonical finalizer itself, confirmed 16 mutation entries restored, one dotenv file restored, a closed journal, and clean tracked files; then restored the two authorized preview commands. The verifier subsequently re-read canonical journal status and independently asserted round 1, 32 launches, all mutation states restored, no active supervisors, no open dotenv swap, and an empty `git status --porcelain`. These two findings files were created only after the lead's explicit finalizer-complete message.

## Claimed evidence independently checked

The stored full-gate metadata is GREEN with 32 PASS checks. The verifier recomputed the fingerprint digest and checked its intake, gate-status, and lockfile hashes against the actual files. The checked fingerprint is:

`3077f6f99e99770211e013c4a52060cdc39c7025c0534efebff1c3373bb473c1`

Retained raw logs were read directly, rather than inferring totals from a green status:

| Evidence | Independently observed result |
| --- | --- |
| `.feature/logs/test.log:134` and `:135` | 1,067 test files passed; 99 skipped. 14,665 tests passed; 1,184 skipped. |
| `.feature/logs/test.rc` | Exit 0. |
| `.feature/logs/extra-pnpm-exec-vitest-run-src-app-api-admin-b-9bfa40.log:10` and `:11` | Nine files and 113 tests passed. |
| Corresponding focused `.rc` file | Exit 0. |
| This pass's raw JSON results | 16 baselines passed; 16 mutants assertion-failed; exactly one executed case per launch; zero runtime-error suites. |

The full suite and focused suite above were not relaunched during mutation measurement. Their skip total is visible in the retained log; this pass does not independently certify every skipped suite's environmental prerequisite. A successful standalone build was supplied as claimed evidence by the lead, but no retained build log was found under `.feature`; that build claim is not presented as independently rederived here.

## Operational authorization and execution limits

The operational approval is recorded in `docs/reviews/feat-1189/inventory-and-budget.md`: the owner replied **“I approve”** to the explicit proposal for **at most 40 TOTAL supervised launches for #1189 round 1**, including baselines, mutants, collection, and retries. The invoking lead relayed that authentic authorization. The verifier did not treat repository prose alone as permission.

The approved temporary runner was independently hash-checked and compared with the original:

| Runner | SHA-256 | Use |
| --- | --- | --- |
| `.agents/skills/red-team/scripts/mutation-runner.mjs` | `159fc7b5f2b8b3e93308ae1ecb5c64f5e08c94d148ff8d20b77b4ed1e70347f5` | Canonical environment, lifecycle, watcher, escaping, mutation, assertion, journal, and finalization commands. |
| `/private/tmp/1189-mutation-runner.mjs` | `de66427e45985e0b987b7e85c55817a45db7ca0573bc4d87947917fc9cb62d6f` | Supervised `run` only. |

The sole diff is `MAX_RUNS_PER_ROUND = 30` to `40`. No repository tooling was changed. Actual use: **32/40 launches** = 16 baselines + 16 mutants; zero collection/retry launches. Every case had one mutation, below the two-mutation limit. Every launch explicitly specified **120000 ms**. No round reset, new round, further budget extension, or #1185 exception was used.

### Watcher visibility and tooling interruptions

The initial canonical watcher check under default sandbox visibility returned clear. Before the first actual launch, the same canonical check executed with elevated visibility refused on existing preview/server processes. At that point the journal had round 1, zero runs, no mutations, and only an open dotenv swap. Measurement stopped; the invoking lead ran the original finalizer. No report was written.

After the lead relayed the owner's assent to the explicit preview stop/restart proposal, the lead stopped only the revalidated previews and obtained an elevated clear watcher result. The verifier resumed the SAME round with zero launches and re-established canonical dotenv isolation. Every actual launch had a clear canonical watcher check with elevated visibility. The verifier did not override the guard or stop any process.

During measurement, claude-mem tool hooks intermittently returned unreachable-worker/socket errors, sometimes after the requested operation had succeeded. The verifier inspected the actual JSON report, journal, and source before retrying restoration or reads; no completed launch was repeated. No hook, package, or configuration was changed. The root's separately supplied diagnosis was not needed to classify any test result. The invoking lead confirmed both previews restored after finalization; that operational restart is lead-reported, not browser verification by this verifier.

## Duty 1 — complete inventory and mutations

Direction A used the immutable source diff: five new `read-gaps` cases, six new options cases, and all five existing GET cases consuming the changed GET-local DETAIL fixture. No shared helper, snapshot, or golden was changed; no test was deleted.

Direction B reverse-searched direct route importers and production-reader references. The changed detail composition hunk maps to the five read-gaps cases and the existing five GET gate cases. The new options route maps to its six exported-handler cases. Every changed production behavior has identified covering cases; no uncovered hunk was found.

File abbreviations below expand exactly to:

- **D**: `src/app/api/admin/businesses/[id]/__tests__/route.test.ts`
- **R**: `src/app/api/admin/businesses/[id]/__tests__/read-gaps.test.ts`
- **O**: `src/app/api/admin/businesses/options/__tests__/route.test.ts`
- **E**: `e2e/admin-14c-runtime.spec.ts`

| ID | File | Individual test title | Semantic mutation | Outcome |
| --- | --- | --- | --- | --- |
| C01 | D | GET /api/admin/businesses/[id] — an aal2 admin is served | Replace cookie transport with bearer transport | killed |
| C02 | D | GET /api/admin/businesses/[id] — an aal1 admin is refused 403 mfa_required | Change refusal from 403 to 200 | killed |
| C03 | D | GET /api/admin/businesses/[id] — a non-admin is refused 403 Forbidden | Change non-admin refusal from 403 to 200 | killed |
| C04 | D | GET /api/admin/businesses/[id] — an unauthenticated caller is refused 401 Unauthorized | Change unauthenticated refusal from 401 to 200 | killed |
| C05 | D | GET /api/admin/businesses/[id] — a bearer-transport aal2 admin is served | Drop bearer header before gate resolution | killed |
| C06 | R | waits for business detail before reading and returning the scoped batch summary | Start batch read before awaited detail completion | killed |
| C07 | R | returns a null batch summary for the wrong account | Replace actual account scope with another fixture account | killed |
| C08 | R | returns a null batch summary for the wrong business | Replace requested business scope with another fixture business | killed |
| C09 | R | returns 404 without reading batches when the business is missing | Return 200 for missing business | killed |
| C10 | R | returns the existing generic failure when the batch read fails | Swallow batch read rejection into successful null projection | killed |
| C11 | O | returns only betaCompActive true when the coupon is armed | Invert coupon availability | killed |
| C12 | O | returns only betaCompActive false when the coupon is unarmed | Invert coupon availability | killed |
| C13 | O | serves options to a bearer-transport AAL2 admin | Drop bearer header before gate resolution | killed |
| C14 | O | refuses options to an AAL1 admin before reading the coupon | Return 200 instead of AAL1 refusal | killed |
| C15 | O | refuses options to a non-admin before reading the coupon | Return 200 instead of non-admin refusal | killed |
| C16 | O | refuses options to an unauthenticated caller before reading the coupon | Return 200 instead of unauthenticated refusal | killed |
| E01 | E | unauthenticated GET /api/admin/businesses/00000000-0000-0000-0000-000000000000 returns 401 | None: Playwright/E2E excluded by protocol; fragile assertions inspected. | excluded |

Additional scope decisions were explicit, with no silent sample reduction:

- The existing five PATCH cases do not consume the GET-local DETAIL fixture or execute the changed GET body. PATCH production and its fixtures are unchanged.
- The two detail-suite instances and aggregate source check in `src/lib/auth/__tests__/admin-gate-mocks.test.ts` read unchanged mock-import syntax. They neither consume the modified DETAIL value nor exercise the new route behavior.
- The six `readAdminBatchSummary` integration cases exercise the unchanged reader directly. No SQL implementation, ordering, projection, or reader helper changed, so they are not added mutation candidates for the route-composition change.
- Existing page tests exercise unchanged pages; client-hook tests mock HTTP. Proxy and gate audits inspect unchanged policy or synthetic text. Direct reverse searches found no additional tests executing the changed route behavior.
- No migration appears in the immutable diff.

The mutation supervisor invoked the local Vitest entry point using argument arrays, never interpolated repository-controlled arguments into a shell command. Test names were escaped by the ORIGINAL runner. The command shape was identical for baseline and mutant, apart from the raw output filename:

```text
node /private/tmp/1189-mutation-runner.mjs run
  --tmp-home /private/tmp/1189-redteam-home --timeout 120000 --
  node node_modules/vitest/vitest.mjs run <test-file>
  -t <canonically escaped exact test title>
  --maxWorkers=1 --no-file-parallelism
  --reporter=json --outputFile=<raw JSON path>
```

The canonical environment allowlist and scrubbed dotenv copy were used for both runs. No database URL was supplied, so `REPWORTH_DISABLE_LIVE_DB_SUITES=1` was set by the runner. No allowlist widening, live-provider execution, concurrent gates, or network work occurred. Test-local synthetic identity and coupon fixtures were used.

Each raw report passed the ORIGINAL `assert-one-test`. A final independent parse of every report required exactly one executed case, the expected baseline/mutant status, zero runtime-error suites, and an `AssertionError:` failure for every mutant. None was classified as killed because of a setup, import, type, or compilation failure. No survivor required arbiter confirmation.

### Raw measurement provenance

Raw JSON remains under `/private/tmp/1189-measurements/` as `Cnn-baseline.json` and `Cnn-mutant.json`. These files are local measurement data, not committed report artifacts. Hashes below identify the exact measured output. Mutant blob OIDs are the canonical journal's production objects.

| ID | Baseline JSON SHA-256 | Mutant JSON SHA-256 | Journaled mutant blob OID |
| --- | --- | --- | --- |
| C01 | `51775009969140a1840990bd10dd14585203e1c1e9a7b379b0357c08b077bc4c` | `beba76922014d1c78eb2874de793f5a495f2bbf642d93e773e1d09206c88db6f` | `f535f9bfd5fa78cf55145f07e48bf4f168a26cf8` |
| C02 | `6ce2a882da396f03d6a0382e818e3b82154bab036e3ebf802d81406d9c7f6a04` | `371e2107486142463d539a9b8f6664efc6b44ad7f2e667884e933684b8a58c46` | `890c5dac6be1106b248f0deb174e28d4bcb0380f` |
| C03 | `674d6539665f28738158752c158df7001abfbe8a23d682ecd426c27c431639f4` | `529fb755bcb611f71e65f0b2989090ca5b0febb907e764ca5f07aef28d9fa6b9` | `890c5dac6be1106b248f0deb174e28d4bcb0380f` |
| C04 | `e88a46fad11649b75fbe824f22b6130dbab28220fefa008f3a089babc6a2a403` | `a00e7f1520b8060a0a846e1b532c8f26e662c801df640ad6525a8856fa9307dc` | `890c5dac6be1106b248f0deb174e28d4bcb0380f` |
| C05 | `1beb8c6fe26b438e36be5de37029e658980d7a8f5ed3ab10ace83afa8ab1d4d2` | `2ce84e44ee967c7e1fd033481e4c46953e14afe243a9616e04991236ef89a838` | `8f9e3ae40d9ee2ff02afe9e2f831325006e846fa` |
| C06 | `1941c5e9848def6a103057f5b919d77387aafb0e82962d3dc82a7b43302f417a` | `3f538a6849b54dd727bc7c4009189096b3c6952cdd887b589c9f04ceefe6d7cb` | `211b91904236f80b02324bba3c7562db6f130776` |
| C07 | `daa70f390cc2b8e7ec8ddfe81c564d029cb752eff64e14bf013ebd14b33da80d` | `6febfaeb74a427fe72a39eedd15cde6b4ede28656e09dc24743a2d3426daf58b` | `7498bd510f913178353f272229a31356503f0333` |
| C08 | `d44a4d7857329ecabcc3e42cf62e57197b0c70cfe7bc207aceda18cbeb414e49` | `80492830470caa30e9b7ae3379722d0802b4e2523c4b07a5e62f34bef602c1d8` | `7dcb5e5524ee5a937d939477f636b9d5a8712c78` |
| C09 | `09579b779d7402da41a8e76110bee6b00be5b2176bf33fc2bf2a708fc8fa289b` | `dcefa5c8ff857b108153f8dcbf885194ec0041a83518fc9cf9d7795ef8a8e9b6` | `7b115c6ef9ca5788403a1e9143d4bb1b9afdca46` |
| C10 | `79a45960a7aabb13c5f0e1aa5f7fc491b5dc19ccf05df1ba412d4ffacfc3fc7c` | `5122e1a303b15da26297e5a935875227a59bc377da1c238f518cec21120313fa` | `8324bf984a4ecf9c50d026337e1d8ba10194335b` |
| C11 | `5fab57750da39d08eb01aa7a519e6e4000490b6ae8b73115d055ca977e2a0d8b` | `2ff3f8bbd0b8a53df299e1ac020332a31330f9f131ec30775dbe83bfa505c680` | `51e8bea9455eb8629d589d86249885711ba82dd7` |
| C12 | `838110e9a8792fb6c3bc285556c1fe8354cf414048d67a557a51bba614285e28` | `32d62b5b1aa6f70994a0b85dd06a00eed59a6e03ddfd468f212fae795ee08e83` | `51e8bea9455eb8629d589d86249885711ba82dd7` |
| C13 | `7244329cc88ecd6bc3023b9de8e6d6a3cdcbed6220db281143cc8d0eb4e73cb8` | `adfcc1826e781907ad2a2126f3625ccba877deebc04f20caa67c2bbf0750d9fc` | `8be7b4cc8f635c038d773bd06885291866c9ac86` |
| C14 | `b735577353bb4a4a9c7da06267b7dfaaacc6f32e71e5dc610c0cc95f03b98c67` | `e932836b6b6f85095a8c98e86c68c97cf3fe8b74743257743f8151849b056529` | `ad9b8bf78d40175613d632975ef4487ada129cef` |
| C15 | `64dcb2c8ec4ccae5f6e5171600fd9c50bba2a3d8c7409da2a16341bb9d3dd60f` | `dfa8383cc86ba0b3a3062f18202bc2ad1ce0e3d8a86c005f5d7ab4fc06b4319e` | `ad9b8bf78d40175613d632975ef4487ada129cef` |
| C16 | `679afc6077404d8aebe0200f0d56c9521b40ed958f93cf72817285468bd06660` | `6bb7e7f6dd79dedc019c324cb553b5b7a68a88fd263ab503f99a705cb81991e4` | `ad9b8bf78d40175613d632975ef4487ada129cef` |

## Duty 2 — fragile assertions

Inspected every added/modified test and the retained E2E candidate. Searched for absence-of-tag proxies, exact rendered-string counts, and incidental order assertions. None was found.

The response equality assertions describe the closed wire contract, including the server-only coupon boundary. The no-read assertions establish authorization or sequencing behavior. The SQL-not-called check before resolving the deferred detail promise is an explicit ADR 0027 ordering requirement, not incidental scheduling. The existing gate transport checks inspect the actual resolved transport. The E2E case checks status, JSON content type, and error body rather than rendered structure.

## Duty 3 — documentation versus HEAD

The prescribed deterministic validator was run after the invoking lead clarified that the earlier “no helper execution” restriction referred to the temporary staging authentication helper, not this read-only documentation validator. The earlier decision to omit the validator was the verifier's overly broad interpretation. It is corrected here; no second mutation round, launch, source edit, or gate run was needed.

The verifier read the validator's implementation before execution. It checks filesystem citation existence/line counts, referenced fixture tracking, and commit resolution using read-only filesystem and Git operations. These exact commands ran from the frozen-HEAD worktree:

```bash
python3 /Users/norbertesekiel/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/superpowers/plans/feat-1189-plan.md --repo .
python3 /Users/norbertesekiel/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/superpowers/plans/feat-1189-intake.json --repo .
python3 /Users/norbertesekiel/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/reviews/feat-1189/inventory-and-budget.md --repo .
python3 /Users/norbertesekiel/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/reviews/feat-1189/plan-skeptic.md --repo .
python3 /Users/norbertesekiel/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/directory/app-api-b.md --repo .
python3 /Users/norbertesekiel/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py .claude/reference/arch-review-log.md --repo .
python3 /Users/norbertesekiel/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/reviews/red-team/feat-1189-dbab1e/findings.md --repo .
```

| Document | Citations checked / unresolved | Fixtures checked / gitignored | Commits checked / stale | Mechanical result |
| --- | ---: | ---: | ---: | --- |
| Feature plan | 0 / 0 | 0 / 0 | 0 / 0 | PASS, exit 0 |
| Committed intake | 0 / 0 | 2 / 0 | 0 / 0 | PASS, exit 0 |
| Inventory and budget | 0 / 0 | 2 / 0 | 0 / 0 | PASS, exit 0 |
| Plan-skeptic report | 0 / 0 | 0 / 0 | 0 / 0 | PASS, exit 0 |
| API directory | 0 / 0 | 0 / 0 | 0 / 0 | PASS, exit 0 |
| Complete architecture history | 64 / 2 | 28 / 0 | 9 / 2 | 4 ISSUES, exit 1; all four outside the changed entry |
| This findings report before this completion correction | 0 / 0 | 2 / 0 | 2 / 0 | PASS, exit 0 |

Only mechanical validator output was read for the other reviewer's report; its conclusions were not read or adopted.

The architecture log is a large append-only history. Its four mechanical diagnostics were:

```text
CONTEXT.md:75 — file has only 7 lines
pricing/page.tsx:17 — file does not exist at HEAD
3404cf07434a4d4ad9670f62ce573556 — does not resolve to a commit in this repo
01a0399f — does not resolve to a commit in this repo
```

Each matching source line was independently compared against the immutable base blob with `git show`; all were byte-identical. Their base-to-HEAD line positions were 995/1861 → 997/1863, 1872 → 1874, 242 → 244, and 1866 → 1868, respectively. The immutable zero-context diff shows the only architecture-log change is the two-line addition at HEAD lines 3–4. Therefore these four diagnostics are pre-existing historical content, explicitly outside the changed claims; they are not new #1189 findings and were not silently treated as validator PASS. No unrelated history was repaired.

Mechanical existence checks do not establish meaning and do not fully recognize bracketed dynamic-route paths. The verifier also manually checked changed plan, intake, directory, architecture-trace, and inventory facts against pinned source and retained execution evidence. The changed plan, inventory, and directory claims contain no path/line citations. Their referenced detail route, options route, legacy pages, canonical gate, coupon accessor, and unchanged batch reader all resolve. The new API composition matches the legacy page's sequential pattern and returns the existing safe projection; options returns only the boolean.

The architecture trace's “no new database query” refers to reuse of the existing SQL reader, not an absence of a new reader call. The directory row describes the actual GET/PATCH exports and removes its obsolete DELETE claim. The inventory/budget document is explicitly a preflight/approval record, not a completed-verification assertion. No misleading false claim or stale changed citation was found. A plan's intended delivery steps were not treated as completed staging, browser, build, or merge evidence. The scoped finding count and sidecar status remain unchanged.

## Duty 4 — missed sibling cases

Exact searches and scopes used:

```text
git diff c951bc2ebbafba310cc35f11f6e06fc5d8b57414 bf84c855b947f0cd4c8587b880968cacb7b7caa9 -- src
rg -n --glob '*test*' --glob '*spec*' 'businesses/\[id\]|businesses/options|readAdminBatchSummary|betaCompCouponId' src e2e
rg -n 'businesses/\[id\]/route|businesses/options/route|from .\.{1,2}/route|readAdminBatchSummary|betaCompCouponId' src/app/api/admin/businesses src/lib/auth/__tests__ e2e src/__tests__
rg -n 'readAdminBatchSummary|betaCompCouponId|businesses/\[id\]|options' src/app/admin/businesses src/app/api/admin/businesses docs/adr/0027* docs/runbooks/beta-launch-alerting.md
```

The relevant existing siblings are the legacy business-detail page and new-business page, which already use the same reader/accessor. Both remain correct and intentionally remain direct readers under the locked non-goals. The channels endpoint remains separate. Searches found no additional changed-pattern sibling requiring a fix. Scope exclusions are enumerated in Duty 1; unrelated unchanged policy, reader implementation, and page-retirement work were not opened as new fronts.

## Duty 5 — operational completeness

Reviewed both production hunks, their catch/report paths, `src/lib/shared/report-caught-error.ts`, and the alerting runbook for newly added operator-actionable terminal or swallowed failures.

The added batch await rejects into the existing generic GET 500 path and existing `reportCaughtError('api/admin/businesses/[id] GET', error, { businessId })`. The helper retains `captureException` with the endpoint tag. Options adds no catch, terminal-state transition, or swallowed error branch. A request-level read failure remains visible to the caller; this change adds no terminal background failure requiring a new alert rule.

All six alert-path facets were considered: signal identity, filter, level, grouping title, threshold/cadence, and destination action. None is newly introduced or changed by this diff; no new rule row is claimed. Consequently, no missing counterpart or contradictory changed facet was found. This is static analysis only; Sentry delivery drills and staging acceptance remain outside this verification.

## Findings and authorizations

| Severity | Open | Fixed | Rejected | Accepted risk |
| --- | ---: | ---: | ---: | ---: |
| P0 | 0 | 0 | 0 | 0 |
| P1 | 0 | 0 | 0 | 0 |
| P2 | 0 | 0 | 0 | 0 |

### Authorizations

None. This section renders the empty `authorizations` array in `findings.json`: no finding exists that needs an authorization target. The authentic operational launch-budget and preview-lifecycle permissions are recorded separately above; no empty or fabricated finding authorization was invented.

## Remaining acceptance boundaries

Computer Use, authenticated staging reads, desktop/mobile legacy-page regression, and any staging delivery check were not performed by this verifier and remain lead-owned acceptance work. The successful mutation pass does not certify those journeys. The final serialized gate, report commit, PR, and any eventual merge remain owned by the invoking workflow and its applicable approvals.


<!-- BEGIN #1189 LEAD ACCEPTANCE RECORD -->

## Lead integration, independent reviews, and artifact ownership

The fresh verifier's report above is preserved. This section and the appendices
are maintained by the accountable feature lead. The production implementation
remains pinned to bf84c855b947f0cd4c8587b880968cacb7b7caa9; subsequent report-only
commits must be distinguished from the mutation-tested runtime source.

All three independent production-diff axes approved that pin with no actionable
findings: correctness assessed all 41 existing checklist entries; maintainability
assessed all 26 entries; security recorded the absence of a repository checklist
and assessed its explicit relevant authorization/tenant checklist. Complete
verbatim reports, reviewer identities, pinned SHAs, and content hashes appear
below. Their original .feature/review-staging files and native review-transcript
attachments remain available locally.

Artifact-path adaptation was approved by the orchestrator before measurement.
The feature skill's section 6.5 requests copying staged reports into
docs/reviews/<branch>, while the red-team status check permits only this run's
two findings artifacts to change after measurement. Preserving complete reports
inside this already authorized findings.md keeps the source pin honest and the
review evidence durable. No checker was changed, no review axis was omitted,
and no additional surface amendment was taken.

The same authorized file is the staging campaign evidence and teardown record.
The runbook skill requires an evidence file before campaign setup and a teardown
ledger before fixtures; its suggested docs/runbooks/evidence path would add a
second surface amendment here. The orchestrator explicitly approved using this
file with the full environment, preflight, deviation, unproven-path, and teardown
sections below. The PR will link this durable record.

### Auxiliary staging-helper triage

The temporary GET helper was independently reviewed before any authentication.
Its two P2 evidence-accuracy findings were accepted and corrected within the
already authorized temporary helper preparation:

| Finding | Lead triage and source evidence | Resolution |
| --- | --- | --- |
| Helper F1: primitive strings could falsely pass the batch schema check | ACCEPT: pinned BatchState and HaltReason definitions are finite enums. Exact fixed allowlists are required. | Corrected and independently verified at helper hash 6d851b260755e45527eed807bd759246d4cef0b165bf0f9bc0981b1ddf356361. |
| Helper F2: SDK sign-out success could overstate cleanup | ACCEPT: the installed SDK can return success without sending logout and can suppress certain HTTP errors. Session-attempt/response evidence and successful local-logout HTTP evidence are required. | Corrected with sticky uncertainty, three explicit cleanup outcomes, and a nonzero exit when unconfirmed; independently verified at the same hash. |

The helper additionally requires the exact missing-business JSON error with
HTTP 404. Its initial and verification reports are preserved verbatim below.
These auxiliary findings are separate from the fresh production-diff verifier's
zero-finding sidecar; neither auxiliary finding remains open.

After independent approval, node --check passed for the exact helper bytes.
Nineteen isolated local scenarios exercised functions extracted from those exact
bytes in a VM without importing the helper or starting a server: seven cleanup
classifications, six Host/Origin cases, and six form/nonce cases. The checks
included lost password/MFA responses, no successful HTTP logout, replay,
duplicate/extra fields, body cap, and content type. No network request or
authentication occurred during those checks.

### Gate history and operational recovery

The first two full review gates failed before the current green result.
The second failure included the unchanged review-QR timeout and a PastReplies
wait for its Edit further control. The same two cases subsequently passed under
unchanged isolated coverage settings. These failures occurred during substantial
host swap churn; after reboot and restoration of the documented local
repworth-testdb container, the third full gate passed without increasing test
timeouts, reducing coverage, or editing those unrelated tests. The full GREEN
reset the durable gate-failure counter. Later evidence commits still require
ordinary fingerprint regeneration.

On the authorized retry, bounded samples showed CPU idle rising from 66.39% to
77.19% and aggregate swap churn about 0.003 GiB/minute. The exact current source,
intake, fingerprint, runner hashes, and round-1 journal were checked before work
resumed. The two pre-existing parent-checkout preview commands were still the
only elevated watcher blockers. The orchestrator treated the owner's response
“All right can you try again? I fixed the memory issue.” as assent to the
immediately preceding, concrete temporary stop/restart proposal.

Only those exact process trees were stopped after revalidating start times,
parent relationships, cwd, commands, and listener ports. SIGTERM stopped the
3100 tree. The 3101 listener closed, but its two verified processes required
targeted SIGKILL after a bounded graceful wait. Shared Codex parent PID 8575 was
not touched. After the original mutation finalizer restored all source and
dotenv state, both exact commands were restarted from the parent checkout and
reported Ready. Listener verification found 3100 on PID 91882 and 3101 on PID
92185. The startup commands are restored; original unrecorded environment
overrides and pre-stop in-memory state cannot be reconstructed.

The observed intermittent claude-mem hook failures are recorded in the verifier
report. The orchestrator's separate read-only diagnosis identified mismatched
package and embedded-worker version identities causing repeated respawn
attempts. This attribution is operational context, not evidence used to classify
a mutation. No plugin, hook, or package repair was made in this feature.

### Pre-push scheduling

A temporary effective Lefthook config at
/private/tmp/1189-lefthook-serial.yml changes only pre-push.parallel from true to
explicit false. Mechanical comparison of both effective dumps confirmed all
25 commands and every other setting unchanged; the effective dump omits the
false boolean. Comparison data is retained at
/private/tmp/1189-lefthook-config-comparison.json. Both dumps used this feature
worktree as cwd, preserving command-relative paths. Using this supported
scheduling override does not skip hooks, checks, or tests and changes no
repository hook/config file.

<!-- BEGIN #1189 STAGING CAMPAIGN -->

## Staging campaign evidence and teardown ledger

**Campaign status: PASS — API, desktop/mobile browser, and teardown complete.** This record was opened at
2026-09-10T11:38:03Z before staging setup or helper authentication. The candidate
is READY on staging; desktop/mobile browser acceptance passed. The corrected
isolated helper proved all three API reads and confirmed local logout.
All helper/probe process cleanup is complete at 2026-09-10T21:27:56Z.
Earlier incomplete attempts and their cleanup remain preserved below.
No staging PASS is claimed by the preceding independent reports.

Environment and fixed scope:

- Environment: staging.
- Supabase project: kubdiqdhqbhwmqfditeg.
- Production project udeyaqnvpojbwgoaxwdg: NEVER touched by this campaign.
- API: https://staging.repworth.net.
- Admin-app browser shell: https://admin.staging.repworth.net/admin/overview.
- Legacy read-only browser journey: /admin/businesses/01a06dd3-1622-70c7-9037-7dd9171aea17.
- Reviewed implementation SHA: bf84c855b947f0cd4c8587b880968cacb7b7caa9.
- Vercel project: prj_wIMnzHKefoQRdzCeMZesg2mIgNc0; team: team_8XsnodzHbwNdv5KiRVfMJ4GL.
- Pre-campaign staging baseline: deployment dpl_J6UwBqrx3ZtpGHQAn7SkmKsPoirj,
  READY at c951bc2ebbafba310cc35f11f6e06fc5d8b57414. The candidate must be
  independently pinned after deployment.
- Candidate deployment: dpl_Epjm5UxkSNSA4K7Qpkfrr3YF4GnU, READY at
  2026-09-10T11:59:07.947Z, Git SHA
  57af3d9786413d37f5ce531ca66e67d24528d0bb. Vercel metadata confirms the
  staging branch and attached staging.repworth.net alias. Comparing this SHA
  with the reviewed implementation pin yields only findings.md/findings.json;
  all runtime source is identical.
- Owner-designated account: 01a06dd3-1624-72b4-a4bf-22ab2f19fecb.
- Its sole identified business: 01a06dd3-1622-70c7-9037-7dd9171aea17.
- Fixed missing-business probe: 00000000-0000-4000-8000-000000000099.
- Stripe: not exercised; no Stripe calls or payment-state changes.
- No admin creation/reset, staging seed, migration, flag change, impersonation
  operation, review post, or production write is included.

The fixture IDs were resolved by an earlier narrow read-only lookup restricted
to the owner's designated account. A staging-only recheck at
2026-09-10T11:58:36Z confirmed account existence, the exact business/account
relationship, one business for that account, and absence of the fixed missing
probe. No account email or unrelated customer fields are retained here.

Executed through the Supabase SQL tool with project kubdiqdhqbhwmqfditeg:

```sql
SELECT
  EXISTS (SELECT 1 FROM public.accounts
    WHERE id = '01a06dd3-1624-72b4-a4bf-22ab2f19fecb'::uuid)
    AS designated_account_exists,
  EXISTS (SELECT 1 FROM public.businesses
    WHERE id = '01a06dd3-1622-70c7-9037-7dd9171aea17'::uuid
      AND account_id = '01a06dd3-1624-72b4-a4bf-22ab2f19fecb'::uuid)
    AS designated_business_account_match,
  (SELECT count(*) FROM public.businesses
    WHERE account_id = '01a06dd3-1624-72b4-a4bf-22ab2f19fecb'::uuid)
    AS designated_account_business_count,
  NOT EXISTS (SELECT 1 FROM public.businesses
    WHERE id = '00000000-0000-4000-8000-000000000099'::uuid)
    AS fixed_missing_business_absent;
```

Sanitized result: designated_account_exists=true,
designated_business_account_match=true, designated_account_business_count=1,
fixed_missing_business_absent=true.

### Preflight

| Check | Result | Evidence/time |
| --- | --- | --- |
| Implementation/full gate/independent axes | PASS | Frozen source and preceding reports; full gate fingerprint 3077f6f99e99770211e013c4a52060cdc39c7025c0534efebff1c3373bb473c1. |
| Complete mutation inventory | PASS | Round 1, 32 launches, 16 killed; original finalizer complete. |
| Temporary helper security and local checks | PASS | Exact preserved source and independent verification below; helper has not authenticated. |
| Candidate report commit and fresh gate | PASS | Commit 57af3d9786413d37f5ce531ca66e67d24528d0bb; all 32 full-gate rows passed; 14,665 tests passed / 1,184 skipped; test runtime 374.75 seconds. Fingerprint 3789716147e025faa32fe4cc96111661606661afa996c0f214449093d4a16e95. |
| Candidate Vercel deployment READY and runtime-source identity | PASS | dpl_Epjm5UxkSNSA4K7Qpkfrr3YF4GnU at the candidate SHA; READY 2026-09-10T11:59:07.947Z; only two report files differ from the reviewed runtime pin. |
| Designated fixture/account and missing-ID read-only recheck | PASS | Fixed-ID SQL and boolean/count results above, 2026-09-10T11:58:36Z; no broader lookup or fixture creation. |
| Browser/operator authentication | PASS | Existing cookie-AAL2 desktop/mobile HTML regression passed; owner-completed fresh password/MFA in the reviewed corrected helper produced the three API proofs and confirmed local logout at 21:27 UTC. |

The candidate staging push completed normally after all 25 unchanged pre-push
checks passed under the documented serial scheduling override (58.23 seconds).
No hook was skipped. The existing hooksPath warning concerned automatic hook
installation sync; the actual pre-push command summary contains all 25 passes.

### Teardown ledger

| Item | Identifier/scope | Cleanup and verification | State |
| --- | --- | --- | --- |
| Mutation dotenv isolation and process groups | Round 1, feature worktree | Original lead-owned finalizer; all 16 entries restored, 32 process groups empty, dotenv closed. | COMPLETE before reports. |
| Temporarily stopped parent previews | Original commands on 3100/3101 | Restarted exact commands after finalizer; both Ready and listeners verified. Source ledger preserved below. | COMPLETE. |
| Helper-created auth session | First isolated run only; cleanup obligation opened at 2026-09-10T12:10Z | Original TTL shutdown reported “no session attempted”; no session existed to sign out. | COMPLETE at approximately 2026-09-10T12:19:02Z; no auth session created. |
| Loopback GET helper process | Reviewed source SHA-256 6d851b260755e45527eed807bd759246d4cef0b165bf0f9bc0981b1ddf356361; 127.0.0.1:60783, owned exec session 10913, PID 36642 | Original eight-minute TTL; owned session exited 0. Elevated lsof and ps returned no listener/process at 2026-09-10T12:19:23Z. | COMPLETE; process and listener absent. |
| Designated staging records | Existing fixed account/business only | Read-only campaign; no fixture creation or data cleanup required. | No writes planned or performed. |
| Second helper-created auth session | Owner-ready resume, 2026-09-10T21:11Z; isolated reviewed helper only | After outer local request rejection, normal SIGTERM shutdown reported “no session attempted.” | COMPLETE; no auth session created. |
| Second loopback helper process | Exact approved SHA-256 6d851b260755e45527eed807bd759246d4cef0b165bf0f9bc0981b1ddf356361; 127.0.0.1:51441, owned exec session 71967, PID 28124, launch 2026-09-10T21:12:16Z | SIGTERM through original shutdown; owned exec exited 0. Elevated lsof/ps confirmed process and listener absent at 2026-09-10T21:16:13Z. | COMPLETE. |
| Credential-free Origin-policy probe process | Approved source SHA-256 a6819932becc309903fe0beb7bca049349aa83e9b71f37f03560799183e302b7; 127.0.0.1:54054, owned exec 8979 | Root clicked Close probe after labeled evidence; owned exec exited 0, listener absence verified. No authentication or staging request occurred. | COMPLETE at approximately 2026-09-10T21:20:30Z. |
| Third helper-created auth session | Corrected exact reviewed helper; fresh run after owner readiness and real-browser policy proof | Password/MFA accepted, local logout successful HTTP response received; result page and final stdout both confirmed local logout. | COMPLETE at 21:27 UTC. Existing browser admin sessions untouched. |
| Third loopback helper process | Approved corrected SHA-256 c89566baf90d5edf6c209af457832850098cf5079e670c471dded2947a4b0f92; 127.0.0.1:54708, owned exec 44616, PID 49320, launch approximately 2026-09-10T21:21:14Z | Root clicked Close helper; owned exec exited 0. Elevated lsof/ps confirmed process and listener absent at 2026-09-10T21:27:56Z. | COMPLETE. |

### Unproven paths

| Acceptance path | Status |
| --- | --- |
| Authenticated options response contains exactly one boolean betaCompActive | PASS: HTTP 200, exact boolean schema valid, betaCompActive=true. |
| Authenticated designated detail retains existing fields and includes a valid batchSummary/null | PASS: HTTP 200, existing keys/types and designated business/account match valid; batchSummary present and null. |
| Fixed missing business returns 404 and exact route error JSON | PASS: HTTP 404 and exact route error JSON valid. |
| Legacy business page remains usable at desktop and mobile layouts | PASS: root's in-app browser checks at 1440×900 and 390×844, persistent screenshots below. |
| Helper session cleanup and process teardown | PASS: earlier two runs had no session attempted; final authenticated run confirmed local logout, exit 0, and process/listener absence. Synthetic probe also closed and exited 0. |

The deployed coupon was armed (betaCompActive=true); no configuration changed.
Unit tests cover both values and AAL1/non-admin/
unauthenticated refusal; live evidence must be limited to paths actually
observed. A null live summary proves presence/nullability, not a populated
summary. No claim of #1197 Gate B or ADR 0025 D9 completion is made here.

### Campaign deviations and final verdict

Owner-ready resume at 2026-09-10T21:11Z: staging.repworth.net still resolves
to READY deployment dpl_Epjm5UxkSNSA4K7Qpkfrr3YF4GnU at
57af3d9786413d37f5ce531ca66e67d24528d0bb. Runtime source remains identical
to reviewed bf84c855; only the two authorized findings artifacts differ.
The helper's exact approved source hash was rechecked unchanged. A second
isolated run is authorized after the owner explicitly reported readiness;
the first attempt's blocked verdict below remains historical until this
new run supplies actual API results and cleanup evidence.
Before the second launch, a fresh staging-only SELECT restricted to the same
fixed business/account and missing UUID returned
designated_business_account_match=true and fixed_missing_business_absent=true.
Only the enabled modern staging publishable key was selected; no key value
or credential is persisted in this record.

Second-attempt deviation: the owner submitted the local login form and root
observed its fixed “Request rejected.” page at /login. The helper's outer
request guard rejected the request before authentication; after normal
shutdown, the helper reported “no session attempted” and exited 0. This is
a temporary-verifier defect, not an observed staging API or admin-gate failure.
The reviewed source sends Referrer-Policy:no-referrer while mandating exact
Origin on POST. Root checked the WHATWG Fetch Origin-header algorithm:
for a non-CORS POST, no-referrer serializes Origin as null. The proposed
bounded correction is Referrer-Policy:same-origin with the strict request
guards unchanged; independent exact-artifact security review and a
credential-free real-browser probe are required before another owner login.
The subsequent safe probe measured actual browser Origin behavior as below.

At 2026-09-10T21:20:21Z root completed both fixed empty forms in the in-app
browser. The labeled original-policy result reported Origin:null; the labeled
corrected-policy result reported Origin:http://127.0.0.1:54054. Both reported
Host:127.0.0.1:54054 and Sec-Fetch-Site:same-origin. This reproduces the exact
guard conflict and verifies the bounded correction without credentials or
external requests. Root clicked Close probe; owned exec 8979 exited 0 and
the listener was confirmed absent. The corrected authenticated helper was
started only after this proof and fresh independent exact-hash approval.

Sanitized labeled probe screenshot:
[1189-helper-origin-policy-proof.png](/Users/norbertesekiel/.codex/visualizations/2026/09/09/01a084d9-2ea0-7bd3-a71a-0fb8ef37c4f8/1189-helper-origin-policy-proof.png),
SHA-256 5ba451007122127b5844a1e196383dd10c989e05946485b43d715c6030199193.
Specification reference: [WHATWG Fetch — Origin header](https://fetch.spec.whatwg.org/#origin-header).

Sanitized rejection screenshot, inspected by root with no credentials:
[1189-helper-origin-rejection.png](/Users/norbertesekiel/.codex/visualizations/2026/09/09/01a084d9-2ea0-7bd3-a71a-0fb8ef37c4f8/1189-helper-origin-rejection.png),
UTC 2026-09-10T21:15:16.787Z, SHA-256
8256673e9ee5f73b6b36c27881a1824338748b1b279b000d7a51e9b543a01f93.

Root reported the read-only legacy HTML regression PASS on staged 57af3d97
using the existing cookie-authenticated AAL2 session. The exact designated
business page loaded at desktop 1440×900 and mobile 390×844. Document width
did not exceed the viewport, mobile navigation collapsed, and the send-batch
section displayed “No send batch on file for this location.” No edit or action
was submitted. This checks the existing SSR journey, not the new API shapes.

Sanitized screenshots were inspected by the browser operator and contain no
account emails, credentials, or customer records. Persistent artifact root:
/Users/norbertesekiel/.codex/visualizations/2026/09/09/01a084d9-2ea0-7bd3-a71a-0fb8ef37c4f8.

- [1189-business-desktop-main.png](/Users/norbertesekiel/.codex/visualizations/2026/09/09/01a084d9-2ea0-7bd3-a71a-0fb8ef37c4f8/1189-business-desktop-main.png) — desktop top crop 1192×750;
  UTC 2026-09-10T12:03:37.575719Z;
  SHA-256 5e709e6392a48c760f8cb159212849b6ba46ecfbcc677030c62f12d247c399c5.
- [1189-business-mobile.png](/Users/norbertesekiel/.codex/visualizations/2026/09/09/01a084d9-2ea0-7bd3-a71a-0fb8ef37c4f8/1189-business-mobile.png) — UTC 2026-09-10T12:04:15.762Z;
  SHA-256 2ad205b2d7d0f8e5ef898eaa970d127417cf23b17b19f6ecaa22962bd66ba2d5.
- [1189-business-mobile-batch-verified.png](/Users/norbertesekiel/.codex/visualizations/2026/09/09/01a084d9-2ea0-7bd3-a71a-0fb8ef37c4f8/1189-business-mobile-batch-verified.png) — UTC 2026-09-10T12:06:40.875Z;
  SHA-256 6110dec2daa5ba0f782f4f8651fb5d6e53b191614db04dd698329cd0dfd798f9.

Screenshot deviation: inconsistent native clipped frames were discarded;
the operator used visually verified accessibility screenshots and a verified
crop for retained evidence. No application behavior failure was inferred.
Root explicitly signaled readiness for the isolated local auth handoff after
these checks. The helper and its embedded source hashes match, and installed
supabase-js/auth-js versions are both 2.106.2. Configuration uses only the
enabled modern publishable key returned for the fixed staging project;
the disabled legacy anon key is not used. Key values are not retained here.
The helper launch returned its owner-only URL at approximately 12:11 UTC.
At 12:12 UTC root confirmed the empty sign-in form in a visible in-app browser
tab and handed credential/MFA entry directly to the owner. The eight-minute
TTL is unchanged; authentication and API outcomes are not yet observed.

At approximately 2026-09-10T12:19:02Z the first run reached its original TTL.
Owned exec session 10913 returned exit 0 and the exact sanitized output:

```text
Helper stopped. Session cleanup outcome: no session attempted.
```

At 2026-09-10T12:19:23Z an elevated read-only check of PID 36642 and the
60783 listener returned no process or listener. No login/MFA or API request
was attempted by this helper run. Root confirmed no owner auth reply at
12:19:57Z and later confirmed the browser viewport reset succeeded. The
existing authenticated admin browser sessions were not modified or signed out.

The evidence-file path adaptation and watcher/tooling recovery are described
above. The additional campaign deviation is the unattended auth handoff
expiring before login. No product defect was observed and no bug was filed.

**Historical first-attempt verdict: FAIL / BLOCKED on missing authenticated API proof.**
The three API acceptance paths remain explicitly open; no owner sign-off
waives them. The implementation, staging deployment, independent reviews,
mutation campaign, and desktop/mobile HTML observations retain their recorded
PASS results. Teardown is complete for this attempt; verification ended at
2026-09-10T12:19:23Z. Resume only after a fresh owner-ready handoff, open a
new isolated-helper ledger obligation before login, and prove the three fixed
GETs plus that run's cleanup before publishing the PR or claiming campaign PASS.

### Final authenticated API observations and campaign verdict

At 2026-09-10T21:27:14.505Z root captured the corrected helper's sanitized
PASS result after the owner directly completed staging admin password/MFA.
The owner briefly saw “A verification step is already running” on /mfa;
root preserved the in-flight operation and subsequently navigated with GET /
to retrieve its completed result. No MFA POST or credential attempt was
repeated to obtain this evidence. The concurrent-request guard remained active.

| Actual observed result | Value |
| --- | --- |
| Options HTTP status | 200 |
| Options exact one-boolean schema | true |
| betaCompActive | true |
| Designated business detail HTTP status / JSON | 200 / true |
| Existing detail keys and types retained | true |
| Designated business/account IDs match | true |
| batchSummary field present | true |
| batchSummary is null / schema valid | true / true |
| Non-null batch fields/types | Not applicable to this existing fixture; no live populated-summary claim. |
| Fixed missing business HTTP status | 404 |
| Fixed missing business exact route error JSON | true |
| Password grant attempted / full response received / SDK session accepted | true / true / true |
| MFA verify attempted / full response received / SDK session accepted | true / true / true |
| Local logout successful HTTP response received | true |
| Helper cleanup outcome | confirmed local logout |

Root inspected and retained this sanitized screenshot containing PASS, all API
rows, and confirmed logout, without credentials, tokens, MFA codes, raw DTOs,
or customer records:
[1189-staging-api-pass.png](/Users/norbertesekiel/.codex/visualizations/2026/09/09/01a084d9-2ea0-7bd3-a71a-0fb8ef37c4f8/1189-staging-api-pass.png),
SHA-256 a419cb8533afe46fd5eeabeccf526ae8b4e6e89e3cad29a67568953326f23d83.

Root clicked Close helper after preserving the result. Owned exec 44616
returned exit 0 and the exact output:

```text
Helper stopped. Session cleanup outcome: confirmed local logout.
```

Elevated checks confirmed PID 49320 and the 54708 listener absent at
2026-09-10T21:27:56Z. All teardown ledger rows are complete. Existing admin
browser sessions were preserved; no staging records, flags, or production
state were changed.

**Final campaign verdict: PASS.** All five acceptance paths in the table are
closed with actual evidence. Deviations were the first unattended auth handoff,
the temporary helper's Referrer-Policy mismatch (corrected with an independently
reviewed single-header change and real-browser synthetic proof), and retrieving
the finished result after a busy response with a safe GET. No application bug
was observed, no new issue was filed, and no repository runtime fix was needed.
The live batch summary was null; populated-summary shapes, unarmed options,
and refusal cases are covered by the recorded tests rather than claimed as
live observations. This campaign does not prove #1197 Gate B or ADR 0025 D9.
UTC end: 2026-09-10T21:27:56Z.

<!-- END #1189 STAGING CAMPAIGN -->

### Citation resolution for verbatim appendices

The mechanical validator was also run on this combined evidence file after the
appendices were added. It checked 46 citations, reported 18 unresolved contextual
shorthands, found zero ignored fixtures, and found zero stale commit references.
These diagnostics are retained here; the combined mechanical run is not claimed
as PASS. The original report bytes remain unchanged.

The lead resolved every diagnostic using the source roots explicitly named in
the corresponding original report. Each mapped file exists and contains every
cited line. The helper reports use package-relative src paths under their
explicitly inspected installed Supabase package, rather than this application's
src directory. The following mapping resolves all 18 occurrences without
rewriting those independent reports or changing the validator:

| Report shorthand | Actual source root/path | Cited lines verified present |
| --- | --- | --- |
| options/__tests__/route.test.ts | src/app/api/admin/businesses/options/__tests__/route.test.ts | 45 |
| business-detail/mappers.ts | src/lib/admin/business-detail/mappers.ts | 283 |
| business-detail/queries.ts | src/lib/admin/business-detail/queries.ts | 97 |
| businesses/options/route.ts | src/app/api/admin/businesses/options/route.ts | 11 |
| payments/flags.ts | src/lib/payments/flags.ts | 65 |
| src/GoTrueClient.ts | node_modules/.pnpm/@supabase+auth-js@2.106.2/node_modules/@supabase/auth-js/src/GoTrueClient.ts | 3791, 423, 1087, 5427, 5237, 2790, 5041, 3783, 5281 |
| src/GoTrueAdminApi.ts | node_modules/.pnpm/@supabase+auth-js@2.106.2/node_modules/@supabase/auth-js/src/GoTrueAdminApi.ts | 150 |
| src/lib/fetch.ts in the Auth SDK report | node_modules/.pnpm/@supabase+auth-js@2.106.2/node_modules/@supabase/auth-js/src/lib/fetch.ts | 215 |
| src/SupabaseClient.ts | node_modules/.pnpm/@supabase+supabase-js@2.106.2/node_modules/@supabase/supabase-js/src/SupabaseClient.ts | 635 |
| src/RealtimeClient.ts | node_modules/.pnpm/@supabase+realtime-js@2.106.2/node_modules/@supabase/realtime-js/src/RealtimeClient.ts | 624 |

## Reproducible temporary verifier and independent report appendices

The helper source below is the exact independently approved artifact, not a
reimplementation. Its SHA-256 is
6d851b260755e45527eed807bd759246d4cef0b165bf0f9bc0981b1ddf356361.
Before execution, verify that hash and installed supabase-js/auth-js versions
2.106.2. Its only configuration input is the environment variable
REPWORTH_STAGING_SUPABASE_PUBLISHABLE_KEY, supplied from the confirmed staging
project's enabled publishable/legacy-anon key through an approved tool. No key
value, password, token, MFA code, or runtime credential belongs in this file.

Launch from the feature worktree with node
/private/tmp/1189-staging-get-verifier.mjs only after candidate readiness and
the fixed-fixture preconditions are recorded. The program binds an ephemeral
127.0.0.1 port, prints its local URL, and has an eight-minute TTL. The owner
enters credentials and MFA directly. It creates only its own in-memory session,
performs three fixed sequential staging GETs, displays sanitized status/shape
booleans, and locally signs out that session. Capture the sanitized result
before closing. Deployment identity is independent evidence: a report-only
deployment commit must have runtime source equal to the displayed reviewed pin.

The complete original reports and helper bytes follow with unique extraction
markers. Their hashes are for the exact bytes between their markers (for the
helper, inside its code fence), including the original final newline.

<details>
<summary>Correctness review — complete verbatim report</summary>

Source: /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1189/.feature/review-staging/spec-correctness.md

SHA-256: c81e4581dd838953e6596bb66d4e4ee5dce81ea5e96bda46c1a2dd8f27233893

<!-- BEGIN 1189-REPORT-0 -->
# #1189 independent spec/correctness review

Reviewer identity: `/root/feature_1189/spec_correctness` (fresh independent Codex reviewer).

Reviewed pin: `bf84c855b947f0cd4c8587b880968cacb7b7caa9`.
Frozen fork/merge base: `c951bc2ebbafba310cc35f11f6e06fc5d8b57414`.
Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1189`.
Lead-supplied full-gate fingerprint: `3077f6f99e99770211e013c4a52060cdc39c7025c0534efebff1c3373bb473c1`.

I reviewed the locked intake, plan, ADR 0027, applicable path rules and complete diff from `/private/tmp/1189-review-brief.md`. Every additional source-content read used `git show` at the reviewed pin. An immutable tree/path search identified callers; mutable source files were not used as evidence. This report is the only file I wrote. No implementation changes, test executions, commits, external requests or delegated agents were performed.

The repository's verify-spec skill supplied the evidence-table method. The assignment's frozen, read-only review and single staging destination take precedence over that skill's default additional artifact, agent and test-execution steps.

## Actionable findings

None at or above the requested 80% confidence threshold. I found no implementation contradiction of the locked runtime contract and no demonstrated caller regression requiring revision.

## Contract evidence

All source references below resolve at the reviewed pin; paths are relative to the worktree identified above.

| # | Contract field / promise | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `goal`: Admin API exposes the two existing server reads | VERIFIED | Detail route `src/app/api/admin/businesses/[id]/route.ts:41` invokes the existing summary reader; `src/app/api/admin/businesses/options/route.ts:11` returns the existing accessor's availability boolean. |
| 2 | `user_visible_behavior[0]`: preserve detail fields and add `batchSummary` | VERIFIED | Detail route line 42 spreads the complete detail object before adding the summary. `read-gaps.test.ts:64` exercises exported GET and checks exact response equality, including representative pre-existing fields, rather than checking only the addition. The service's plain DTO mapping is at `src/lib/admin/business-detail/mappers.ts:291`. |
| 3 | `user_visible_behavior[1]`: options returns only `betaCompActive` | VERIFIED | Options route line 11 constructs a one-property object. Its tests at `options/__tests__/route.test.ts:45` and line 53 assert exact bodies for true and false. No coupon identifier or other config is serialized. |
| 4 | `invariants[0]`: canonical admin AAL2 gate on both reads | VERIFIED | Detail route lines 29–30 and options lines 8–9 call the canonical imported gate and return its refusal directly. `src/lib/auth/admin-mfa-gate.ts:101` resolves identity, line 118 enforces admin role, and lines 124–125 enforce strict AAL2 without a feature-flag bypass. |
| 5 | `invariants[1]`: detail completes before batch read begins | VERIFIED | Detail route lines 36–41 await detail, return on null, then await the reader. `read-gaps.test.ts:64` defers detail resolution, waits for its start and checks no SQL call before releasing it; it then requires one SQL call and the complete summary. No Promise combinator or new HTTP read chain is introduced. |
| 6 | `invariants[2]`: account from detail, business from request | VERIFIED | Detail route lines 32–33 derive `businessId` from route params; line 41 passes `detail.account.id` and that `businessId`. `business-detail/mappers.ts:283` builds the account ID from `business.account_id`; `business-detail/queries.ts:97` selects the requested business with its joined account. |
| 7 | `invariants[3]`: preserve reader ordering and safe projection | VERIFIED | `src/lib/solicitation/batch-view.ts:938` remains the owner. Lines 978–982 order by live send, built status, then created time and ID. Lines 988–997 construct the closed nine-field admin summary, with timestamps from the text aliases at lines 947–949. The route returns its result unchanged. Existing integration tests explicitly cover older live/newer pending, just-halted/newer pending, and both-unbuilt ordering at lines 835, 901 and 964 of `batch-view.integration.test.ts`; safe keys and absence of message content are checked at line 989. |
| 8 | `invariants[4]`: coupon ID remains server-only | VERIFIED | Options route reduces `betaCompCouponId()` to a null comparison. `src/lib/payments/flags.ts:65` reads the server config, trims the optional string and returns null when unarmed. No public env twin, provider request or new coupon lookup exists. |
| 9 | `invariants[5]`: channels stays separate | VERIFIED | Diff changes no channel handler or caller. The existing `useBusinessDetail.ts:115` keeps its independent channels request. The detail endpoint gains no channel key or channel-service call. |
| 10 | `edge_cases[0]`: missing business is 404, with no batch read | VERIFIED | Detail route lines 37–38 return before line 41. `read-gaps.test.ts:101` asserts exact 404 body and zero SQL calls. A detail rejection also cannot advance past the awaited detail call. |
| 11 | `edge_cases[1]`: missing or mismatched batch scope is null | VERIFIED | Reader predicates repeat account/business in all three count subqueries and the outer selection, lines 951–977; line 986 returns null for no row. New route tests at lines 82 and 91 use wrong account and wrong business with a positive-control fixture. Existing reader integration test at line 1044 checks a foreign account and another location under the correct account, plus a non-null positive control. |
| 12 | `edge_cases[2]`: read failure retains generic 500 | VERIFIED | The additional awaited read remains within the detail route's existing try/catch; lines 44–45 retain the report label, business context and `{ error: 'Failed to fetch business' }`. `read-gaps.test.ts:110` injects a batch SQL rejection and asserts status, exact public error and error-report call. |
| 13 | `edge_cases[3]`: unarmed coupon is false | VERIFIED | Options uses the same expression as `src/app/admin/businesses/new/page.tsx:20`; its unarmed test sets an empty test env value before the accessor's first read. The test resets the config memo in before/after hooks, so a prior armed case cannot supply the result. Accessor normalization also handles absent/whitespace-only values. |
| 14 | `edge_cases[4]`: AAL1 is refused before reading data | VERIFIED | Both routes return gate refusal before their feature reads. Existing detail gate tests at `route.test.ts:257` check 403, exact MFA body, no-store and no detail read. Options test line 69 checks the same refusal and no coupon accessor call. |
| 15 | `test_seams`: real canonical gate with controlled identity | VERIFIED | Options tests mock the gate's dependencies through `makeAdminGateMocks`, not the gate. Existing detail gate tests retain the same real-gate seam. The shared helper derives transport from the request at `admin-gate-mocks.ts:164`; gate source independently confirms enforcement. This proves route integration with controlled identity, not real token verification. |
| 16 | `test_seams`: real batch reader with controlled SQL adapter | VERIFIED | New `read-gaps.test.ts` imports the actual route and leaves the batch reader real; its SQL adapter returns the row only for matching account/business bind pairs. The deferred test therefore observes the new read and real summary mapping. Auth is deliberately stubbed in this composition suite; real-gate tests cover the other seam. |
| 17 | `tests_to_add`: all eleven named cases | VERIFIED | Five new detail composition cases and six options cases exactly cover the locked names. The two existing success cases receive the real DTO's account shape. Existing PATCH cases do not execute the changed GET hunk and need no additional inventory entry for this implementation. |
| 18 | `non_goals` / allowed surface | VERIFIED | Supplied complete diff has 16 production additions and one deletion across the two permitted route files. No pages, impersonation, proxy, gate, channel, migration, flag value, writer, dependency or contract generator changes. Directory and architecture notes describe the actual resulting behavior. |
| 19 | ADR 0025 and ADR 0030 constraints | VERIFIED | No route-specific transport parsing or alternate role/AAL mechanism was added. Both endpoints accept the canonical gate's cookie/bearer behavior and preserve its refusal response. No Admin app token plumbing, MFA challenge, external app variables or fetch seam is changed. |
| 20 | ADR 0028 sequencing / contract-generator non-goal | VERIFIED | This patch delivers the response addition before the declared #1190 generation step. It does not fabricate or hand-maintain the generated contract. See the bounded downstream note below. |

## Actual caller and edge-case assessment

`src/app/admin/businesses/[id]/_hooks/useBusinessDetail.ts:90` parses successful detail JSON without exact-key rejection and consumes the existing fields. Its error path at line 92 still receives the same generic error envelope. It continues requesting channels separately at line 115. The legacy server page at `page.tsx:46` still performs its existing direct reads, with summary at line 60 and separate `initialBatchSummary` at line 95. The patch intentionally does not wire the new API field into that legacy page or change its refresh behavior.

The mapper always includes `account` and derives its ID from the requested business's row. A nullable/missing account property is therefore not a legitimate successful detail DTO requiring a new fallback. The new query may cause a detail request to fail if the batch database read fails; that is the explicit locked generic-500 behavior, not an accidental regression. No transaction or coherent snapshot across detail and summary is promised; the batch's state and counts remain coherent within their existing single SQL statement. Request IDs remain server params, with the same branding and malformed-ID behavior as before.

The options path is explicitly dynamic, computes the same server-authoritative expression as the existing new-business page, and does not depend on browser-supplied eligibility or coupon values. Configuration is shape-only and optional; an unarmed coupon does not require Stripe credentials or a provider call. The new route introduces no coupon-specific exception that could change gate refusals.

## Checklist coverage

Read `docs/reviews/finding-checklists/spec-correctness.md` at the reviewed pin in full. All 41 accepted-finding entries were considered individually below. Numbers are their one-based bullet positions in that pinned file. “Checked” means the general defect class is relevant and no defect was found; “N/A” means the concrete class has no changed surface here.

| Entry | Defect class | Applicability and result |
| --- | --- | --- |
| 1 | Syntax variants escape title guard | N/A: no metadata discovery or parser change. |
| 2 | Exclusion broader than justified | Checked: PATCH-only tests are excluded because their verb and fixture scope are unchanged; the new GET cases remain covered. |
| 3 | Guard inspects unrelated nested metadata | N/A: no metadata or text-scanning guard added. |
| 4 | Test exercises helper rather than promised decision | Checked: exported GET is invoked; detail ordering/response and options gate/accessor run at their intended seams. |
| 5 | Decorative fixture path decoupled from import | Checked: route imports are direct; no path-to-loader table. |
| 6 | Main goal silently excludes a real surface | Checked: both named API gaps are implemented, with legacy page port explicitly excluded. |
| 7 | User copy disagrees with query time anchor | N/A: no metric copy or time-bucketing change. |
| 8 | Hardcoded window breaks another caller | Checked at general caller level: no hardcoded tenant or window; existing caller accepts the additive field. |
| 9 | Null-dependent formula contradicts copy | Checked: no-row summary remains null; no formula or summary reinterpretation in route. |
| 10 | Unconditional claim ignores predicate/flag | Checked: coupon boolean means configured availability through the existing accessor; auth remains unconditional. |
| 11 | Intake edge case neither covered nor explained | Checked: every locked edge case is mapped in the evidence table. |
| 12 | Unsampled intermediate viewport overflow | N/A to source change: no UI/CSS edits; delivery still requires the planned browser regression check. |
| 13 | Accessibility test covers a different node | N/A: no accessibility node or test change. |
| 14 | Relationship assertion proves only self-reference | Checked at test-contract level: response equality checks the composed result; refusal tests assert feature access did not occur. |
| 15 | Comment misidentifies containing block | N/A: no layout comment or containing-block dependency. |
| 16 | Stale evidence line references | Checked: this report cites pinned line numbers; added directory/architecture statements match source. |
| 17 | Shared change regresses omitted third caller | Checked: the summary service is unchanged, existing detail consumer accepts extra JSON and channels remains independent. |
| 18 | Viewport breakpoint differs from container constraint | N/A: no responsive layout changes. |
| 19 | Terminal failure drops adopted announcement invariant | Checked at failure level: batch failure reaches the established catch/report/envelope; no new failure fallback hides it. |
| 20 | Test title overclaims what its environment proves | Checked: tests claim route transport/gate/composition with controlled seams, not live bearer verification or visual rendering. |
| 21 | Refactor alters disabled interaction | N/A: no interaction or CSS refactor. |
| 22 | Evidence harness uses wrong container | N/A: no visual measurement claims in this review. |
| 23 | Partial selector fix exposes conflicting fallback | N/A: no selectors changed. |
| 24 | Recorded measurements/bounds are false | Checked: no new numeric performance or geometric measurements are asserted; gate metrics are attributed to the lead. |
| 25 | Test misses duplicate structural shell | Checked at response level: exact JSON equality rejects nesting, missing old fields and extra option fields. |
| 26 | Harness lacks production styling prerequisite | N/A: no visual harness used; SQL/identity mocks are explicitly bounded. |
| 27 | Very small viewport clipping | N/A: no UI/CSS changes. |
| 28 | Promised comparison never directly asserted | Checked: full detail-plus-summary equality and exact true/false option payloads are directly asserted. |
| 29 | Accessibility edge omitted without deferral | N/A to the locked backend intake; browser delivery evidence remains separate and unclaimed. |
| 30 | Field/unit terminology contradicts derivation | Checked: summary preserves separate cancellable/sending/sent counts and existing field names; no new combined count. |
| 31 | Empty/degraded path yields meaningless value | Checked: missing summary returns null; failed read returns generic error rather than fabricated zero counts. |
| 32 | Empty branch duplicates surrounding disclosure | N/A: no UI empty-state copy. |
| 33 | Deferred fix justified by false real-world premise | Checked: no batch ordering reimplementation; existing owner service handles the actual older-live/newer-pending scenario. |
| 34 | Old test exclusion obsolete after final change | Checked: the changed GET fixtures and five GET gate cases remain in inventory; PATCH behavior stays untouched. |
| 35 | Architecture ledger cites moved lines | Checked: added architecture trace contains no stale line citation and describes current source. |
| 36 | Handoff claims obsolete phase/completion state | Checked: pinned plan and inventory describe future review/delivery work, not completed staging or merge. |
| 37 | Fixture silently replaces intended scope | Checked: wrong-account fixture changes account ID; wrong-business request/fixture changes business ID; SQL positive control establishes the valid pair. |
| 38 | Count-only assertion misses wrong retained item | Checked: exact summary equality includes batch ID, state, timestamps and all three counts; existing service tests own batch-selection ordering. |
| 39 | Test couples contract to incidental count | Checked: single SQL call encodes the locked existing-reader composition; exact option key count is the explicit closed response contract. No incidental UI count asserted. |
| 40 | Non-singular assertion permits duplicate disclosure | Checked at response level: exact JSON equality disallows extra wrapper/fields. |
| 41 | SQL NULL semantics discard retained attribution | N/A: no SQL predicate is added or changed; the reused summary query's nullable lifecycle ordering uses explicit IS NULL/IS NOT NULL. |

## Bounded observations and verification limits

No uncertain observation is being promoted to an actionable finding. One downstream integration point should remain visible: `BusinessDetailResponse` in `src/lib/admin/business-detail-types.ts:213` still describes the existing service DTO, and options has no exported response DTO. That does not break the implemented JSON endpoints or present in-repo caller. The locked #1190 work must describe the composed detail response and options response when generating ADR 0028's contract; exporting only the old service interface would omit the newly added field. Creating that contract here is explicitly outside this intake.

I did not run or rerun tests, the build, browser checks, mutation cases or staging calls. The lead reports the frozen gate GREEN with 14,665 passing tests and 1,184 environmental skips, plus a previously passing build at unchanged implementation. Those are inherited verification results, not independently reproduced results from this review. Existing live-DB reader tests were inspected as coverage evidence; their presence is not a claim that they ran in an environment with a database. Browser target, desktop/mobile journey and sanitized screenshot evidence remain the planned delivery verification; source approval does not assert them completed. Merge and deploy authorization remain outside this report.

Suite: lead-reported full gate GREEN (14,665 passed; 1,184 environmental skips); build lead-reported PASS at unchanged implementation. Reviewer execution: none, per assignment.

VERDICT: PASS — all locked implementation items verified against the frozen source; no actionable spec/correctness finding. Delivery/browser verification remains outside this source-review verdict.

APPROVED
<!-- END 1189-REPORT-0 -->

</details>

<details>
<summary>Standards and maintainability review — complete verbatim report</summary>

Source: /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1189/.feature/review-staging/standards-maintainability.md

SHA-256: 9095f2734f064a7db5d126945a8b49f9d80d44ecb1614b87429d72dc48c5698d

<!-- BEGIN 1189-REPORT-1 -->
# Independent standards and maintainability review — #1189

Reviewer ID: `/root/feature_1189/maintainability`

Verdict: **APPROVED**

Fixed base: `c951bc2ebbafba310cc35f11f6e06fc5d8b57414`

Fixed reviewed HEAD: `bf84c855b947f0cd4c8587b880968cacb7b7caa9`

Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1189`

Production churn supplied by the lead: **17 lines, 16 additions and 1 deletion**, across the business detail and business options route files; tests excluded. This review is mandatory because the intake marks admin authorization and tenant-scoped reads high risk despite the small change.

## Scope and evidence

This is an independent, read-only source judgment. I reviewed the approved intake, plan, ADR 0027, scoped rules and pinned diff in `/private/tmp/1189-review-brief.md`. Additional source inspection used only `git show bf84c855b947f0cd4c8587b880968cacb7b7caa9:<path>`, including the authoritative project/context instructions, the maintainability checklist, both legacy page precedents, the business detail service, the existing batch projection, coupon/config accessors, canonical admin gate, and existing detail-route gate tests. No source changes, tests, builds, network requests, subagents or commits were performed. The only write is this designated staging report.

The full review gate and separate build are GREEN as supplied by the lead; I did not independently rerun or reinterpret those results. Green-tool-enforced style and import nits were excluded absent circumvention. No circumvention was found. No conclusions from another current review axis were used.

## Actionable findings

**None at or above 80% confidence.** There is no supported severity/file/standard/failure/correction tuple to report. Approval is limited to the pinned source and this review axis; it does not claim browser, staging, mutation or runtime verification.

## Standards assessment

| Area | Assessment and evidence |
| --- | --- |
| Locality and ownership | The detail change is adjacent to the existing null guard and return. `src/app/api/admin/businesses/[id]/route.ts:36` awaits the existing detail service; lines 41–43 add the documented sequential call and response composition. Batch selection, projection and lifecycle logic remain in `readAdminBatchSummary`. No unrelated service or page is changed. |
| Entry-point seam and module depth | CLAUDE invariant 12 and ADR 0027 D1 explicitly permit this two-service composition. The route passes its existing `sql` client and resolved account scope into the existing deep domain function; no shallow wrapper or alternate batch DTO is introduced. A generic literal reading of “call one module function” does not override the accepted ADR's specific two-call design. |
| Duplication | The legacy page and API are separate composition roots using the same service functions. Their short orchestration does not duplicate the query or projection. The options endpoint repeats the existing page's one boolean expression through its authoritative accessor; there is no duplicate env parser or registry. |
| Speculative generality | The only new production file is the 12-line route required by ADR 0027 D2. The deliberately broad route name `options` is the ADR's expressly allowed abstraction. No premature option registry, contract generator, generalized wrapper, helper module or client framework appears. |
| Explicit dependencies | Both database reads receive the same explicit client, satisfying invariant 15. The new import points at the established projection. Options adds only imports of the existing gate and flag accessor. No package, schema, writer or runtime service dependency is added. |
| Pool/read sequencing | The added await is after `getBusinessDetail` resolves and after its null guard. ADR 0027's pool constraint is stated in the local comment. The implementation adds no third HTTP path and leaves channels separate. The deferred-promise test makes an early batch read observable. |
| Scope and domain naming | The batch call uses `detail.account.id` and the requested `businessId`, matching the existing page and account/location vocabulary. `batchSummary` and `betaCompActive` exactly match the accepted contract. Account IDs are not confused with admin IDs or business IDs. |
| Failure behavior | Detail retains the existing generic 500/reporting boundary; a batch failure reaches that same catch instead of silently returning partial success. Missing detail remains 404 without a batch read. Options returns the canonical gate response directly, preserving refusal status/body/headers. No large error branch, swallowed error or parallel retry mechanism is added. |
| Server authority | Options reads `betaCompCouponId()` only after the canonical AAL2 gate and serializes only the boolean comparison with null. It exposes neither the coupon identifier nor an env twin, preserving invariant 13 and ADR 0027 D2. |
| Test seams and coupling | New detail tests run the real batch reader with controlled SQL and independent expected projection data. They distinguish the account and business IDs and cover null/error paths. Positional SQL binding checks follow the existing reader's account/business-pair seam and do not copy query text. A single SQL call assertion matches the reader's documented one-statement state/count consistency contract. Options runs the real gate/accessor with the established shared identity mock helper and resets server config/env state. Existing gate tests continue to own detail authentication behavior, so the focused read-gap suite's successful gate stub does not remove that coverage. |
| Test oracle quality | `SUMMARY` is independently written from known fixture facts and checked through exact response equality; it is not calculated by the production mapper. Representative pre-existing detail fields survive the same equality check. `toHaveBeenCalledOnce` accompanies positive response assertions; refusal cases also prove no coupon read. No probabilistic sampling, source-string oracle or runtime self-comparison is introduced. |
| Documentation and precedents | The plan names both existing page precedents and the shared auth fixture. Directory rows describe the actual GET/PATCH exports and new options shape; removing the old DELETE claim matches the pinned route. The new architecture row accurately describes reused query/service ownership. Its “no new database query” refers to no newly defined query, consistent with the explicitly described additional call to an existing read. No new source-line citation in these changed implementation descriptions can drift. |
| ADR compatibility | D1's sequential detail-plus-batch response and separate channels route, and D2's gated one-field options response, are implemented directly. No page retirement, impersonation, gate/proxy redesign, migration, flag flip or contract generation crosses the approved non-goals. Existing transport verification remains owned by the canonical gate. |

## Complete accepted-finding checklist coverage

All **26 entries**, in the order present at the pinned HEAD in `docs/reviews/finding-checklists/standards-maintainability.md`, were assessed. “Not applicable” means the triggering mechanism is absent from this diff, not that the entry was skipped.

| # | Accepted defect class | Result for this change |
| --- | --- | --- |
| 1 | Probabilistic property test misses singleton witness | Not applicable: new cases are deterministic, and sequencing uses an explicitly controlled promise. No sampled property generator is added. |
| 2 | Load-bearing plan/arch reference exists only untracked | Clear: implementation references point to the supplied tracked ADR/plan or existing pinned service/page/helper symbols. Temporary review staging is explicitly an evidence workflow, not the authority for route behavior. |
| 3 | Diagnostic signpost misstates compiler error paths | Not applicable: no compiler diagnostic or type-assertion guidance is added. |
| 4 | Unsupported false-green probability arithmetic | Not applicable: no probability or mutation detection percentage is claimed in the production/test changes. Runtime measurement remains outside this source review. |
| 5 | New architecture row cites shifted line numbers | Clear: the new row uses the ADR, behavior and function name without fork-relative line numbers. |
| 6 | Duplicated test promises two distinctions but asserts one | Clear: read composition, scope negatives, missing detail and failure each have distinct behavioral assertions. Options positive and refusal tests assert their named outcomes. |
| 7 | Stale counts in new comments or architecture prose | Clear: the local sequencing comment's pool value is the supplied ADR constraint. No new asserted source-line, assertion-count or executable-line arithmetic is added to implementation prose. |
| 8 | Established precedent unnamed; departure unexplained | Clear: the plan explicitly identifies existing detail/new-business pages and the shared admin gate helper. The route follows those precedents and the specific ADR. |
| 9 | Green tool result used to infer unmeasured suppression removal | Not applicable: no suppression removal or evidence-based claim about an unrun variant is introduced. Supplied gate results are treated only as gate results. |
| 10 | Anti-vacuity comment attributes guarantee to wrong TS mechanism | Not applicable: no new `as const`/`satisfies` or compile-time totality assertion. |
| 11 | Oracle and result derive from same filtered collection | Clear: expected JSON is independently specified. The batch summary is not generated by the function under review, and booleans are asserted as literals. |
| 12 | Further fork-relative plan source citations drift | Clear: this ticket's T1/T2 implementation and test instructions use paths/symbols rather than source-line numbers. Historical line references inside unchanged ADR context are not new claims. |
| 13 | Docblock credits `as const satisfies` incorrectly | Not applicable: no such type-level docblock or mechanism is added. |
| 14 | Hover panel unreachable across trigger/panel gap | Not applicable: no hover interaction, DOM or presentation change. |
| 15 | Existing hook reimplemented with divergent predicate | Clear: no hook is added; analogous server predicates reuse `betaCompCouponId` and `readAdminBatchSummary`. |
| 16 | Focus ring fails contrast on inverted surface | Not applicable: no CSS, component or focus styling change. |
| 17 | Mouse-only outside dismissal fails touch input | Not applicable: no event handling is changed. |
| 18 | Directory claims markup/accessibility structure absent in code | Clear: changed directory rows describe route composition and response shape, which match the pinned exports. No markup claims are added. |
| 19 | CSS transition cannot run despite reduced-motion override | Not applicable: no CSS or motion is added. |
| 20 | Test asserts irrelevant DOM sibling adjacency | Not applicable to DOM; analogous review clear: the new ordering assertion is required by the explicit pool/sequencing contract, not incidental layout or private structure. |
| 21 | Negative assertions depend on private text without positive oracle | Clear: refusal tests assert exact status/body and no read; success tests positively assert the output. No private source/text string is the sole detector. |
| 22 | Arithmetic/copy test hardcodes the governing arithmetic | Not applicable: no shared business arithmetic or formatted-copy logic changes. Fixed summary counts are controlled input facts for projection testing, not a second formula. |
| 23 | CSS comment states false positioning mechanism/magic offset | Not applicable: no geometry, CSS positioning comment or layout constant is added. |
| 24 | Host class distant from siblings and misleadingly named | Not applicable to CSS; locality/naming clear for the route additions, which remain in their business API family. |
| 25 | Several mechanisms perform same task without selection rule | Clear: both routes use the canonical gate; batch and flag reads have one existing owner each. ADR 0027 explains why batch folds onto detail and options stays its own route. |
| 26 | Verifier count fails to bind original inventory identities | Not applicable to production diff: no verifier implementation or inventory-identity enforcement changes. This source review does not certify the later mutation execution; that is the independent verifier's responsibility. |

## Separate speculative appendix

No speculative finding is promoted to a correction request. Two potential concerns were evaluated and rejected as unsupported here:

- Extracting the route's two calls into another service would add a shallow abstraction contrary to ADR 0027's explicit composition-root design; it would not remove duplicated domain behavior.
- Adding a catch around the options accessor solely because malformed server configuration can theoretically throw would invent an error contract not required by this intake. The accessor already owns configuration interpretation, the canonical gate owns auth failures, and no concrete changed-path defect requiring a new wrapper was established. This is not a claim that configuration parsing cannot fail.

The SQL adapter in the focused read-gap tests is a route/service seam, not a substitute for real-database tenant proof. Its role is to make passing incorrect account/business arguments observable while retaining the real projection. This limitation does not justify rewriting the tests or duplicating the existing query's tests in this ticket.

## Integrity

SHA-256 of the report body above, ending with the newline after the preceding paragraph and excluding the blank separator and this Integrity section: `4e856e004e71bd8571e1a27e5fcfeeb5927802de14aef7c1eca674a05095cf89`.

The complete staged-file SHA-256 is supplied separately in the reviewer handoff to avoid a self-referential file hash.
<!-- END 1189-REPORT-1 -->

</details>

<details>
<summary>Security and tenant-boundary review — complete verbatim report</summary>

Source: /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1189/.feature/review-staging/security.md

SHA-256: fd95207038701e1a05592db1c250a214e6d9facb5dc4d29a2b0c1b8a072e49c7

<!-- BEGIN 1189-REPORT-2 -->
# #1189 independent security and authorization review

Status: COMPLETE
Verdict: APPROVED
Reviewer ID: `/root/feature_1189/security`
Review axis: security, authorization, and tenant boundaries
Review date: 2026-09-10
Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1189`
Fixed base / fork / merge base: `c951bc2ebbafba310cc35f11f6e06fc5d8b57414`
Fixed reviewed HEAD: `bf84c855b947f0cd4c8587b880968cacb7b7caa9`
Production churn: 16 additions + 1 deletion = 17 lines across two route files; tests excluded.
Full-file integrity: the SHA-256 of this complete staged file is reported in the reviewer's completion message, outside these bytes to avoid a self-referential digest.

## Scope and independence

I reviewed the supplied approved intake, plan, ADR 0027, scoped rules, and pinned diff in `/private/tmp/1189-review-brief.md`. All source follow-up inspection used `git show` against the exact reviewed HEAD, not the mutable worktree. Follow-up inspection traced the canonical gate, identity resolution, app-user lookup, business-detail query/service/mapper, batch projection, coupon accessor, and route tests. ADRs 0025, 0028, and 0030 were also read for the surrounding authorization and contract decisions. I did not read another review axis's conclusions or the temporary staging verifier review, execute tests, access the network, spawn agents, commit, or edit source. The complete review gate and separate build were reported GREEN by the lead; this review does not independently claim those executions or browser verification.

`docs/reviews/finding-checklists/security.md` does not exist at the pinned HEAD and was also absent from the worktree. There were therefore no repository checklist entries to omit. The complete relevant checklist below supplies explicit assessments instead. `pnpm agent:rules .feature/review-staging/security.md` returned `none` before this report was written.

## Findings

No actionable security, authorization, or tenant-boundary defect reached the required 80% confidence threshold. No correction is requested.

## Checklist assessment

| Check | Assessment and evidence at the reviewed HEAD |
| --- | --- |
| Authentication before protected reads | PASS. `src/app/api/admin/businesses/[id]/route.ts:29-30` awaits the canonical gate and returns its refusal before parsing scope or calling the detail/batch services. `src/app/api/admin/businesses/options/route.ts:8-9` does the same before the coupon accessor. Merely importing the accessor does not read its value; the read is inside `betaCompCouponId()` (`src/lib/payments/flags.ts:65-67`). |
| Live identity and server-owned role | PASS. `src/lib/auth/admin-mfa-gate.ts:101-118` resolves identity, calls `loadAppUser(identity.authUserId)`, and requires the DB role to equal `admin`. `src/lib/db/auth.ts:87-117` maps through `users.auth_id` using a parameterized query. Neither route accepts a role or actor identity from its request. |
| Strict MFA on cookie and bearer transports | PASS. The same gate rejects null assurance as `mfa_check_failed` and every non-`aal2` value as `mfa_required` (`admin-mfa-gate.ts:124-125`). No flag or proxy result bypasses this decision. Cookie identity uses `getUser()` and the cookie client's assurance result (`src/lib/auth/verified-identity.ts:138-155`); bearer identity verifies claims, checks expiry, and checks the same token through `getUser()` (`:172-226`). The routes introduce no alternate authentication branch. |
| Malformed bearer, cookie fallback, and credential precedence | PASS. `src/lib/auth/admin-transport.ts:35-36` chooses bearer mode whenever Authorization is present, and `:49-54` parses its token separately. `verified-identity.ts:239-244` delegates exclusively to one transport. An invalid bearer beside a valid cookie cannot gain cookie authority. New options inherits this behavior by calling the canonical gate. |
| Refusal and auth-service failure paths | PASS. `admin-mfa-gate.ts:93-95,105,109-125` produces the existing 401/403/500 responses with no-store/private headers. Both routes return `gate.response` directly, preserving the status, body, and headers. No refusal path reaches the newly exposed data. Existing cookie fault classification is unchanged. |
| Tenant account provenance and confused deputy | PASS. The request supplies the business ID; it supplies no account ID. `src/lib/admin/business-detail/queries.ts:97-109` obtains `b.account_id` from the matching persisted business joined to its account. `src/lib/admin/business-detail/mappers.ts:283-289,319` exposes that value as `detail.account.id`. The changed route uses that exact ID plus the requested business ID (`businesses/[id]/route.ts:41`). It does not substitute the admin's own account or a client-selected tenant. Admin access to different businesses is the intended control-plane capability. |
| Batch and correlated child tenant boundaries | PASS. `src/lib/solicitation/batch-view.ts:943-984` binds both account and business on the selected batch (`:976-977`) and each of the three outreach count blocks (`:954-956,962-964,970-972`), with counts correlated to the selected batch ID. Empty or mismatched scope returns null (`:986`). The new caller preserves both required arguments. |
| Data minimization and sensitive content | PASS. `batch-view.ts:862-875,988-998` defines and constructs a closed nine-field admin summary: batch ID/state, three timestamps, halt reason, and three counts. The route returns this safe projection, not owner attempts, rendered subject/body, recipient addresses, raw outreach rows, or tokens. Existing detail fields are preserved by spreading the existing DTO. |
| Coupon secrecy and authoritative availability | PASS. `businesses/options/route.ts:11` returns exactly one boolean, `betaCompCouponId() !== null`. It does not return the coupon string, server config, a public environment twin, or a client-provided value. `payments/flags.ts:65-67` trims the server-config value and collapses missing/empty input to null. Reading availability grants no checkout capability and changes no durable checkout snapshot. |
| SQL injection and request input | PASS. The new route composition adds no SQL or dynamic query construction. The unchanged helper binds both IDs through tagged SQL parameters with UUID casts. Malformed identifiers cannot become SQL text. The account value is DB-derived. Existing malformed-business behavior is outside the changed logic and does not permit protected reads without authorization. |
| Missing resources and data-read failures | PASS. `businesses/[id]/route.ts:36-38` stops on missing detail before the batch call. Batch null is returned as null, not replaced by a different tenant's data. A thrown batch read is caught by the existing `:43-45` handler, which sends only `Failed to fetch business`; the new data does not escape in an error body. |
| CSRF, CORS, redirects, and proxy trust | PASS for this change. Both affected behaviors are reads; no mutation or same-origin exemption is introduced. No proxy or CORS policy is edited. The route gate independently authenticates and authorizes both transports, including bearer requests passed through by the existing proxy. No new redirect or external URL consumes request data. ADR 0025's gate boundary remains intact. |
| Cache and cross-request disclosure | PASS within inspected source scope. Both routes declare `force-dynamic` and add no shared cache or module-level data capture. Refusals retain the canonical no-store/private headers. This read-only source review does not independently measure deployed CDN headers or browser behavior. |
| Availability and pool fan-out | PASS. The route awaits `getBusinessDetail`, checks for null, then awaits one existing batch-summary statement (`:36-41`); it creates no Promise combinator or third HTTP read path. The helper returns one selected summary using `LIMIT 1`. Channels remains separate as ADR 0027 requires. |
| Side effects, privilege expansion, and infrastructure | PASS / NOT APPLICABLE where absent. There are no new writes, migrations, RLS policies, grants, dependencies, provider calls, impersonation changes, secret exports, shell operations, uploads, or webhook/token-verification paths in the production diff. The options read cannot arm a coupon or perform billing work. |
| Relevant security test coverage | PASS by source inspection, with execution delegated. The existing detail GET gate cases cover cookie/bearer AAL2 success and AAL1/non-admin/unauthenticated refusal before detail reads. New options tests exercise the real canonical gate with controlled identity, both boolean values, bearer success, and refusals before coupon access, including no-store. New detail tests use the real batch reader with a controlled SQL adapter to check ordering, complete projection, wrong account/business, missing detail, and generic read failure. These are route/composition tests and do not independently prove live authentication or SQL behavior. |
| ADR contract and Admin app trust | PASS. ADR 0027 D1/D2 explicitly authorize the two responses and require canonical AAL2 plus sequential composition and coupon minimization. ADR 0028's contract generator is later work, expressly excluded from this intake. ADR 0030 keeps the Admin app's chrome/role hints non-authoritative; these routes continue to enforce role and session assurance server-side and require no new Admin app secret. |

## Uncertain or informational appendix

No unresolved candidate defect is being promoted to a finding. Live staging/browser behavior, real authentication provider behavior, and deployment cache headers were not exercised by this source-only reviewer. The inspection establishes that this small composition change correctly uses the existing security boundaries; it does not recertify the complete pre-existing authentication infrastructure. ADR 0025's documented stale-AAL-token limitation is inherited and unchanged, not a newly introduced finding.

Final disposition: APPROVED for the pinned source change on the security/authorization axis. Zero actionable findings; no source fix or security re-review trigger identified.
<!-- END 1189-REPORT-2 -->

</details>

<details>
<summary>Initial auxiliary helper security review — complete verbatim report</summary>

Source: /private/tmp/1189-helper-security-review.md

SHA-256: fcb3c6da46b7e869e913e21bc5e9c67d32962dd8b47bbe1a55c4fa8b5d6120f2

<!-- BEGIN 1189-REPORT-3 -->
# Independent security review — temporary #1189 staging GET helper

Verdict: **REVISE**.

Reviewed artifact: `/private/tmp/1189-staging-get-verifier.mjs`, lines 1–362.

Exact SHA-256, independently read with `shasum -a 256` before SDK inspection and again after inspection: `91f1cafb790a12398fe8825eacf70a4b3cd2e78525b181d6ab7b36b06d23b691`. Both results match the requested pin. This verdict binds only those bytes and the installed dependency versions inspected below. The helper was not executed, imported, syntax-tested, modified, or used for authentication. No network/login request, credential inspection, browser session extraction, or test run was performed. Only this report was written.

## Required revisions

### F1 — P2: The PASS predicate accepts values outside the pinned batch-summary contract

Helper lines 235–238 check only that `batchState` is a string and `haltReason` is null or a string; line 239 labels this `batchSummary schema valid`, and line 246 includes it in PASS. At implementation pin `bf84c855b947f0cd4c8587b880968cacb7b7caa9`, `src/lib/solicitation/batch-view.ts:862` declares `batchState: BatchState` and `haltReason: HaltReason | null`. `src/lib/solicitation/outreach.ts:99–109` limits BatchState to `halted`, `closed`, `sending`, `veto_window`, `approved`, `expired`, `built`, `pending`; `src/lib/solicitation/batch-view.ts:165–171` limits HaltReason to `owner_veto`, `owner_halt`, `admin_halt`, `send_window_elapsed`, `batch_expired`, `platform_halt`.

Concrete failure: a regressed deployment returns a nine-field summary with a valid UUID, nonnegative integer counts, nullable string timestamps, `batchState: "not_a_state"`, and `haltReason: "not_a_reason"`. All the helper's summary checks pass, and otherwise valid options/detail/missing responses produce PASS despite violating the pinned DTO contract. This is an evidence-integrity defect, not a demonstrated credential leak.

Revision: use fixed local allowlists copied from the pinned definitions for both fields; keep output boolean-only. This needs no extra API request and no import of feature code. Alternatively explicitly downgrade the displayed assertion and overall verdict to a primitive-shape smoke result, but do not present it as validation of the pinned schema.

### F2 — P2: SDK success is insufficient evidence that session cleanup was confirmed

Helper lines 249–253 translate `client.auth.signOut({ scope: 'local' })` returning `error: null` directly into cleanup success. Lines 287–289, 302–304, and 347–350 expose that result as local sign-out completed, and shutdown sets a successful exit code from it. The installed Auth SDK's `src/GoTrueClient.ts:3791–3828` returns success when there is no locally stored session and also suppresses logout HTTP 401/403/404 errors. Therefore this boolean does not establish that the helper's logout request completed successfully.

Concrete failure: Auth accepts the password grant and creates a helper session, but the connection fails or the eight-minute shutdown aborts the request before the helper receives/stores the token (helper lines 115–124, 264–266, 343). Cleanup finds no SDK session, sends no logout request, and returns true. The flow correctly remains NOT VERIFIED, but the displayed cleanup claim and later successful process exit incorrectly imply confirmed cleanup. A logout response with HTTP 403 also becomes SDK success without demonstrating successful remote revocation. These are source-supported ambiguity scenarios; this review did not cause or observe a remote session leak.

Revision: track a sanitized cleanup outcome independently of SDK `error: null`: whether a session-creating request was attempted, whether its response was unambiguously received, and whether an allowed local logout received successful HTTP status. Distinguish no session attempted, confirmed local logout, and cleanup unconfirmed. Preserve unconfirmed status through subsequent no-op `signOut` calls and shutdown; do not allow a later no-session SDK success to erase uncertainty. Keep using explicit SDK `scope: 'local'`, keep all output sanitized, and do not broaden the request allowlist, use a service-role key, or sign out other sessions. A lost session response cannot be recovered under this contract; accurate reporting is the required correction.

## Controls inspected and found consistent with the authorization boundary

- Fixed origins, three paths, account, designated business, missing UUID and implementation pin are literal constants at lines 17–24. Only the designated detail response's business/account IDs are compared, never displayed (229–230). The missing-ID absence and deployment pin are intentionally external preconditions (2, 158), not purportedly discovered by this helper.
- Lines 33–48 accept publishable-format keys or a legacy JWT with anon role and the fixed staging ref, reject ordinary service-role keys, and never print key values. JWT decoding here classifies configuration; it is not cryptographic validation. The fixed Auth service validates the actual key.
- Auth fetch lines 99–125 limit origin, exact method/path/query, factor UUID, phase, and logout scope. Redirects are refused; unknown SDK calls, refresh, enrollment, reset and Data API paths fail before fetch. The response body is bounded and time-limited, provider error bodies are replaced, and provider headers/cookies are stripped before the SDK sees the response.
- API fetch lines 193–214 uses three fixed sequential GETs, no redirects or cookies, explicit 15-second cancellation, a 2 MiB body limit, and only locally created bearer tokens. `runGets` has no loop/retry or input-driven API destination. It does not expose raw DTOs, customer strings, provider errors, token values, or factor names/IDs. Dynamic displayed values are fixed labels, integer statuses, booleans or the literal not-applicable text, with HTML escaping at 158 and 132–134.
- Loopback listen is IPv4 `127.0.0.1` with an ephemeral port (358–361); no requests can be accepted until the listen callback has assigned the expected Host/Origin. Host/Origin validation rejects duplicate headers and requires exact Origin on POST (161–167, 313–318). Fetch-site checks, a 256-bit one-use nonce, strict body field count, body cap and content type, CSP frame/form restrictions, no-store and no-referrer headers constrain browser CSRF and exfiltration (136–190).
- The busy flag is acquired synchronously before asynchronous body processing; concurrent requests cannot start another login/MFA/API sequence (319–327). Wrong credentials/MFA fail closed into the result phase. No arbitrary operation is accepted via forms. GETs while busy do not expose a partially constructed result.
- TTL/shutdown sets stopping before aborting controllers, stops new connections, destroys existing connections, waits for the in-flight flow, and then attempts explicit local cleanup (338–353). A flow that catches an abort can still perform bounded cleanup because only local logout is allowed while stopping. Shutdown is idempotent. Its completion can exceed eight minutes by the bounded cleanup requests; the TTL stops new verification work rather than constituting an exact process-exit deadline. This is not an uncontrolled verification retry.

## Installed dependency provenance and actual call-path inspection

The helper header's 2.106.2 version claims were checked, not assumed. The worktree's `node_modules/@supabase/supabase-js` is a symlink to `.pnpm/@supabase+supabase-js@2.106.2/node_modules/@supabase/supabase-js`; its package.json declares version 2.106.2, CommonJS export `dist/index.cjs`, and Auth dependency exactly 2.106.2. Its dependency symlink resolves to `.pnpm/@supabase+auth-js@2.106.2/node_modules/@supabase/auth-js`, whose package.json declares version 2.106.2 and `dist/main/index.js`. The CommonJS bundle imports `@supabase/auth-js` at line 42. Corresponding compiled Auth paths were read/searched to corroborate source behavior; no package was loaded into a runtime.

Under that installed Auth package:

- `src/GoTrueClient.ts:423–440`: `persistSession: false` creates an SDK-owned memory adapter; no browser storage or broadcast channel is attached.
- `src/GoTrueClient.ts:1087–1148`: password sign-in uses POST `/token?grant_type=password` and saves only the returned session.
- `src/GoTrueClient.ts:5427–5458`: factor listing calls `getUser()` and filters the returned factors; no enrollment occurs. The helper further accepts only verified TOTP factors and UUID IDs.
- `src/GoTrueClient.ts:5237–5314`, `5324–5407`: challenge and verify use the current helper session with POST to the selected factor endpoints; verify stores the returned session in the same memory adapter.
- `src/GoTrueClient.ts:2790–2892`: session access may attempt a refresh when close to expiry even with auto-refresh disabled. The helper's adapter blocks that request before network access. This can fail verification/cleanup rather than silently broadening authority.
- `src/GoTrueClient.ts:5041–5051`: `autoRefreshToken: false` prevents the nonbrowser refresh ticker. Startup recovery sees only the fresh empty memory adapter.
- `src/GoTrueAdminApi.ts:150–167`: explicit local sign-out constructs `/logout?scope=local`. `src/GoTrueClient.ts:3791–3828` explains finding F2.
- `src/lib/fetch.ts:215–230` logs thrown fetch exceptions. The helper catches transport failures and returns sanitized Responses instead, preventing that normal network-error path from logging provider request/error objects.
- Supabase client `src/SupabaseClient.ts:635–658` installs its own auth subscriber and updates its SDK-owned Realtime token state. Realtime `src/RealtimeClient.ts:624–669` updates tokens on existing channels; this helper never opens a channel or socket. The subscriber receives source CLIENT, so the SDK's STORAGE-only default sign-out branch is not reached. Tokens remain within the helper-created SDK client and request-processing memory.

## Uncertain observations and evidence limits (separate from required revisions)

- The missing-business assertion checks status 404 only (242–246). An infrastructure/router-generated HTML 404 would satisfy it. If route-level missing-record behavior is needed as evidence, add a private check for JSON and the fixed expected error schema, exposing only a boolean; otherwise describe this precisely as HTTP status evidence. This does not affect the already fixed destination/ID authorization.
- Existing detail validation deliberately verifies top-level keys/types and ID matches; it does not validate every nested customer field or array element. A null summary proves field presence and nullability only, not the non-null branch. Do not extend the resulting evidence beyond those checks.
- Loopback Host/Origin/nonce controls defend against ordinary browser-origin attacks. They do not authenticate an adversarial native process on the same machine, which can fetch the nonce and forge headers. No native-process compromise was assumed or inspected.
- JavaScript strings and SDK memory are garbage-collected; buffer wiping and deleting form parameters reduce retention but do not guarantee zeroization. The code does not persist them or intentionally log them.
- Dependency versions and the inspected installed source/call paths were checked locally; npm registry signatures, package integrity, host environment instrumentation, and operating-system/browser compromise were outside this source-only review. Revalidate the helper hash and prevent dependency replacement before any authorized execution.
- This report is not authorization to execute or log in. The lead must triage the revisions and obtain a fresh independent verdict bound to changed bytes. Main feature gates, browser regression, and #1197 Gate B/D9 remain separate.
<!-- END 1189-REPORT-3 -->

</details>

<details>
<summary>Auxiliary helper verification review — complete verbatim report</summary>

Source: /private/tmp/1189-helper-security-verification.md

SHA-256: 9c6e2603ee6bfd3060bad418538f412c4174d22b49dbf59303ad660c7ae68cbe

<!-- BEGIN 1189-REPORT-4 -->
# Verification-only security re-review — #1189 staging GET helper

Verdict: **APPROVED** for the specified temporary helper's source-level security review. Prior findings F1 and F2 are resolved. No new actionable security finding was identified in the revised bytes.

Artifact: `/private/tmp/1189-staging-get-verifier.mjs`, all 413 lines read directly.

Exact independently verified SHA-256: `6d851b260755e45527eed807bd759246d4cef0b165bf0f9bc0981b1ddf356361`. `shasum -a 256` returned this hash at the start and again after inspection. Approval binds these exact bytes and the installed SDK inspected; any subsequent helper change requires a fresh binding.

This is a verification-only follow-up to `/private/tmp/1189-helper-security-review.md`, which remains unmodified. The helper was not executed, imported, syntax-tested, modified, or used for authentication. No network or login requests, credential inspection, browser/session extraction, or tests were performed. Only this new report was written.

## F1 verification — resolved

The helper's fixed `BATCH_STATES` and `HALT_REASONS` at lines 26–27 exactly match the authoritative definitions at implementation pin `bf84c855b947f0cd4c8587b880968cacb7b7caa9`:

- `src/lib/solicitation/outreach.ts:99–109`: halted, closed, sending, veto_window, approved, expired, built, pending.
- `src/lib/solicitation/batch-view.ts:165–171`: owner_veto, owner_halt, admin_halt, send_window_elapsed, batch_expired, platform_halt.

Both definitions were reread with `git show` at that pin. Helper lines 258–259 now use membership checks, with null permitted only for haltReason. The exact nine-field check, UUID check, nullable string timestamp checks and nonnegative safe-integer count checks remain at 256–262. Summary validity still participates in overall PASS at 272. The prior counterexample with arbitrary state/reason strings therefore fails by direct inspection. No feature-code import or new outbound request was introduced.

## F2 verification — resolved

The revised helper separates SDK return values from transport evidence:

- Lines 71–79 retain only boolean evidence for password/MFA attempts, full responses, accepted sessions and successful local logout HTTP completion.
- Lines 130–135 validate the fixed destination/allowlist before marking an attempted session-issuing request. A password or MFA verify attempt clears any older logout confirmation before fetch.
- Lines 136–141 require bounded full response receipt; a local logout is confirmed only after the body completes and HTTP `response.ok` succeeds. HTTP 401/403/404 cannot set this flag.
- Lines 314 and 333 record session acceptance only after the respective SDK method returns a usable session/token without error. If the method throws, the initial false value remains.
- Lines 275–281 distinguish no session attempted, confirmed local logout, and cleanup unconfirmed. Confirmation requires known password-session acceptance, known MFA-session acceptance when MFA was attempted, and successful HTTP logout evidence.
- Lines 297–301 retain explicit `signOut({ scope: 'local' })`; SDK success or failure cannot substitute for HTTP evidence. Later SDK no-op success cannot make an unknown session-issuing response known.
- Lines 337–339 require confirmed local logout for PASS. The error path forces NOT VERIFIED at 352–356. Shutdown reports the same outcome after awaiting the flow, and uses exit code 1 for cleanup unconfirmed (397–401).

Source-only scenario analysis:

| Scenario | Result under revised logic |
| --- | --- |
| Close/TTL before any session-issuing fetch | no session attempted; no remote logout claimed |
| Password request transmitted, response lost or aborted | attempted true, response/session acceptance false; cleanup unconfirmed even if SDK sign-out is a no-op |
| Password accepted, factor lookup/challenge fails, local logout receives success | confirmed local logout for the known helper session; flow remains NOT VERIFIED |
| MFA verify transmitted, response lost or rejected | MFA acceptance remains false; cleanup unconfirmed even if an older token's logout succeeds |
| Logout receives 401/403/404 and SDK suppresses the error | HTTP confirmation remains false; cleanup unconfirmed, including later no-op sign-out |
| Logout transport initially fails, then shutdown successfully logs out the known session | confirmation may become true from new successful HTTP evidence; this is resolution of transport uncertainty, not an SDK no-op |
| Successful verification and successful local logout followed by another no-op cleanup | prior successful HTTP evidence remains valid; no new session can be created in result phase |

Installed SDK provenance was reconfirmed from package metadata: `@supabase/supabase-js` 2.106.2, CommonJS entry `dist/index.cjs`, exact Auth dependency 2.106.2; `@supabase/auth-js` 2.106.2, CommonJS entry `dist/main/index.js`. The original report records the resolved pnpm symlinks and compiled-path corroboration. The relevant installed source was reread for this verification: Auth `src/GoTrueClient.ts:3783–3828` still suppresses 401/403/404 and returns no-session success; `src/GoTrueAdminApi.ts:150–167` constructs the explicitly scoped logout URL; `src/GoTrueClient.ts:5281–5301` saves the verified MFA session before returning. The revision correctly accounts for these SDK behaviors.

## Additional corrected evidence and changed-byte consequences

Helper lines 266–272 now require both HTTP 404 and exactly one JSON field, `error: 'Business not found'`. This matches the missing-business return at pinned `src/app/api/admin/businesses/[id]/route.ts:37–38`, reread during this verification. Generic HTML/router 404s no longer pass. Only schema/status booleans are displayed; the provider/customer response is not exposed.

The updated output at 284–294 contains fixed labels, boolean evidence and one of three fixed cleanup strings. It adds no secret, token, customer DTO, input, factor identifier or provider-error serialization. It remains HTML-escaped through the existing result renderer.

I reread the full updated helper to check for consequences beyond the two fixes. It retains the same fixed Auth/API origins and three API paths, fixed designated account/business and missing UUID, publishable/anon-only configuration classifier, in-memory SDK session configuration, exact local-only logout allowlist, chosen verified TOTP factor restriction, redirect refusal, request/body limits, nonce and Host/Origin protections, loopback-only listener, single-flow busy lock and abort/TTL shutdown coordination. The changes add validation/evidence bookkeeping, not additional destinations or API operations. No new authorization expansion or secret logging path was identified.

## Limits retained from the original review

- This approval completes the independent source review prerequisite only. The lead still owns execution authorization and independent evidence that staging runs the specified implementation pin and the fixed missing UUID is absent. This report does not execute or authorize login by itself.
- Unknown session creation remains inherently unrecoverable when the session-bearing response is lost under the authorized request limits. The helper now reports that uncertainty accurately. A rejected password or MFA response is conservatively classified as cleanup unconfirmed; that can be a false negative, not a false cleanup success.
- Successful local logout HTTP evidence is the stated claim; it is not proof of instantaneous access-token invalidation or revocation of any other session.
- Existing detail checks cover the listed top-level fields/types and ID matches, not every nested DTO member. A null summary does not exercise its non-null data branch. String timestamps are checked as the pinned TypeScript contract declares them; no semantic timestamp parsing was added or claimed.
- The eight-minute TTL stops new verification activity; bounded cleanup may extend process lifetime. Local-native-process/host compromise, cryptographic package provenance and guaranteed JavaScript memory zeroization remain outside this source-only verification.
- The helper provides API-read evidence only. It does not establish browser regression verification, the main feature gates, or #1197 Gate B/D9.
<!-- END 1189-REPORT-4 -->

</details>

### Exact reviewed GET helper source

<!-- BEGIN 1189-HELPER-SOURCE -->
````javascript
// Review-only artifact. Do not execute before independent security review and lead authorization.
// Lead must verify MISSING_BUSINESS absent and staging deployment at FEATURE_PIN first.
// This verifies three API reads only; it does not complete #1197 Gate B/D9 or browser regression.
// Provenance: installed @supabase/supabase-js 2.106.2 and @supabase/auth-js 2.106.2.
// supabase-js/src/lib/types.ts: auth options and global.fetch.
// auth-js/src/GoTrueClient.ts: signInWithPassword 1087; _signOut 3791;
// _verify 5237; _challenge 5324; _listFactors 5427; memory storage 423-440.
// auth-js/src/GoTrueAdminApi.ts: signOut 150-167 (logout?scope=local).
// auth-js/src/lib/fetch.ts: 225 logs thrown fetch errors; this adapter returns
// sanitized error Responses instead, without passing provider errors to the SDK.
// Route contracts: src/lib/admin/business-detail-types.ts: BusinessDetailResponse;
// src/lib/solicitation/batch-view.ts:862 AdminBatchSummary; API routes at feature pin.
// Pinned enums: src/lib/solicitation/outreach.ts:99-109 and batch-view.ts:165-171.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

const WORKTREE = '/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1189';
const FEATURE_PIN = 'bf84c855b947f0cd4c8587b880968cacb7b7caa9';
const AUTH_ORIGIN = 'https://kubdiqdhqbhwmqfditeg.supabase.co';
const API_ORIGIN = 'https://staging.repworth.net';
const ACCOUNT = '01a06dd3-1624-72b4-a4bf-22ab2f19fecb';
const BUSINESS = '01a06dd3-1622-70c7-9037-7dd9171aea17';
const MISSING_BUSINESS = '00000000-0000-4000-8000-000000000099';
const API_PATHS = ['/api/admin/businesses/options', `/api/admin/businesses/${BUSINESS}`, `/api/admin/businesses/${MISSING_BUSINESS}`];
const BATCH_STATES = ['halted', 'closed', 'sending', 'veto_window', 'approved', 'expired', 'built', 'pending'];
const HALT_REASONS = ['owner_veto', 'owner_halt', 'admin_halt', 'send_window_elapsed', 'batch_expired', 'platform_halt'];
const TTL_MS = 8 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const FORM_CAP = 8192;
const AUTH_RESPONSE_CAP = 128 * 1024;
const API_RESPONSE_CAP = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const publicKey = process.env.REPWORTH_STAGING_SUPABASE_PUBLISHABLE_KEY;
delete process.env.REPWORTH_STAGING_SUPABASE_PUBLISHABLE_KEY;

function validPublicKey(key) {
  if (typeof key !== 'string' || key.length > 4096) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    return payload.role === 'anon' && payload.ref === 'kubdiqdhqbhwmqfditeg';
  } catch { return false; }
}

if (!validPublicKey(publicKey)) {
  process.stderr.write('A staging publishable key or staging legacy anon key is required in REPWORTH_STAGING_SUPABASE_PUBLISHABLE_KEY. Key values are never displayed.\n');
  process.exit(1);
}
const require = createRequire(`${WORKTREE}/package.json`);
const { createClient } = require('@supabase/supabase-js');
let client;
let baseOrigin;
let expectedHost;
let phase = 'login';
let nonce = randomBytes(32).toString('hex');
let factorIds = [];
let chosenFactor = null;
let busy = false;
let stopping = false;
let flow = Promise.resolve();
let shutdownPromise;
let resultRows = [];
let resultPassed = false;
const controllers = new Set();
// Evidence is monotonic for this one sign-in/MFA flow. SDK no-op sign-out success
// cannot clear an unknown session-issuing response or substitute for HTTP logout.
const sessionEvidence = {
  passwordAttempted: false,
  passwordResponseReceived: false,
  passwordSessionAccepted: false,
  mfaAttempted: false,
  mfaResponseReceived: false,
  mfaSessionAccepted: false,
  localLogoutHttpConfirmed: false,
};

async function boundedBytes(response, cap) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > cap)) {
    await response.body?.cancel();
    throw new Error('Response exceeds limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new Error('Response exceeds limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function safeAuthFailure(status = 503) {
  return new Response('{"message":"Authentication request did not complete","code":"helper_auth_failed"}', {
    status, headers: { 'content-type': 'application/json' },
  });
}

// This client cannot refresh, enroll, reset, access the Data API, or sign out other sessions.
async function authFetch(input, init = {}) {
  let timer;
  const controller = new AbortController();
  controllers.add(controller);
  try {
    if (typeof input !== 'string') return safeAuthFailure(400);
    const url = new URL(input);
    const method = init.method?.toUpperCase() ?? 'GET';
    const path = url.pathname + url.search;
    const logout = method === 'POST' && path === '/auth/v1/logout?scope=local';
    const passwordGrant = method === 'POST' && path === '/auth/v1/token?grant_type=password';
    const mfaVerify = chosenFactor && method === 'POST' && path === `/auth/v1/factors/${chosenFactor}/verify`;
    const permitted = logout
      || (phase === 'login' && method === 'POST' && path === '/auth/v1/token?grant_type=password')
      || (phase === 'login' && method === 'GET' && path === '/auth/v1/user')
      || (phase === 'mfa' && chosenFactor && method === 'POST'
        && (path === `/auth/v1/factors/${chosenFactor}/challenge` || path === `/auth/v1/factors/${chosenFactor}/verify`));
    if (url.origin !== AUTH_ORIGIN || url.username || url.password || url.hash || !permitted || (stopping && !logout)) return safeAuthFailure(400);
    timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // Mark the attempt before handing bytes to fetch, including a lost response.
    if (passwordGrant) sessionEvidence.passwordAttempted = true;
    if (mfaVerify) sessionEvidence.mfaAttempted = true;
    if (passwordGrant || mfaVerify) sessionEvidence.localLogoutHttpConfirmed = false;
    const response = await fetch(input, { ...init, redirect: 'error', signal: controller.signal });
    const bytes = await boundedBytes(response, AUTH_RESPONSE_CAP);
    if (passwordGrant) sessionEvidence.passwordResponseReceived = true;
    if (mfaVerify) sessionEvidence.mfaResponseReceived = true;
    if (!response.ok) return safeAuthFailure(response.status >= 400 ? response.status : 503);
    if (logout) sessionEvidence.localLogoutHttpConfirmed = true;
    // No provider headers (including cookies) cross into the browser or SDK.
    return new Response(response.status === 204 ? null : bytes, {
      status: response.status, headers: { 'content-type': 'application/json' },
    });
  } catch { return safeAuthFailure(); }
  finally { clearTimeout(timer); controllers.delete(controller); }
}

client = createClient(AUTH_ORIGIN, publicKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false },
  global: { fetch: authFetch },
});

function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function sendPage(res, status, content) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, max-age=0', 'pragma': 'no-cache',
    'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'connection': 'close',
  });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>1189 staging GET verification</title><body><main><h1>1189 staging GET verification</h1><p>Fixed staging target; helper TTL: 8 minutes from startup. Credentials and MFA codes are entered manually by the owner.</p>${content}</main></body></html>`);
}

function form(action, body, label) {
  return `<form method="post" action="${action}" autocomplete="off"><input type="hidden" name="nonce" value="${nonce}">${body}<p><button type="submit">${label}</button></p></form>`;
}

function currentPage(res) {
  if (phase === 'login') return sendPage(res, 200,
    `<p>Sign in with an existing staging admin. The helper will use an existing verified authenticator factor.</p>${form('/login', '<p><label>Email <input name="email" type="email" maxlength="254" required autocomplete="off"></label></p><p><label>Password <input name="password" type="password" maxlength="1024" required autocomplete="off"></label></p>', 'Sign in')}`);
  if (phase === 'mfa') return sendPage(res, 200,
    `<p>Select your existing authenticator factor by its order in the account and enter the current six-digit code. Factor names and IDs are not displayed.</p>${form('/mfa', `<p><label>Existing factor <select name="factor">${factorIds.map((_, index) => `<option value="${index}">Authenticator ${index + 1}</option>`).join('')}</select></label></p><p><label>Authenticator code <input name="code" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required autocomplete="off"></label></p>`, 'Verify MFA and run three GETs')}`);
  return sendPage(res, 200, `<h2>${resultPassed ? 'PASS' : 'NOT VERIFIED'}</h2><p>Expected feature pin: ${FEATURE_PIN}. Deployment and missing-ID preconditions must be independently evidenced.</p><table><thead><tr><th>Check</th><th>Sanitized result</th></tr></thead><tbody>${resultRows.map(([label, value]) => `<tr><td>${escape(label)}</td><td>${escape(value)}</td></tr>`).join('')}</tbody></table><p>Capture this sanitized page before closing. This is API evidence only; browser regression and #1197 Gate B/D9 remain separate.</p>${form('/close', '', 'Close helper and clean up session')}`);
}

function exactHeader(req, name, value, required) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count === 0 ? !required : count === 1 && req.headers[name] === value;
}

async function readForm(req, fields) {
  if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') throw new Error('Invalid form');
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > FORM_CAP)) throw new Error('Invalid form');
  const buffers = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > FORM_CAP) throw new Error('Invalid form');
      buffers.push(chunk);
    }
    const bytes = Buffer.concat(buffers, size);
    const params = new URLSearchParams(bytes.toString('utf8'));
    bytes.fill(0);
    const expected = ['nonce', ...fields];
    if ([...params.keys()].length !== expected.length || !expected.every(key => params.getAll(key).length === 1)) throw new Error('Invalid form');
    const provided = params.get('nonce');
    if (!/^[a-f0-9]{64}$/.test(provided ?? '') || !timingSafeEqual(Buffer.from(provided), Buffer.from(nonce))) throw new Error('Invalid form');
    nonce = randomBytes(32).toString('hex');
    return params;
  } finally { for (const buffer of buffers) buffer.fill(0); }
}

async function fixedGet(index, token) {
  if (stopping || ![0, 1, 2].includes(index)) throw new Error('Read stopped');
  const controller = new AbortController();
  controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(API_ORIGIN + API_PATHS[index], {
      method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error', signal: controller.signal, credentials: 'omit', cache: 'no-store',
    });
    const bytes = await boundedBytes(response, API_RESPONSE_CAP);
    let data = null;
    let json = false;
    try {
      if (response.headers.get('content-type')?.split(';')[0].trim() === 'application/json') {
        data = JSON.parse(bytes.toString('utf8')); json = true;
      }
    } catch { /* Only the schema boolean is exposed. */ }
    finally { bytes.fill(0); }
    return { status: response.status, json, data };
  } finally { clearTimeout(timer); controllers.delete(controller); }
}

async function runGets(token) {
  const options = await fixedGet(0, token);
  const optionsShape = options.json && object(options.data) && Object.keys(options.data).length === 1 && typeof options.data.betaCompActive === 'boolean';
  resultRows.push(['Options status', options.status], ['Options exact boolean schema', optionsShape]);
  if (optionsShape) resultRows.push(['Options betaCompActive', options.data.betaCompActive]);
  options.data = null;

  const detail = await fixedGet(1, token);
  const expectedKeys = ['business', 'account', 'rankingSnapshots', 'reviewsTotal', 'reviews', 'zernio', 'approvalAuditLog', 'accountAuditLog', 'autoApproval'];
  const keysPresent = expectedKeys.every(key => own(detail.data, key));
  const existingTypes = keysPresent && ['business', 'account', 'zernio', 'autoApproval'].every(key => object(detail.data[key]))
    && ['rankingSnapshots', 'reviews', 'approvalAuditLog', 'accountAuditLog'].every(key => Array.isArray(detail.data[key]))
    && Number.isSafeInteger(detail.data.reviewsTotal) && detail.data.reviewsTotal >= 0;
  const businessMatch = detail.data?.business?.id === BUSINESS;
  const accountMatch = detail.data?.account?.id === ACCOUNT;
  const summaryPresent = own(detail.data, 'batchSummary');
  const summary = detail.data?.batchSummary;
  const summaryKeys = ['batchId', 'batchState', 'builtAt', 'approvedAt', 'haltedAt', 'haltReason', 'cancellableCount', 'sendingCount', 'sentCount'];
  const summaryFields = object(summary) && Object.keys(summary).length === summaryKeys.length && summaryKeys.every(key => own(summary, key));
  const summaryTypes = summaryFields && UUID.test(summary.batchId) && BATCH_STATES.includes(summary.batchState)
    && (summary.haltReason === null || HALT_REASONS.includes(summary.haltReason))
    && ['builtAt', 'approvedAt', 'haltedAt'].every(key => summary[key] === null || typeof summary[key] === 'string')
    && ['cancellableCount', 'sendingCount', 'sentCount'].every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0);
  const summaryValid = summaryPresent && (summary === null || summaryTypes);
  resultRows.push(['Business detail status', detail.status], ['Business detail JSON', detail.json], ['Existing detail keys retained', keysPresent], ['Existing top-level types', existingTypes], ['Designated business ID matches', businessMatch], ['Designated account ID matches', accountMatch], ['batchSummary field present', summaryPresent], ['batchSummary is null', summary === null], ['batchSummary exact fields if non-null', summary === null ? 'not applicable' : summaryFields], ['batchSummary field types if non-null', summary === null ? 'not applicable' : summaryTypes], ['batchSummary schema valid', summaryValid]);
  detail.data = null;

  const missing = await fixedGet(2, token);
  const missing404 = missing.status === 404;
  const missingShape = missing.json && object(missing.data) && Object.keys(missing.data).length === 1
    && own(missing.data, 'error') && missing.data.error === 'Business not found';
  resultRows.push(['Fixed missing business status', missing.status], ['Fixed missing business returns 404', missing404], ['Fixed missing business exact route error JSON', missingShape]);
  missing.data = null;
  resultPassed = options.status === 200 && optionsShape && detail.status === 200 && detail.json && existingTypes && businessMatch && accountMatch && summaryValid && missing404 && missingShape;
}

function cleanupOutcome() {
  if (!sessionEvidence.passwordAttempted && !sessionEvidence.mfaAttempted) return 'no session attempted';
  // Conservatively retain uncertainty if a session-bearing response was lost,
  // malformed, or rejected by the SDK, even if an older token could log out.
  const sessionsKnown = sessionEvidence.passwordResponseReceived && sessionEvidence.passwordSessionAccepted
    && (!sessionEvidence.mfaAttempted || (sessionEvidence.mfaResponseReceived && sessionEvidence.mfaSessionAccepted));
  return sessionsKnown && sessionEvidence.localLogoutHttpConfirmed ? 'confirmed local logout' : 'cleanup unconfirmed';
}

function recordCleanup(outcome) {
  resultRows.push(
    ['Password grant attempted', sessionEvidence.passwordAttempted],
    ['Password grant response fully received', sessionEvidence.passwordResponseReceived],
    ['Password session accepted by SDK', sessionEvidence.passwordSessionAccepted],
    ['MFA verify attempted', sessionEvidence.mfaAttempted],
    ['MFA verify response fully received', sessionEvidence.mfaResponseReceived],
    ['MFA session accepted by SDK', sessionEvidence.mfaSessionAccepted],
    ['Local logout successful HTTP response received', sessionEvidence.localLogoutHttpConfirmed],
    ['Helper session cleanup outcome', outcome],
  );
}

async function releaseSession() {
  try {
    await client.auth.signOut({ scope: 'local' });
  } catch { /* SDK success or failure cannot replace the transport evidence. */ }
  return cleanupOutcome();
}

async function handlePost(req, res) {
  let params;
  try {
    if (phase === 'login' && req.url === '/login') {
      params = await readForm(req, ['email', 'password']);
      const email = params.get('email');
      const password = params.get('password');
      if (!email || email.length > 254 || !password || password.length > 1024) throw new Error('Invalid form');
      const signed = await client.auth.signInWithPassword({ email, password });
      params.delete('email'); params.delete('password');
      sessionEvidence.passwordSessionAccepted = !signed.error && Boolean(signed.data.session);
      if (signed.error || !signed.data.session || stopping) throw new Error('Sign-in failed');
      // Tokens returned by the SDK are never stored outside request processing memory.
      const factors = await client.auth.mfa.listFactors();
      if (factors.error || stopping) throw new Error('Factor lookup failed');
      factorIds = factors.data.totp.filter(factor => factor.status === 'verified' && factor.factor_type === 'totp' && UUID.test(factor.id)).map(factor => factor.id);
      if (factorIds.length === 0 || factorIds.length > 10) throw new Error('Existing verified factor required');
      phase = 'mfa';
      return currentPage(res);
    }
    if (phase === 'mfa' && req.url === '/mfa') {
      params = await readForm(req, ['factor', 'code']);
      const choice = params.get('factor');
      if (!/^[0-9]$/.test(choice ?? '') || !factorIds[Number(choice)] || !/^[0-9]{6}$/.test(params.get('code') ?? '')) throw new Error('Invalid form');
      chosenFactor = factorIds[Number(choice)];
      const challenge = await client.auth.mfa.challenge({ factorId: chosenFactor });
      if (challenge.error || !UUID.test(challenge.data?.id) || stopping) throw new Error('Challenge failed');
      const verified = await client.auth.mfa.verify({ factorId: chosenFactor, challengeId: challenge.data.id, code: params.get('code') });
      params.delete('code');
      sessionEvidence.mfaSessionAccepted = !verified.error && typeof verified.data?.access_token === 'string';
      if (verified.error || typeof verified.data?.access_token !== 'string' || stopping) throw new Error('MFA failed');
      phase = 'reading';
      await runGets(verified.data.access_token);
      const cleanup = await releaseSession();
      recordCleanup(cleanup);
      resultPassed &&= cleanup === 'confirmed local logout';
      phase = 'result';
      return currentPage(res);
    }
    if (phase === 'result' && req.url === '/close') {
      params = await readForm(req, []);
      sendPage(res, 200, '<p>Closing helper and cleaning up its session. The terminal reports the cleanup result.</p>');
      setTimeout(() => { void shutdown(); }, 200);
      return;
    }
    sendPage(res, 400, '<p>Invalid step.</p>');
  } catch {
    // Fail closed with one attempt per phase; never serialize provider errors or input.
    const cleanup = await releaseSession();
    resultPassed = false;
    resultRows.push(['Flow completed', false]);
    recordCleanup(cleanup);
    phase = 'result';
    currentPage(res);
  } finally {
    if (params) for (const key of [...params.keys()]) params.delete(key);
    chosenFactor = null;
  }
}

const server = createServer((req, res) => {
  const originOK = exactHeader(req, 'origin', baseOrigin, req.method === 'POST');
  const site = req.headers['sec-fetch-site'];
  if (stopping || !exactHeader(req, 'host', expectedHost, true) || !originOK || (site && site !== 'none' && site !== 'same-origin')) {
    sendPage(res, 403, '<p>Request rejected.</p>'); return;
  }
  if (req.method === 'GET' && req.url === '/') {
    if (busy) sendPage(res, 409, '<p>A verification step is already running.</p>');
    else currentPage(res);
    return;
  }
  if (req.method !== 'POST' || !['/login', '/mfa', '/close'].includes(req.url)) { sendPage(res, 404, '<p>Not found.</p>'); return; }
  if (busy) { sendPage(res, 409, '<p>A verification step is already running.</p>'); return; }
  busy = true;
  flow = handlePost(req, res).catch(() => { res.destroy(); }).finally(() => { busy = false; });
});
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
// One MFA submission can contain six sequential bounded network operations.
// Keep the response socket alive while those run; request-body receipt stays 20s.
server.timeout = 105_000;
server.maxHeadersCount = 24;
server.maxConnections = 4;
server.on('clientError', (_error, socket) => { socket.destroy(); });

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    clearTimeout(ttl);
    for (const controller of controllers) controller.abort();
    server.close();
    server.closeAllConnections();
    await flow;
    const cleanup = await releaseSession();
    factorIds = []; chosenFactor = null; nonce = ''; resultRows = []; client = null;
    process.stdout.write(`Helper stopped. Session cleanup outcome: ${cleanup}.\n`);
    process.exitCode = cleanup === 'cleanup unconfirmed' ? 1 : 0;
  })();
  return shutdownPromise;
}
const ttl = setTimeout(() => { void shutdown(); }, TTL_MS);
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
server.on('error', () => { process.stderr.write('Loopback helper could not start.\n'); void shutdown(); });
server.listen(0, '127.0.0.1', () => {
  expectedHost = `127.0.0.1:${server.address().port}`;
  baseOrigin = `http://${expectedHost}`;
  process.stdout.write(`Owner-only manual sign-in page: ${baseOrigin}/\n`);
});
````
<!-- END 1189-HELPER-SOURCE -->

### Completed preview restart ledger

The ledger is a local operational record; it contains no credentials.
SHA-256: 3ffcf88c4f799b03996ae45451c579e66e4bffc3241df723bd945073fa045f50

<!-- BEGIN 1189-PREVIEW-LEDGER -->
````json
{
  "ticket": 1189,
  "reason": "Owner assented to the previously described temporary stop/restart proposal; orchestrator clarified authorization on resume.",
  "cwd": "/Users/norbertesekiel/Developer/startups/RepWorth",
  "shared_parent_never_touch": 8575,
  "servers": [
    {
      "port": 3100,
      "command": ["pnpm", "dev", "--webpack", "--port", "3100"],
      "original_pids": [7763, 7798, 7808],
      "original_start": "Thu Sep 10 00:32:17 2026",
      "status": "restored after original mutation finalizer; pnpm dev --webpack --port 3100 reported Ready; owned exec session34393"
    },
    {
      "port": 3101,
      "command": ["pnpm", "start", "--port", "3101"],
      "original_pids": [25189, 25258],
      "original_start": "Thu Sep 10 02:49:15 2026",
      "status": "restored after original mutation finalizer; pnpm start --port 3101 reported Ready; owned exec session72101; initial shutdown required SIGKILL after graceful SIGTERM"
    }
  ],
  "limitations": "Browser connections and in-memory server state are interrupted; original unrecorded environment overrides cannot be guaranteed. Restart after the lead runs the original mutation finalizer. Do not restart before dotenv restoration."
}
````
<!-- END 1189-PREVIEW-LEDGER -->

<!-- END #1189 LEAD ACCEPTANCE RECORD -->

## Reviewed Origin-policy correction artifacts

These temporary verification artifacts do not change repository runtime code.
The original helper and its earlier reviews remain preserved above. The only
helper source change is Referrer-Policy:no-referrer to same-origin; reversing
that single exact substitution reproduces the original 6d851b26…6361 hash.
The strict Host, Origin, fetch-site, nonce, destination, auth, and cleanup
checks are unchanged. Both corrected artifacts passed independent source
review, then node --check before any execution. The corrected helper remains
subject to actual browser proof and per-run local-session cleanup.

### Independent Origin-policy correction security review

Temporary source: /private/tmp/1189-helper-origin-security.md
SHA-256: 20887f9c0fc7684efc6304286878317d78e31df79596b6ddde75a619264c4605

<!-- BEGIN 1189-ORIGIN-ARTIFACT-0 -->
````markdown
# Independent security review — #1189 Origin-policy correction

Verdict: **APPROVED** for the exact temporary helper correction and synthetic loopback probe identified below. No actionable P0, P1, or P2 finding was identified. This is source-review approval; actual browser behavior and authenticated API verification remain unproven by this review.

## Artifacts and exact change

| Artifact | Independently observed SHA-256 |
| --- | --- |
| Original `/private/tmp/1189-staging-get-verifier.mjs`, before writer correction | `6d851b260755e45527eed807bd759246d4cef0b165bf0f9bc0981b1ddf356361` |
| Corrected `/private/tmp/1189-staging-get-verifier.mjs` | `c89566baf90d5edf6c209af457832850098cf5079e670c471dded2947a4b0f92` |
| `/private/tmp/1189-origin-policy-probe.mjs` | `a6819932becc309903fe0beb7bca049349aa83e9b71f37f03560799183e302b7` |

I read all 413 lines of the original helper and the full prior security verification report, retained the original source in review memory, and read the corrected helper. Comparing the latter against the retained original with exactly one replacement produced equality. The entire change is:

```diff
-    'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
+    'referrer-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
```

I read the full 114-line synthetic probe and independently hashed both final files. Neither artifact was imported, executed, syntax-tested, or used for authentication during this review. No browser action, test, external network request, credential inspection, or repository edit was performed. Only this temporary report was written.

## Helper correction assessment

The lead supplied the primary WHATWG Fetch Origin-header rule at `https://fetch.spec.whatwg.org/#origin-header`: for the relevant non-CORS POST, no-referrer can produce literal `Origin: null`, while same-origin retains the same origin. I did not independently fetch that reference under this read-only, no-network assignment. The synthetic browser probe must establish the actual in-app browser behavior; this report does not treat the stated rule as observed runtime evidence.

The revised response policy is compatible with retaining the helper's mandatory exact Origin comparison. In particular, no `null`-Origin exception is added to the authenticated helper. Host and Origin duplicate detection, exact loopback Host, mandatory exact Origin on every POST, Sec-Fetch-Site restrictions, rotating cryptographic nonce, exact form fields and size limits all remain byte-identical. Login/MFA single-flow handling, eight-minute TTL, bounded request/response handling, fixed staging Auth/API destinations, redirect refusal, in-memory SDK settings, and local-session-only cleanup and uncertainty reporting remain byte-identical.

The policy change permits a Referer header on same-origin requests and suppresses it on cross-origin requests. The helper serves fixed URLs `/`, `/login`, `/mfa`, and `/close`; it puts credentials and MFA values in POST bodies, with no redirect or URL serialization of those values. Its forms have fixed relative actions and its CSP remains `default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`. Legitimate same-origin Referer values therefore contain only the ephemeral loopback origin and fixed step path, not submitted credentials, MFA codes, factor IDs, tokens, customer DTOs, or provider errors. No new external resource or form target is introduced. The browser response-header change does not modify the server-side SDK fetch implementation or its outbound headers.

The existing security verification's limitations remain in force, including conservative cleanup uncertainty after a lost session-bearing response, and the distinction between successful local logout HTTP evidence and instantaneous access-token invalidation. Those claims are unchanged by this correction.

## Synthetic probe assessment

- The sole import is native `node:http`. There is no SDK, environment read, file read/write, outbound HTTP client, credential field, script, or external resource. The form has no inputs or named submit button, so its intended POST body is empty.
- The server binds only `127.0.0.1` on an ephemeral port. Exact single Host validation prevents alternate-host requests. Cookie, Authorization, Proxy-Authorization, Transfer-Encoding, and any declared nonzero Content-Length are rejected before routing. Any received body chunk is cleared and the request destroyed; no body is logged or retained.
- GET handling permits only fixed paths and absent or exact loopback Origin, with same-origin/none/absent Sec-Fetch-Site handling. POST handling permits only the two fixed synthetic submit paths, one exact URL-encoded content type, and a single `Sec-Fetch-Site: same-origin` header. It accepts only a single literal `Origin: null` or exact loopback Origin so it can measure the original and corrected policies. This exception exists solely in the credential-free synthetic collector; the authenticated helper remains strict.
- The observation objects contain only the allowlisted Origin, generated loopback Host, and fixed Sec-Fetch-Site value. They do not echo raw header collections, Referer, request URLs, body data, or errors. These restricted values are safe in the HTML result block despite no general HTML escaper. The fixed original/corrected modes identify each result on the page; terminal records alone omit that mode and should not substitute for the browser's paired results.
- Default-deny CSP, same-origin form action, frame denial, no-store, and connection close apply to probe responses. Header/body receipt and socket timeouts are five seconds; maximum header size, header count, and connection count are bounded. The three-minute TTL, close route, SIGINT, and SIGTERM converge on idempotent shutdown, clear retained observations, close the listener, and close connections. There is no remote session or other persistent resource to clean up.
- A GET close link can terminate this ephemeral probe without a nonce. That is acceptable within its explicitly credential-free measurement scope: termination clears two non-sensitive observations and cannot mutate application data or revoke a session. This is not approval to transfer that design to the authenticated helper.

## Execution boundaries and evidence still required

Approval binds only the hashes above. Recheck them before use; any additional correction requires a new binding. The lead owns execution authorization and campaign bookkeeping, and root owns in-app Browser interaction. Neither artifact should be treated as implicitly executed by this review.

For the probe, preserve the browser's labeled original/corrected observations and confirm process/listener shutdown. Expectation is original `Origin: null` versus corrected exact loopback Origin, with exact Host and same-origin Sec-Fetch-Site in both. If observations differ or submissions are rejected, diagnose the actual evidence instead of relaxing the authenticated helper's Origin validation.

For the helper, staging deployment and designated/missing-record preconditions, owner-entered authentication/MFA, three GET results, and its own session/process cleanup still need separate proof. Neither the probe nor this header correction proves #1197 Gate B/D9 or replaces the existing browser regression evidence.
````
<!-- END 1189-ORIGIN-ARTIFACT-0 -->

### Credential-free Origin-policy browser probe source

Temporary source: /private/tmp/1189-origin-policy-probe.mjs
SHA-256: a6819932becc309903fe0beb7bca049349aa83e9b71f37f03560799183e302b7

<!-- BEGIN 1189-ORIGIN-ARTIFACT-1 -->
````javascript
// Review-only synthetic browser probe. Do not execute before security approval.
// No credentials, cookies, Auth SDK, environment reads, files, or outbound calls.
// Root supplied the WHATWG Fetch Origin-header finding:
// https://fetch.spec.whatwg.org/#origin-header
// Compare browser-generated POST Origin under no-referrer and same-origin.
import { createServer } from 'node:http';

const TTL_MS = 180_000;
let host;
let origin;
let stopped = false;
const observations = { original: null, corrected: null };
const links = '<p><a href="/original">Original policy form</a> | <a href="/corrected">Corrected policy form</a> | <a href="/">Results</a> | <a href="/close">Close probe</a></p>';

function oneHeader(req, name, expected, required = true) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count === 0 ? !required : count === 1 && req.headers[name] === expected;
}

function page(res, status, policy, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': policy,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'connection': 'close',
  });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Origin policy probe</title><body><h1>Synthetic Origin policy probe</h1><p>No input fields. No credentials. Automatic shutdown three minutes after startup.</p>${body}${links}</body></html>`);
}

function results() {
  return ['original', 'corrected'].map(mode => {
    const seen = observations[mode];
    // Every displayed value was restricted to fixed literals or our loopback host.
    return `<h2>${mode}</h2><pre>${seen ? JSON.stringify(seen, null, 2) : 'No synthetic POST observed.'}</pre>`;
  }).join('');
}

const server = createServer({ maxHeaderSize: 4096 }, (req, res) => {
  if (stopped || !oneHeader(req, 'host', host) || req.headers.cookie !== undefined
    || req.headers.authorization !== undefined || req.headers['proxy-authorization'] !== undefined
    || req.headers['transfer-encoding'] !== undefined
    || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
    page(res, 403, 'same-origin', '<p>Rejected.</p>'); return;
  }
  if (req.method === 'GET') {
    if (!oneHeader(req, 'origin', origin, false)
      || !(oneHeader(req, 'sec-fetch-site', 'none', false) || oneHeader(req, 'sec-fetch-site', 'same-origin'))) {
      page(res, 403, 'same-origin', '<p>Rejected.</p>'); return;
    }
    if (req.url === '/') { page(res, 200, 'same-origin', results()); return; }
    if (req.url === '/close') {
      page(res, 200, 'same-origin', '<p>Probe closing.</p>');
      setTimeout(stop, 100); return;
    }
    if (req.url === '/original' || req.url === '/corrected') {
      const original = req.url === '/original';
      const policy = original ? 'no-referrer' : 'same-origin';
      const action = original ? '/original-submit' : '/corrected-submit';
      page(res, 200, policy, `<h2>Referrer-Policy: ${policy}</h2><form method="post" action="${action}"><button type="submit">Submit empty synthetic POST</button></form>`); return;
    }
  }
  if (req.method !== 'POST' || !['/original-submit', '/corrected-submit'].includes(req.url)) {
    page(res, 404, 'same-origin', '<p>Not found.</p>'); return;
  }
  // This synthetic collector must observe literal null; the real helper still
  // requires its exact Origin. No unrecognized header values are logged.
  if (!(oneHeader(req, 'origin', 'null') || oneHeader(req, 'origin', origin))
    || !oneHeader(req, 'sec-fetch-site', 'same-origin')
    || !oneHeader(req, 'content-type', 'application/x-www-form-urlencoded')) {
    page(res, 403, 'same-origin', '<p>Rejected.</p>'); return;
  }
  let empty = true;
  req.on('data', chunk => { empty = false; chunk.fill(0); req.destroy(); });
  req.on('error', () => { res.destroy(); });
  req.on('end', () => {
    if (!empty || stopped) { res.destroy(); return; }
    const seen = { Origin: req.headers.origin, Host: host, 'Sec-Fetch-Site': 'same-origin' };
    observations[req.url === '/original-submit' ? 'original' : 'corrected'] = seen;
    process.stdout.write(`${JSON.stringify(seen)}\n`);
    page(res, 200, 'same-origin', results());
  });
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.timeout = 5000;
server.maxConnections = 2;
server.maxHeadersCount = 24;
server.on('clientError', (_error, socket) => { socket.destroy(); });

function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(ttl);
  observations.original = null; observations.corrected = null;
  server.close();
  server.closeAllConnections();
}
const ttl = setTimeout(stop, TTL_MS);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server.on('error', () => { process.exitCode = 1; stop(); });
server.listen(0, '127.0.0.1', () => {
  host = `127.0.0.1:${server.address().port}`;
  origin = `http://${host}`;
  // Startup discovery uses only the permitted synthetic Host field.
  process.stdout.write(`${JSON.stringify({ Host: host })}\n`);
});
````
<!-- END 1189-ORIGIN-ARTIFACT-1 -->

### Corrected authenticated GET verifier source

Temporary source: /private/tmp/1189-staging-get-verifier.mjs
SHA-256: c89566baf90d5edf6c209af457832850098cf5079e670c471dded2947a4b0f92

<!-- BEGIN 1189-ORIGIN-ARTIFACT-2 -->
````javascript
// Review-only artifact. Do not execute before independent security review and lead authorization.
// Lead must verify MISSING_BUSINESS absent and staging deployment at FEATURE_PIN first.
// This verifies three API reads only; it does not complete #1197 Gate B/D9 or browser regression.
// Provenance: installed @supabase/supabase-js 2.106.2 and @supabase/auth-js 2.106.2.
// supabase-js/src/lib/types.ts: auth options and global.fetch.
// auth-js/src/GoTrueClient.ts: signInWithPassword 1087; _signOut 3791;
// _verify 5237; _challenge 5324; _listFactors 5427; memory storage 423-440.
// auth-js/src/GoTrueAdminApi.ts: signOut 150-167 (logout?scope=local).
// auth-js/src/lib/fetch.ts: 225 logs thrown fetch errors; this adapter returns
// sanitized error Responses instead, without passing provider errors to the SDK.
// Route contracts: src/lib/admin/business-detail-types.ts: BusinessDetailResponse;
// src/lib/solicitation/batch-view.ts:862 AdminBatchSummary; API routes at feature pin.
// Pinned enums: src/lib/solicitation/outreach.ts:99-109 and batch-view.ts:165-171.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

const WORKTREE = '/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1189';
const FEATURE_PIN = 'bf84c855b947f0cd4c8587b880968cacb7b7caa9';
const AUTH_ORIGIN = 'https://kubdiqdhqbhwmqfditeg.supabase.co';
const API_ORIGIN = 'https://staging.repworth.net';
const ACCOUNT = '01a06dd3-1624-72b4-a4bf-22ab2f19fecb';
const BUSINESS = '01a06dd3-1622-70c7-9037-7dd9171aea17';
const MISSING_BUSINESS = '00000000-0000-4000-8000-000000000099';
const API_PATHS = ['/api/admin/businesses/options', `/api/admin/businesses/${BUSINESS}`, `/api/admin/businesses/${MISSING_BUSINESS}`];
const BATCH_STATES = ['halted', 'closed', 'sending', 'veto_window', 'approved', 'expired', 'built', 'pending'];
const HALT_REASONS = ['owner_veto', 'owner_halt', 'admin_halt', 'send_window_elapsed', 'batch_expired', 'platform_halt'];
const TTL_MS = 8 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const FORM_CAP = 8192;
const AUTH_RESPONSE_CAP = 128 * 1024;
const API_RESPONSE_CAP = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const publicKey = process.env.REPWORTH_STAGING_SUPABASE_PUBLISHABLE_KEY;
delete process.env.REPWORTH_STAGING_SUPABASE_PUBLISHABLE_KEY;

function validPublicKey(key) {
  if (typeof key !== 'string' || key.length > 4096) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    return payload.role === 'anon' && payload.ref === 'kubdiqdhqbhwmqfditeg';
  } catch { return false; }
}

if (!validPublicKey(publicKey)) {
  process.stderr.write('A staging publishable key or staging legacy anon key is required in REPWORTH_STAGING_SUPABASE_PUBLISHABLE_KEY. Key values are never displayed.\n');
  process.exit(1);
}
const require = createRequire(`${WORKTREE}/package.json`);
const { createClient } = require('@supabase/supabase-js');
let client;
let baseOrigin;
let expectedHost;
let phase = 'login';
let nonce = randomBytes(32).toString('hex');
let factorIds = [];
let chosenFactor = null;
let busy = false;
let stopping = false;
let flow = Promise.resolve();
let shutdownPromise;
let resultRows = [];
let resultPassed = false;
const controllers = new Set();
// Evidence is monotonic for this one sign-in/MFA flow. SDK no-op sign-out success
// cannot clear an unknown session-issuing response or substitute for HTTP logout.
const sessionEvidence = {
  passwordAttempted: false,
  passwordResponseReceived: false,
  passwordSessionAccepted: false,
  mfaAttempted: false,
  mfaResponseReceived: false,
  mfaSessionAccepted: false,
  localLogoutHttpConfirmed: false,
};

async function boundedBytes(response, cap) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > cap)) {
    await response.body?.cancel();
    throw new Error('Response exceeds limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new Error('Response exceeds limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function safeAuthFailure(status = 503) {
  return new Response('{"message":"Authentication request did not complete","code":"helper_auth_failed"}', {
    status, headers: { 'content-type': 'application/json' },
  });
}

// This client cannot refresh, enroll, reset, access the Data API, or sign out other sessions.
async function authFetch(input, init = {}) {
  let timer;
  const controller = new AbortController();
  controllers.add(controller);
  try {
    if (typeof input !== 'string') return safeAuthFailure(400);
    const url = new URL(input);
    const method = init.method?.toUpperCase() ?? 'GET';
    const path = url.pathname + url.search;
    const logout = method === 'POST' && path === '/auth/v1/logout?scope=local';
    const passwordGrant = method === 'POST' && path === '/auth/v1/token?grant_type=password';
    const mfaVerify = chosenFactor && method === 'POST' && path === `/auth/v1/factors/${chosenFactor}/verify`;
    const permitted = logout
      || (phase === 'login' && method === 'POST' && path === '/auth/v1/token?grant_type=password')
      || (phase === 'login' && method === 'GET' && path === '/auth/v1/user')
      || (phase === 'mfa' && chosenFactor && method === 'POST'
        && (path === `/auth/v1/factors/${chosenFactor}/challenge` || path === `/auth/v1/factors/${chosenFactor}/verify`));
    if (url.origin !== AUTH_ORIGIN || url.username || url.password || url.hash || !permitted || (stopping && !logout)) return safeAuthFailure(400);
    timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // Mark the attempt before handing bytes to fetch, including a lost response.
    if (passwordGrant) sessionEvidence.passwordAttempted = true;
    if (mfaVerify) sessionEvidence.mfaAttempted = true;
    if (passwordGrant || mfaVerify) sessionEvidence.localLogoutHttpConfirmed = false;
    const response = await fetch(input, { ...init, redirect: 'error', signal: controller.signal });
    const bytes = await boundedBytes(response, AUTH_RESPONSE_CAP);
    if (passwordGrant) sessionEvidence.passwordResponseReceived = true;
    if (mfaVerify) sessionEvidence.mfaResponseReceived = true;
    if (!response.ok) return safeAuthFailure(response.status >= 400 ? response.status : 503);
    if (logout) sessionEvidence.localLogoutHttpConfirmed = true;
    // No provider headers (including cookies) cross into the browser or SDK.
    return new Response(response.status === 204 ? null : bytes, {
      status: response.status, headers: { 'content-type': 'application/json' },
    });
  } catch { return safeAuthFailure(); }
  finally { clearTimeout(timer); controllers.delete(controller); }
}

client = createClient(AUTH_ORIGIN, publicKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false },
  global: { fetch: authFetch },
});

function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function sendPage(res, status, content) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, max-age=0', 'pragma': 'no-cache',
    'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'connection': 'close',
  });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>1189 staging GET verification</title><body><main><h1>1189 staging GET verification</h1><p>Fixed staging target; helper TTL: 8 minutes from startup. Credentials and MFA codes are entered manually by the owner.</p>${content}</main></body></html>`);
}

function form(action, body, label) {
  return `<form method="post" action="${action}" autocomplete="off"><input type="hidden" name="nonce" value="${nonce}">${body}<p><button type="submit">${label}</button></p></form>`;
}

function currentPage(res) {
  if (phase === 'login') return sendPage(res, 200,
    `<p>Sign in with an existing staging admin. The helper will use an existing verified authenticator factor.</p>${form('/login', '<p><label>Email <input name="email" type="email" maxlength="254" required autocomplete="off"></label></p><p><label>Password <input name="password" type="password" maxlength="1024" required autocomplete="off"></label></p>', 'Sign in')}`);
  if (phase === 'mfa') return sendPage(res, 200,
    `<p>Select your existing authenticator factor by its order in the account and enter the current six-digit code. Factor names and IDs are not displayed.</p>${form('/mfa', `<p><label>Existing factor <select name="factor">${factorIds.map((_, index) => `<option value="${index}">Authenticator ${index + 1}</option>`).join('')}</select></label></p><p><label>Authenticator code <input name="code" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required autocomplete="off"></label></p>`, 'Verify MFA and run three GETs')}`);
  return sendPage(res, 200, `<h2>${resultPassed ? 'PASS' : 'NOT VERIFIED'}</h2><p>Expected feature pin: ${FEATURE_PIN}. Deployment and missing-ID preconditions must be independently evidenced.</p><table><thead><tr><th>Check</th><th>Sanitized result</th></tr></thead><tbody>${resultRows.map(([label, value]) => `<tr><td>${escape(label)}</td><td>${escape(value)}</td></tr>`).join('')}</tbody></table><p>Capture this sanitized page before closing. This is API evidence only; browser regression and #1197 Gate B/D9 remain separate.</p>${form('/close', '', 'Close helper and clean up session')}`);
}

function exactHeader(req, name, value, required) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count === 0 ? !required : count === 1 && req.headers[name] === value;
}

async function readForm(req, fields) {
  if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') throw new Error('Invalid form');
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > FORM_CAP)) throw new Error('Invalid form');
  const buffers = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > FORM_CAP) throw new Error('Invalid form');
      buffers.push(chunk);
    }
    const bytes = Buffer.concat(buffers, size);
    const params = new URLSearchParams(bytes.toString('utf8'));
    bytes.fill(0);
    const expected = ['nonce', ...fields];
    if ([...params.keys()].length !== expected.length || !expected.every(key => params.getAll(key).length === 1)) throw new Error('Invalid form');
    const provided = params.get('nonce');
    if (!/^[a-f0-9]{64}$/.test(provided ?? '') || !timingSafeEqual(Buffer.from(provided), Buffer.from(nonce))) throw new Error('Invalid form');
    nonce = randomBytes(32).toString('hex');
    return params;
  } finally { for (const buffer of buffers) buffer.fill(0); }
}

async function fixedGet(index, token) {
  if (stopping || ![0, 1, 2].includes(index)) throw new Error('Read stopped');
  const controller = new AbortController();
  controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(API_ORIGIN + API_PATHS[index], {
      method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error', signal: controller.signal, credentials: 'omit', cache: 'no-store',
    });
    const bytes = await boundedBytes(response, API_RESPONSE_CAP);
    let data = null;
    let json = false;
    try {
      if (response.headers.get('content-type')?.split(';')[0].trim() === 'application/json') {
        data = JSON.parse(bytes.toString('utf8')); json = true;
      }
    } catch { /* Only the schema boolean is exposed. */ }
    finally { bytes.fill(0); }
    return { status: response.status, json, data };
  } finally { clearTimeout(timer); controllers.delete(controller); }
}

async function runGets(token) {
  const options = await fixedGet(0, token);
  const optionsShape = options.json && object(options.data) && Object.keys(options.data).length === 1 && typeof options.data.betaCompActive === 'boolean';
  resultRows.push(['Options status', options.status], ['Options exact boolean schema', optionsShape]);
  if (optionsShape) resultRows.push(['Options betaCompActive', options.data.betaCompActive]);
  options.data = null;

  const detail = await fixedGet(1, token);
  const expectedKeys = ['business', 'account', 'rankingSnapshots', 'reviewsTotal', 'reviews', 'zernio', 'approvalAuditLog', 'accountAuditLog', 'autoApproval'];
  const keysPresent = expectedKeys.every(key => own(detail.data, key));
  const existingTypes = keysPresent && ['business', 'account', 'zernio', 'autoApproval'].every(key => object(detail.data[key]))
    && ['rankingSnapshots', 'reviews', 'approvalAuditLog', 'accountAuditLog'].every(key => Array.isArray(detail.data[key]))
    && Number.isSafeInteger(detail.data.reviewsTotal) && detail.data.reviewsTotal >= 0;
  const businessMatch = detail.data?.business?.id === BUSINESS;
  const accountMatch = detail.data?.account?.id === ACCOUNT;
  const summaryPresent = own(detail.data, 'batchSummary');
  const summary = detail.data?.batchSummary;
  const summaryKeys = ['batchId', 'batchState', 'builtAt', 'approvedAt', 'haltedAt', 'haltReason', 'cancellableCount', 'sendingCount', 'sentCount'];
  const summaryFields = object(summary) && Object.keys(summary).length === summaryKeys.length && summaryKeys.every(key => own(summary, key));
  const summaryTypes = summaryFields && UUID.test(summary.batchId) && BATCH_STATES.includes(summary.batchState)
    && (summary.haltReason === null || HALT_REASONS.includes(summary.haltReason))
    && ['builtAt', 'approvedAt', 'haltedAt'].every(key => summary[key] === null || typeof summary[key] === 'string')
    && ['cancellableCount', 'sendingCount', 'sentCount'].every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0);
  const summaryValid = summaryPresent && (summary === null || summaryTypes);
  resultRows.push(['Business detail status', detail.status], ['Business detail JSON', detail.json], ['Existing detail keys retained', keysPresent], ['Existing top-level types', existingTypes], ['Designated business ID matches', businessMatch], ['Designated account ID matches', accountMatch], ['batchSummary field present', summaryPresent], ['batchSummary is null', summary === null], ['batchSummary exact fields if non-null', summary === null ? 'not applicable' : summaryFields], ['batchSummary field types if non-null', summary === null ? 'not applicable' : summaryTypes], ['batchSummary schema valid', summaryValid]);
  detail.data = null;

  const missing = await fixedGet(2, token);
  const missing404 = missing.status === 404;
  const missingShape = missing.json && object(missing.data) && Object.keys(missing.data).length === 1
    && own(missing.data, 'error') && missing.data.error === 'Business not found';
  resultRows.push(['Fixed missing business status', missing.status], ['Fixed missing business returns 404', missing404], ['Fixed missing business exact route error JSON', missingShape]);
  missing.data = null;
  resultPassed = options.status === 200 && optionsShape && detail.status === 200 && detail.json && existingTypes && businessMatch && accountMatch && summaryValid && missing404 && missingShape;
}

function cleanupOutcome() {
  if (!sessionEvidence.passwordAttempted && !sessionEvidence.mfaAttempted) return 'no session attempted';
  // Conservatively retain uncertainty if a session-bearing response was lost,
  // malformed, or rejected by the SDK, even if an older token could log out.
  const sessionsKnown = sessionEvidence.passwordResponseReceived && sessionEvidence.passwordSessionAccepted
    && (!sessionEvidence.mfaAttempted || (sessionEvidence.mfaResponseReceived && sessionEvidence.mfaSessionAccepted));
  return sessionsKnown && sessionEvidence.localLogoutHttpConfirmed ? 'confirmed local logout' : 'cleanup unconfirmed';
}

function recordCleanup(outcome) {
  resultRows.push(
    ['Password grant attempted', sessionEvidence.passwordAttempted],
    ['Password grant response fully received', sessionEvidence.passwordResponseReceived],
    ['Password session accepted by SDK', sessionEvidence.passwordSessionAccepted],
    ['MFA verify attempted', sessionEvidence.mfaAttempted],
    ['MFA verify response fully received', sessionEvidence.mfaResponseReceived],
    ['MFA session accepted by SDK', sessionEvidence.mfaSessionAccepted],
    ['Local logout successful HTTP response received', sessionEvidence.localLogoutHttpConfirmed],
    ['Helper session cleanup outcome', outcome],
  );
}

async function releaseSession() {
  try {
    await client.auth.signOut({ scope: 'local' });
  } catch { /* SDK success or failure cannot replace the transport evidence. */ }
  return cleanupOutcome();
}

async function handlePost(req, res) {
  let params;
  try {
    if (phase === 'login' && req.url === '/login') {
      params = await readForm(req, ['email', 'password']);
      const email = params.get('email');
      const password = params.get('password');
      if (!email || email.length > 254 || !password || password.length > 1024) throw new Error('Invalid form');
      const signed = await client.auth.signInWithPassword({ email, password });
      params.delete('email'); params.delete('password');
      sessionEvidence.passwordSessionAccepted = !signed.error && Boolean(signed.data.session);
      if (signed.error || !signed.data.session || stopping) throw new Error('Sign-in failed');
      // Tokens returned by the SDK are never stored outside request processing memory.
      const factors = await client.auth.mfa.listFactors();
      if (factors.error || stopping) throw new Error('Factor lookup failed');
      factorIds = factors.data.totp.filter(factor => factor.status === 'verified' && factor.factor_type === 'totp' && UUID.test(factor.id)).map(factor => factor.id);
      if (factorIds.length === 0 || factorIds.length > 10) throw new Error('Existing verified factor required');
      phase = 'mfa';
      return currentPage(res);
    }
    if (phase === 'mfa' && req.url === '/mfa') {
      params = await readForm(req, ['factor', 'code']);
      const choice = params.get('factor');
      if (!/^[0-9]$/.test(choice ?? '') || !factorIds[Number(choice)] || !/^[0-9]{6}$/.test(params.get('code') ?? '')) throw new Error('Invalid form');
      chosenFactor = factorIds[Number(choice)];
      const challenge = await client.auth.mfa.challenge({ factorId: chosenFactor });
      if (challenge.error || !UUID.test(challenge.data?.id) || stopping) throw new Error('Challenge failed');
      const verified = await client.auth.mfa.verify({ factorId: chosenFactor, challengeId: challenge.data.id, code: params.get('code') });
      params.delete('code');
      sessionEvidence.mfaSessionAccepted = !verified.error && typeof verified.data?.access_token === 'string';
      if (verified.error || typeof verified.data?.access_token !== 'string' || stopping) throw new Error('MFA failed');
      phase = 'reading';
      await runGets(verified.data.access_token);
      const cleanup = await releaseSession();
      recordCleanup(cleanup);
      resultPassed &&= cleanup === 'confirmed local logout';
      phase = 'result';
      return currentPage(res);
    }
    if (phase === 'result' && req.url === '/close') {
      params = await readForm(req, []);
      sendPage(res, 200, '<p>Closing helper and cleaning up its session. The terminal reports the cleanup result.</p>');
      setTimeout(() => { void shutdown(); }, 200);
      return;
    }
    sendPage(res, 400, '<p>Invalid step.</p>');
  } catch {
    // Fail closed with one attempt per phase; never serialize provider errors or input.
    const cleanup = await releaseSession();
    resultPassed = false;
    resultRows.push(['Flow completed', false]);
    recordCleanup(cleanup);
    phase = 'result';
    currentPage(res);
  } finally {
    if (params) for (const key of [...params.keys()]) params.delete(key);
    chosenFactor = null;
  }
}

const server = createServer((req, res) => {
  const originOK = exactHeader(req, 'origin', baseOrigin, req.method === 'POST');
  const site = req.headers['sec-fetch-site'];
  if (stopping || !exactHeader(req, 'host', expectedHost, true) || !originOK || (site && site !== 'none' && site !== 'same-origin')) {
    sendPage(res, 403, '<p>Request rejected.</p>'); return;
  }
  if (req.method === 'GET' && req.url === '/') {
    if (busy) sendPage(res, 409, '<p>A verification step is already running.</p>');
    else currentPage(res);
    return;
  }
  if (req.method !== 'POST' || !['/login', '/mfa', '/close'].includes(req.url)) { sendPage(res, 404, '<p>Not found.</p>'); return; }
  if (busy) { sendPage(res, 409, '<p>A verification step is already running.</p>'); return; }
  busy = true;
  flow = handlePost(req, res).catch(() => { res.destroy(); }).finally(() => { busy = false; });
});
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
// One MFA submission can contain six sequential bounded network operations.
// Keep the response socket alive while those run; request-body receipt stays 20s.
server.timeout = 105_000;
server.maxHeadersCount = 24;
server.maxConnections = 4;
server.on('clientError', (_error, socket) => { socket.destroy(); });

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    clearTimeout(ttl);
    for (const controller of controllers) controller.abort();
    server.close();
    server.closeAllConnections();
    await flow;
    const cleanup = await releaseSession();
    factorIds = []; chosenFactor = null; nonce = ''; resultRows = []; client = null;
    process.stdout.write(`Helper stopped. Session cleanup outcome: ${cleanup}.\n`);
    process.exitCode = cleanup === 'cleanup unconfirmed' ? 1 : 0;
  })();
  return shutdownPromise;
}
const ttl = setTimeout(() => { void shutdown(); }, TTL_MS);
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
server.on('error', () => { process.stderr.write('Loopback helper could not start.\n'); void shutdown(); });
server.listen(0, '127.0.0.1', () => {
  expectedHost = `127.0.0.1:${server.address().port}`;
  baseOrigin = `http://${expectedHost}`;
  process.stdout.write(`Owner-only manual sign-in page: ${baseOrigin}/\n`);
});
````
<!-- END 1189-ORIGIN-ARTIFACT-2 -->
