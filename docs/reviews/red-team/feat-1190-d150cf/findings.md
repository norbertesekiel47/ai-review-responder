# #1190 red-team verification — round 2

**Status: CLEAR.** Every one of the 25 in-scope cases has a green individual baseline and a valid mutation kill. The original P0 and P1 are fixed. No new actionable finding was identified within the fix hunks and their directly affected callers.

This is the current report. The retained round-1 report at the end is historical; its former OPEN_P0 verdict is superseded by the measured fixes below. The strict JSON sidecar contains only the current round, as required by its schema. The original round-1 JSON remains in Git history at report-only commit `fc3f2ac8ceb757fde370a6ad35ed8dcbe01e18d6`.

## Immutable scope and inventory

- Mode/branch: feature / `feat/1190`; risk: high.
- Fork and merge-base: `8b92d85395f902879d93748b5929b0b503c0ad86`.
- Measured HEAD: `24715f20b19ab6ab2720ced39bb3f6e7717192d6`.
- Intake SHA-256: `16436c490ea7897e2d478ff0c914889ba89b6d6cb8634b9d2fe555bc169ec95d`.
- Round-2 change boundary: measured round-1 HEAD `6c42b8050acdeac698171a57d26b56d4fcbd8fcf` through the measured HEAD, restricted to fixes and directly affected callers.
- Independent source/test/caller inventory: 9 response, 10 schema, 6 audit cases. Six added, seven modified, twelve unchanged covering cases; no deleted case. Two explicit exclusions remain visible below.
- The response status matrix contains 40 refusal and 11 preservation modules within one executable case, T5. These internal modules do not inflate the case or baseline count.
- Source/test blobs: `c07660b0f3191555b1c785b7d9c3a791bfaa232b` and `3b7b461c191c2b2c0bba5eee632d53e732a4a340`. The entire changed declaration golden is consumed by A2.

Inventory was independently checked against the three suites, the three implementation modules, their direct importers and the immutable fix diff. Production-hunk coverage includes common JSON object projection and dictionaries; distinct helper call/binding identities; mutable status and plain-object proof; recursive request provenance and parser/helper discrimination; symlink/non-directory ancestry; JSDoc preservation; standalone ES libraries; and the generated declaration golden. Changed assertion oracles in S2/S6 are measured through their existing producer lines, not treated as permission to reopen unrelated evaluator behavior.

## Launch accounting and environment

**52 total supervised launches out of the approved ceiling of 75: 25 green baselines plus 27 mutant launches.** All 52 had exactly one executed case according to the canonical assert-one-test command. No retry, restart, collection-only launch, sampling, budget reset, timeout, signal termination or third round occurred. CLI children stayed within their containing case's supervisor and 120,000 ms timeout.

There were 26 failed mutant runs and one first-attempt survivor. T2's first mutation (launch 27) collapsed node identities to filenames but retained binding-environment identities. The fixture did not establish a semantic difference from that first mutation, so it remains an **inconclusive/oracle attempt**, not an equivalent mutation or a confirmed P0. Its permitted second mutation (launch 28) removes helper binding specialization and loses the 200 response; the explicit assertion fails. That valid later measurement resolves T2 under the skill's inventory rules. T5's two mutations separately verify reassigned helper parameters and the plain-object/accessor proof; both are killed. No case used more than two mutants.

Baseline and mutant runs used the same canonical no-database allowlist, temporary HOME `/private/tmp/1190-redteam-home-round2`, live-DB disable switch, and canonical scrubbed dotenv replacement. The installed Vitest entry point ran through the approved run-only copy with argument arrays and no shell interpolation. No dependencies or test configuration changed.

Before every mutation and every run, the same elevated process-visible context required successful suppressed `ps -Ao pid=,command=`, a nonempty separate PID listing containing the checking shell, and successful canonical watchers inspection. Pin, runner hashes, round, remaining budget, isolation and deadline were also checked. All such checks succeeded; no watcher was signaled by the verifier.

- Canonical runner SHA-256: `159fc7b5f2b8b3e93308ae1ecb5c64f5e08c94d148ff8d20b77b4ed1e70347f5`.
- Run-only copy SHA-256: `07dce21d0e5ec6a521a19276b4af0ecd0056afe2141e63fd7a4b9794eab5c656`; its sole change remains the 30-to-75 run ceiling.
- Approved proposal SHA-256: `041476056d5ae114b101ff1701ed0c0580dda3898bcbcee63370563bd6d26605`.
- Independent operation-review SHA-256: `8b381acffb7dcdcc6962efceff1fdfcb9a27f6ac5379604cb9180e0a24acdc27`.
- Raw case JSON, logs, inputs and ledger: `/private/tmp/1190-redteam-results-round2/`. These are execution artifacts, not additional durable report files.

## Restoration before report writing

The invoking feature lead personally ran the **original canonical finalizer after every mutant**, and the verifier waited for each clean restoration acknowledgement before identical dotenv re-isolation. Mutations never overlapped.

The approved preview pause began at **2026-09-11 03:10:29.681883 UTC**. Measurement ended at **03:38:32.671 UTC**, before the hard **03:55:29.681883 UTC** cutoff. The lead completed final restoration and preview verification at **03:39:56.314300 UTC**: actual preview interruption **29 minutes 26.63 seconds**.

After the lead's FINAL_RESTORED acknowledgement, this verifier independently rechecked the exact HEAD, empty complete Git porcelain, round 2 / 52 runs, zero unrestored mutations, zero active supervisors, and closed dotenv state with zero remaining dotenv entries. Elevated process reads independently confirmed launcher **87398**, listener **87421** on port **3101**, and both working directories at `/Users/norbertesekiel/Developer/startups/RepWorth`. The exact launcher command is `node /Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/pnpm exec next start -p 3101`. The lead's restoration record reports Ready in 152 ms using the existing build. Raw restoration record: `/private/tmp/1190-round2-pause.json`.

No report byte was written before these checks. Original process-only environment overrides were never inspected or copied, so their identity is not claimed; restart uses the approved normal shell and workspace configuration. No parent source, staging or production state was changed by the verifier.

## Findings

| Finding | Severity | Current disposition | This-pass evidence |
| --- | --- | --- | --- |
| RT-1190-P0-1 — preprocessing empty partial matcher | P0 | **fixed** | Baseline 15 passes; original unknown-to-string mutant 42 fails at `admin-contract-schemas.test.ts:103`: the restricted string schema does not deeply equal `{}`. |
| RT-1190-P1-1 — undocumented schema-array order | P1 | **fixed** | Current lines 101 and 115 normalize path/location arrays with sorting before equality. Baselines 15/16 pass; S6/S7 retain effective schema/location assertions. |

No open P0/P1/P2, rejected finding, or accepted risk remains. The operational authorization below grants bounded measurement and preview interruption only; it is not risk acceptance, another round, commit, merge or deployment approval.

## Full case inventory

T = `scripts/ci/__tests__/admin-contract-types.test.ts`; S = `scripts/ci/__tests__/admin-contract-schemas.test.ts`; A = `scripts/ci/__tests__/admin-contract-audit.test.ts`. The full suite-qualified selectors below were escaped by the canonical runner for every launch.

| ID | Exact executed selector | Baseline launch | Mutant launch(es) | Current outcome |
| --- | --- | ---: | --- | --- |
| T1 | compiler-derived response contracts emits portable wire declarations for composed responses and JSON serialization | 1 | 26 | killed |
| T2 | compiler-derived response contracts specializes nested response helpers and configuration callbacks | 2 | 27 (inconclusive; resolved), 28 | killed |
| T3 | compiler-derived response contracts rejects unsupported wire response types | 3 | 29 | killed |
| T4 | compiler-derived response contracts preserves distinct response calls and nested bindings on the same line | 4 | 30 | killed |
| T5 | compiler-derived response contracts refuses mutable status bindings instead of reporting their initial values | 5 | 31, 32 | killed |
| T6 | compiler-derived response contracts preserves inline dictionary signatures and refuses unresolved object spreads | 6 | 33 | killed |
| T7 | compiler-derived response contracts derives finite status codes from domain errors and constant lookup maps | 7 | 34 | killed |
| T8 | compiler-derived response contracts does not include uncalled local response helpers or erase mutated local flow types | 8 | 35 | killed |
| T9 | compiler-derived response contracts preserves source DTO uncertainty separately from successful JSON wire types | 9 | 36 | killed |
| S1 | admin request schema source analysis generates request schemas without importing runtime modules | 10 | 37 | killed |
| S2 | admin request schema source analysis labels padded and whitespace-only normalization disagreements | 11 | 38 | killed |
| S3 | admin request schema source analysis records refinements without executing their callbacks | 12 | 39 | killed |
| S4 | admin request schema source analysis refuses unsupported dynamic schema dependencies and getters | 13 | 40 | killed |
| S5 | admin request schema source analysis binds callback and parser parameters without including unused callbacks | 14 | 41 | killed |
| S6 | admin request schema source analysis preserves union normalization paths and preprocessing uncertainty | 15 | 42 | killed |
| S7 | admin request schema source analysis separates parameters, JSON bodies, multipart, and bodyless methods | 16 | 43 | killed |
| S8 | admin request schema source analysis refuses unmodeled request-derived parser inputs and follows imported body parsers | 17 | 44 | killed |
| S9 | admin request schema source analysis recognizes current imported schemas and shared channel parsing | 18 | 45 | killed |
| S10 | admin request schema source analysis accounts for every current admin method without runtime imports | 19 | 46 | killed |
| A1 | admin contract audit fails on edited declarations and missing or stale route rows | 20 | 47 | killed |
| A2 | admin contract audit reproduces the current contract including enriched responses and existing DTO exports | 21 | 48 | killed |
| A3 | admin contract audit regenerates an isolated contract and rejects drift through the real CLI | 22 | 49 | killed |
| A4 | admin contract audit rejects linked output roots and ancestors before reading or deleting outside artifacts | 23 | 50 | killed |
| A5 | admin contract audit emits standalone declarations without repository aliases | 24 | 51 | killed |
| A6 | admin contract audit rejects non-directory output ancestors without overwriting existing files | 25 | 52 | killed |
| X1 | compiler-derived response contracts rejects unresolved response-producing callbacks | — | — | excluded |
| X2 | admin contract audit detects route method and gate provenance drift | — | — | excluded |

X1's opaque callback/response fixtures exit through unchanged refusal paths before modified rendering/call identity/status proof. X2 calls only unchanged route-table validation. The admin-AAL2 and CI-wiring suites are not downstream consumers of these fix hunks. No changed E2E case, migration, additional shared fixture consumer or uncovered fix hunk was identified.

## Mutation evidence

Each row below preserves the semantic target and observed failure. The two supported-input over-refusals (T7/S5) occur inside the subject analyzer during the selected test, not at import/setup/compilation; they are valid behavioral kills. A1/A4/A6 use early returns so no linked or non-directory artifact action is performed by a mutant.

| Launch / case | Pinned production location | Behavioral oracle | Observed result |
| --- | --- | --- | --- |
| 26 / T1 | `scripts/ci/admin-contract-types.ts:103` | JSON-omittable unknown/callable union properties must remain optional. | AssertionError: expected '{ "batchSummary": null \| { "id": stri…' to contain '"payload"?: JsonValue' |
| 27 / T2 | `scripts/ci/admin-contract-types.ts:162` | Distinct source calls with different bindings must remain separate. | Inconclusive/oracle; later valid T2 mutation resolves the row. |
| 28 / T2 | `scripts/ci/admin-contract-types.ts:549` | Helper-call traversal must retain each bound specialization rather than deduplicate by helper declaration. | AssertionError: expected [ '503' ] to deeply equal [ '200', '503' ] |
| 29 / T3 | `scripts/ci/admin-contract-types.ts:47` | Top-level undefined must be refused rather than advertised as null. | AssertionError: expected [Function] to throw an error |
| 30 / T4 | `scripts/ci/admin-contract-types.ts:162` | Distinct source calls with different bindings must remain separate. | AssertionError: expected [ '200' ] to deeply equal [ '200', '418' ] |
| 31 / T5 | `scripts/ci/admin-contract-types.ts:277` | Mutated helper status and escaped/mutated init bindings must be refused. | AssertionError: function reply(status:number): NextResponse { status=418; return NextResponse.json({ok:true},{status}); } export function GET(){return reply(200);}: expected [Function] to throw an error |
| 32 / T5 | `scripts/ci/admin-contract-types.ts:288` | Plain-object status-source guard must refuse getter side effects and unsupported overriding members. | AssertionError: export function GET(){const init:{status:number;read:number}={status:200,get read(){this.status=418;return 0;}}; void init.read; return NextResponse.json({ok:true},{status:init.status});}: expected [Function] to throw an error |
| 33 / T6 | `scripts/ci/admin-contract-types.ts:106` | Dictionary signatures must survive shared object rendering. | AssertionError: expected '{  }' to contain '[key: string]: number \| null \| undefi…' |
| 34 / T7 | `scripts/ci/admin-contract-types.ts:313` | Constant status maps must resolve from their actual initializers. | Error: <fixture>/route.ts:8: unresolved status expression (codes[Math.random() ? 'absent' : 'blocked']) |
| 35 / T8 | `scripts/ci/admin-contract-types.ts:106` | Dictionary signatures must survive shared object rendering. | AssertionError: expected '{  }' to contain '[key: string]: JsonValue' |
| 36 / T9 | `scripts/ci/admin-contract-types.ts:102` | Source DTO unknown must survive the shared object renderer. | AssertionError: expected '{ "date": Date; "payload": JsonValue;…' to contain '"payload": unknown' |
| 37 / S1 | `scripts/ci/admin-contract-schemas.ts:281` | Reachable schema parser dispatch must distinguish parser methods from helper callbacks. | AssertionError: expected 'hand-parsed-json' to be 'json-schema' // Object.is equality |
| 38 / S2 | `scripts/ci/admin-contract-schemas.ts:158` | Changed normalization-disagreement oracle must derive exact bounds from the emitted schema. | AssertionError: expected { type: 'string', minLength: 2, …(1) } to match object { type: 'string', minLength: 1, …(1) } |
| 39 / S3 | `scripts/ci/admin-contract-schemas.ts:281` | Reachable schema parser dispatch must distinguish parser methods from helper callbacks. | AssertionError: expected undefined to match object { kind: 'refinement', path: '$.name' } |
| 40 / S4 | `scripts/ci/admin-contract-schemas.ts:281` | Reachable schema parser dispatch must distinguish parser methods from helper callbacks. | AssertionError: expected [Function] to throw an error |
| 41 / S5 | `scripts/ci/admin-contract-schemas.ts:281` | Reachable schema parser dispatch must distinguish parser methods from helper callbacks. | Error: Unsupported request schema at <fixture>/helper.ts:1:109: unmodeled request-derived parser input |
| 42 / S6 | `scripts/ci/admin-contract-schemas.ts:143` | Round-one P0 fix must reject an invented string restriction on preprocessing input. | AssertionError: expected { type: 'string' } to deeply equal {} |
| 43 / S7 | `scripts/ci/admin-contract-schemas.ts:281` | Reachable schema parser dispatch must distinguish parser methods from helper callbacks. | AssertionError: expected [] to deeply equal [ 'body', 'path' ] |
| 44 / S8 | `scripts/ci/admin-contract-schemas.ts:291` | Transformed request-derived inputs must fail closed. | AssertionError: expected [Function] to throw an error |
| 45 / S9 | `scripts/ci/admin-contract-schemas.ts:281` | Reachable schema parser dispatch must distinguish parser methods from helper callbacks. | AssertionError: expected 'hand-parsed-json' to be 'json-schema' // Object.is equality |
| 46 / S10 | `scripts/ci/admin-contract-schemas.ts:281` | Reachable schema parser dispatch must distinguish parser methods from helper callbacks. | AssertionError: expected 'hand-parsed-json' to be 'json-schema' // Object.is equality |
| 47 / A1 | `scripts/ci/admin-contract-audit.ts:42` | Public artifact audit must refuse a linked root rather than report ordinary drift. | Error: promise resolved "[ …(2) ]" instead of rejecting |
| 48 / A2 | `scripts/ci/admin-contract-types.ts:103` | Generated golden must preserve omitted properties from response JSON projection. | AssertionError: expected [ Array(1) ] to deeply equal [] |
| 49 / A3 | `scripts/ci/admin-contract-audit.ts:157` | The source host must preserve JS JSDoc numeric field information. | AssertionError: expected '// Generated by pnpm admin-contract:g…' to contain '"value": number \| null' |
| 50 / A4 | `scripts/ci/admin-contract-audit.ts:218` | Linked CLI output ancestry must fail rather than return false success; no artifact actions run. | AssertionError: expected +0 to be 1 // Object.is equality |
| 51 / A5 | `scripts/ci/admin-contract-audit.ts:19` | Standalone declarations must reject ambient DOM names. | AssertionError: expected [Function] to throw an error |
| 52 / A6 | `scripts/ci/admin-contract-audit.ts:219` | Non-directory CLI ancestry must fail rather than return false success; no artifact actions run. | AssertionError: expected +0 to be 1 // Object.is equality |

## Other verification duties

**Fragile assertions.** Inspected the changed cases and local helpers for empty partial schema matchers, exact rendered-string counts, absence-of-tag proxies and order without a contract. The original schema-order assertions now sort their complete results; preprocessing asserts the schema itself equals `{}`; normalization tests read emitted minimum/maximum constraints. Cardinality assertions represent schema/response counts, while declaration text and CLI exit assertions check the exported contract. No additional fragile assertion was identified.

**Documents versus source.** Ran the existing `prevalidate-plan.py` on all 13 changed evidence documents under `docs/reviews/feat-1190/`. It checked 36 citations: 35 resolved mechanically, and the abbreviated `businesses/options/route.ts:11` was manually resolved to `src/app/api/admin/businesses/options/route.ts:11`, which returns betaCompActive. Six historical documents produced eight earlier-HEAD mismatch warnings; they explicitly identify earlier reviewed pins, so those lines are historical provenance, not assertions that today's HEAD equals an old commit. Their preserved citations were reconciled with current source by subject: node identity at types:162, binding key:549, shared renderer:88/:377, stable-status/read proof:193/:235/:288, schema provenance:223/:281/:291/:298, ancestry audit:215–223, source JSDoc host:157, and standalone libraries:19. The current behavior is validated by the individual cases and A2's complete generated-file comparison. No changed plan/ADR/generated-README delta exists inside the round-2 fix boundary.

The performance evidence documents remain explicitly historical measurements. Their existing raw timing records independently corroborate the 5532.08 ms failing reproduction, 4776.33 ms type-info result, 4172.29 ms ES-library result, 27 passing consolidated proof cases (512.90 ms status case / 4377.07 ms golden), and 10 passing final response cases (505.67 ms status case). This pass does not claim to have repeated a CPU profile or full gate. No misleading current source claim was identified.

**Missed siblings.** Recorded searches scoped to `scripts`, `src`, the three implementation modules and direct suites: `admin-contract-(audit|types|schemas)`, `docs/admin-api`, `admin-api.d.ts`, `renderObjectType`, `node.getStart`, `environmentIdentity`, `isProvenRead`, `withStatusProof`, `requestDerived`, `isSymbolicLink`, `isDirectory`, `getLineAndCharacterOfPosition|visited|const key|binding`, empty-schema `toMatchObject`/`email: {}`, and path/location `map(...).toEqual` patterns. The schema analyzer's diagnostic locations are not response-call identity keys; its schema deduplication includes source location and request location. Public audit-root and CLI-ancestor guard siblings are both covered. No further in-scope sibling requiring a new candidate or finding was identified. Unchanged resolver internals, runtime routes, unrelated evaluator features, E2E and migrations were excluded from new fronts.

**Operational completeness.** The fix adds source-analysis/CLI refusal behavior and synchronous CI diagnostics, with no new runtime worker/webhook swallowed or terminal failure lane. CLI exceptions propagate to the existing stderr/nonzero-exit boundary, covered by A3/A4/A6; no new Sentry signal or beta-launch alert rule is introduced or required by these developer-tooling fixes. Browser testing does not apply to this export/audit-only change because no browser journey or runtime API changes; individual compiler, real CLI, standalone-consumer and golden checks are the relevant integration evidence.

## Authorizations

This section is rendered from the sidecar's authorization array. Both original finding ids are listed because the approved continuation measures their fixes. The scope is operational, not an accepted-risk disposition.

### owner-1190-round2-operation

Date: 2026-09-10. Finding ids: RT-1190-P0-1, RT-1190-P1-1.

> Question: Do you approve this round-two operation at 24715f20, including the 75-launch ceiling and temporary preview pause?
> Owner: Go for it

## Attributed final source-correctness verification

The invoking feature lead requested durable preservation of the following independent source-review evidence inside this allowed report artifact. Original reviewer: `/root/feature_1190/correctness_review`. Source: `.feature/review-staging/spec-correctness-c2-verification-final.md`; independently checked SHA-256: `b0d0c85bc4c4e8d31e175bb315eb8cca0d6a46f72e8008f99eea52c98c73324d`.

The enclosed text is reproduced verbatim. Its first-person statements and source-review conclusions belong to that original reviewer; they are not new mutation findings or a source review performed by this verifier. Its own scope and authorization limitations remain intact.

<details>
<summary>Original reviewer’s formal final C2 verification at 24715f20</summary>

# #1190 formal final C2 verification

**Verdict: APPROVED. The accepted C2/C2V/C2W finding and consolidated CR1–CR6 packet are fixed at the exact reviewed pin. No actionable C2 remainder was found.**

## Exact provenance and gate evidence

- Reviewed commit: `24715f20b19ab6ab2720ced39bb3f6e7717192d6`.
- Final source blob, `scripts/ci/admin-contract-types.ts`: `c07660b0f3191555b1c785b7d9c3a791bfaa232b`.
- Final test blob, `scripts/ci/__tests__/admin-contract-types.test.ts`: `3b7b461c191c2b2c0bba5eee632d53e732a4a340`.
- The source blob exactly matches the candidate whose bounded diagnostic preparation I previously closed. The final test source retains that candidate's matrix and adds the two CR6 numeric/string-key modules.
- `git rev-parse` independently resolved the exact commit and both blobs. `git status --porcelain` returned no tracked or untracked changes before this ignored report was authored.
- The read-only fingerprint check independently returned: `gate fingerprint current: 670e1bd1a489cde0de905cd0adbdbbce847e82e297f072fe52bc31137b4af5dd`.
- The stored fingerprint identifies this head and the original base `8b92d85395f902879d93748b5929b0b503c0ad86`. The intake, gate-status, and lockfile SHA-256 values were also independently compared with the stored evidence and matched.
- `.feature/gate-status.json` records `passed: true`, `mode: full`, and PASS for all rows, including typecheck, tests, admin-contract, build, promised tests, and diff coverage. `/private/tmp/1190-final-full-24715f20.log` ends with the same full-green status and current fingerprint.
- Recorded execution output was inspected: `.feature/logs/test.log` reports **14,698 passed tests in 1,070 passed files**; the promised focused log reports **224 passed tests in five files**; `.feature/logs/admin-contract.log` reports **36 routes, 19 byte-identical artifacts, and verified canonical gate provenance**.

These are inspected execution records tied to a freshly checked current fingerprint. I did not rerun tests, builds, audits, or the full gate during this verification. No source/test edit, mutation, process operation, or commit was performed. The authorized report path-rules check returned `none` before authoring.

## Finding and packet closure

| Accepted issue / diagnostic group | Final source and oracle evidence | Disposition |
| --- | --- | --- |
| Original mutable local, reassigned parameter, and mutated named-init values | Status proof precedes both bound-parameter substitution at `admin-contract-types.ts:307` and const substitution at `:312`. The reference proof rejects unproven writes/escapes before an initial value can be substituted. The retained refusal matrix covers direct, conditional, compound, captured, property, alias, helper, and delete/update cases. | Fixed |
| C2W iteration targets and initialized parameter redeclarations | The proven-read classifier propagates assignment/pattern containers to their enclosing use, distinguishes loop expressions from targets, and rejects initialized same-symbol redeclarations. Tests at `admin-contract-types.test.ts:110–123` cover in/of/await-of, scalar/property/destructured targets, var-loop targets, initialized scalar/object/array binding declarations, and rest targets. | Fixed |
| CR1 shorthand default symbol provenance and read/target distinction | `symbolAt` at `admin-contract-types.ts:170–175` uses shorthand-value lookup only for the shorthand name. `isProvenRead` separately accepts `objectAssignmentInitializer` as a value read. The tests distinguish default-target refusal (`test.ts:124`), default-object-alias refusal (`:125`), and scalar assignment-default preservation (`:144`). This closes the missing-reference escape as well as preserving the legitimate read. | Fixed |
| CR2 accessor/prototype effects and member precedence | The source-level boundary at `admin-contract-types.ts:288–300` permits only unique static data/shorthand members while proving status. It refuses accessors, methods, spreads, computed names, prototype keys, and duplicates; type annotations cannot conceal those source forms. Nested selected literals receive the same check as resolution reaches them. Separate tests at `test.ts:126–132` cover annotated getter, prototype getter, spread override, computed override, duplicate status, and nested getter. | Fixed |
| CR3 remaining explicit target families | The final matrix separately exercises var-for-in ownership, initialized array binding, array/object rest assignment, and shorthand default target. These remain individual fixture modules with their own refusal oracle. | Closed |
| CR4 preserved read contexts | Positive modules retain scalar and named-init helper support, truthiness/conditional aliases, shadowing and captured reads, wrappers/chained properties, harmless uninitialized redeclarations, iteration-source reads, default reads, and the grouped initializer/value/control/type contexts at `test.ts:135–154`. Each module asserts its exact status list. | Closed |
| CR5 unsupported reference position | The named-export fixture at `test.ts:130` must refuse through the unproven-reference/object boundary rather than relying only on an `export` modifier on the declaration. | Closed |
| CR6 static key acceptance and duplicate canonicalization | `admin-contract-types.ts:297–299` canonicalizes numeric keys before duplicate checking. The final added refusal at `test.ts:133` uses numeric `1` and string `"1"`; the added preservation at `:145` accepts quoted status and numeric/static metadata keys and requires status 200. | Closed |

## Caller and regression assessment

The final T5 matrix contains **40 refusal and 11 preservation modules** in one TypeScript program. Each module has its own exported handler and is evaluated against its own source file. Every refusal still requires an `unresolved status` error; every preservation still requires the expected status list (`admin-contract-types.test.ts:166–172`). No cases are replaced by counts, sampling, or a weaker success-only oracle.

The proof remains scoped to JSON init/status resolution (`admin-contract-types.ts:518`, `:524`) with restoration through `finally`; ordinary response body rendering remains outside it. The existing mutated-body/unused-helper regression case remains in the suite. Current route compatibility and artifact equality are supported by the inspected green full/focused results and the byte-identical admin-contract audit, not assumed merely from the small source delta.

The relevant own-axis checklist lessons were applied: source inventories and symbol identity must control coverage, test oracles must distinguish the actual defect from coincidental output, all directly affected helper forms must be represented, and claimed verification must match available evidence. The original C2 counterexamples and the completed diagnostic packet now have both corresponding source corrections and meaningful refusal/preservation assertions.

## Scope and limits

This is the formal closure of my remaining accepted C2 finding at the exact pin above. C1/C3/C4 and the earlier compiler-option review were not reopened; their prior dispositions remain recorded separately. No other reviewer's conclusion was used as a substitute for this source/test inspection.

This approval does not claim mutation kills or resolve a red-team P0/P1 without its required measurement. It does not authorize staging operations, a mutation-budget expansion, process pauses, or merge. Within the requested source-correctness verification scope, there is no remaining actionable approval blocker.

</details>

## Historical round 1 — retained verbatim

The following report records the earlier measured pin and former findings. Its OPEN_P0 verdict and inventory outcomes are historical; the current round-2 findings, launch accounting and strict sidecar above supersede them. Prior authorizations and measurements are not silently reclassified.

<details>
<summary>Round-1 report at 6c42b805 (superseded by this round)</summary>

# Red-team verification — #1190, round 1

Status: **OPEN_P0**. All 26 affected candidates were measured: 25 killed a meaningful mutant and one survived a confirmed meaningful mutant. There are no skipped or unresolved inventory rows. The pass used 53 supervised launches: 26 green individual baselines and 27 mutant runs. No test was selected by sampling.

## Pinned scope and independently checked evidence

Branch: feat/1190. Fork and merge base: 8b92d85395f902879d93748b5929b0b503c0ad86. Reviewed implementation HEAD: 6c42b8050acdeac698171a57d26b56d4fcbd8fcf. Intake SHA-256: 16436c490ea7897e2d478ff0c914889ba89b6d6cb8634b9d2fe555bc169ec95d. Risk: high.

The verifier read the locked intake, the referenced ADR as contract evidence, the immutable diff, source, tests and gate metadata. It did not consume implementer reasoning or other reviewers’ reports. Preparation confirmed the clean committed tree, merge base and both runner hashes. The full-gate fingerprint digest was independently recomputed as 30e17684a306fea6b1c925f7e315326eb2c0eb214a536fa1013a90e45c852795; intake, gate-status and lockfile digests matched its evidence. The status file records a full PASS including build. This verifier did not rerun the 14,692-test full gate or build during mutation: those remain supplied gate evidence, not a new claim of execution here. Individual baseline reports independently discovered 218 focused cases (7 types, 9 schemas, 5 audit, 118 AAL2 and 79 wiring), and executed each of the 26 affected candidates exactly once before mutation.

Direction A includes every added test case and the three new ci:admin-contract instances in existing parameterized wiring tests. No shared test helper, snapshot or golden changed; no test was deleted. Direction B reverse-import searches reach the three new compiler/audit modules through their dedicated suites and the real-contract/isolated-CLI cases; the DTO barrel and committed generated artifacts reach the real-contract case; canonical gate names reach G1 and real-contract generation; package, workflow and pre-push additions reach W1–W4. The existing AAL2 boolean consumers do not consume the new names field. The .some-to-loop rewrite preserves their existing boolean semantics because importedAs is a pure predicate and callsGate remains true exactly when any canonical gate matches. No new behavior-bearing production surface was left without an identified candidate. There are no changed Playwright/E2E specs or migrations to exclude.

## Findings

| ID | Severity | Location | Finding | Disposition |
| --- | --- | --- | --- | --- |
| RT-1190-P0-1 | P0 | scripts/ci/__tests__/admin-contract-schemas.test.ts:98 | Empty schema matcher does not protect preprocessing input uncertainty | open |
| RT-1190-P1-1 | P1 | scripts/ci/__tests__/admin-contract-schemas.test.ts:97 | Schema discovery assertions require an undocumented array order | open |

### RT-1190-P0-1 — preprocessing uncertainty has a false oracle

A meaningful mutation narrowing the preprocess input projection from unknown to string survives the individual test. Assert the email schema itself equals an unrestricted schema, and check a representative non-string input accepted after preprocessing; the current nested empty-object partial matcher accepts arbitrary added constraints.

Arbiter confirmation: The test fixture at lines 93–96 actually reaches the preprocess branch with z.preprocess(value => String(value), z.string()). The mutant replaces return z.unknown() with return z.string() at scripts/ci/admin-contract-schemas.ts:143, so the input projection now adds type: string and rejects non-string inputs that preprocessing can convert successfully. The baseline and mutant each ran exactly this one test and both passed. This is not equivalent and not an unexecuted branch: that fixture contains the preprocess expression, the source-only evaluator returns the mutated schema for its email field, and z.toJSONSchema projects that schema. The line-98 toMatchObject expectation contains email: {}, which accepts any extra properties on email, including the incorrect type restriction. Therefore the assertion does not enforce the preprocessing uncertainty named by the test.

The baseline was launch 13 and the surviving mutant was launch 40. Each report contains exactly one executed case: admin request schema source analysis preserves union normalization paths and preprocessing uncertainty. The mutant ran successfully; this is not an import error, type error, setup failure, timeout or non-compiling mutation. No later unrelated assertion failure is used to hide this survivor.

### RT-1190-P1-1 — incidental traversal order

Line 97 requires limitation paths in the exact order [$.name, $.email], and line 110 requires schema locations in the exact order [path, body]. The locked intake, ADR 0028 and RequestSchemasResult interface require complete deterministic output but specify neither of these source-traversal orders. Another deterministic traversal can preserve the behavior while failing these tests. Compare normalized sets or sorted arrays, or use unordered membership plus exact cardinality; retain direct assertions for each schema and body classification.

Other changed assertions on omitted callback fields, private import aliases and source response names directly express the JSON serialization/portability contract. Array cardinality checks count schema or response records, not incidental rendered-string occurrences. No absence-of-heading-tag proxy or exact rendered-string count was added.

## Complete mutation inventory

| Case | Baseline launch | Mutant launch | Target | Expected behavioral oracle | Outcome |
| --- | --- | --- | --- | --- | --- |
| T1 | 1 | 27 | scripts/ci/admin-contract-types.ts:62 | Date wire type must include null | killed |
| T2 | 2 | 29 | scripts/ci/admin-contract-types.ts:242 | Default successful response status is 200 | killed |
| T3 | 3 | 30 | scripts/ci/admin-contract-types.ts:41 | Top-level unknown source must refuse generation | killed |
| T4 | 4 | 31 | scripts/ci/admin-contract-types.ts:419 | Opaque response return beside a JSON response must refuse | killed |
| T5 | 5 | 32 | scripts/ci/admin-contract-types.ts:258 | Finite domain statuses must preserve actual codes | killed |
| T6 | 6 | 33 | scripts/ci/admin-contract-types.ts:407 | Uncalled local helper must not contribute 418 response | killed |
| T7 | 7 | 34 | scripts/ci/admin-contract-types.ts:40 | Source DTO unknown must remain unknown | killed |
| S1 | 8 | 35 | scripts/ci/admin-contract-schemas.ts:158 | Imported max constant must project exact maxLength 12 | killed |
| S2 | 9 | 36 | scripts/ci/admin-contract-schemas.ts:272 | Normalization must mark approximation | killed |
| S3 | 10 | 37 | scripts/ci/admin-contract-schemas.ts:132 | Refinement callback source must be retained | killed |
| S4 | 11 | 38 | scripts/ci/admin-contract-schemas.ts:104 | Mutable schema dependency must refuse | killed |
| S5 | 12 | 39 | scripts/ci/admin-contract-schemas.ts:158 | Strict object through bound parser must forbid additionalProperties | killed |
| S6 | 13 | 40 | scripts/ci/admin-contract-schemas.ts:143 | Preprocessed input must retain unknown input domain | survived-confirmed-P0 |
| S7 | 14 | 41 | scripts/ci/admin-contract-schemas.ts:308 | FormData reader must classify multipart | killed |
| S8 | 15 | 42 | scripts/ci/admin-contract-schemas.ts:308 | Current channel start must classify hand-parsed JSON | killed |
| S9 | 16 | 43 | scripts/ci/admin-contract-schemas.ts:308 | Current unsuspend and suppression lookup must classify JSON schema | killed |
| A1 | 17 | 44 | scripts/ci/admin-contract-audit.ts:61 | Edited declaration must report changed artifact | killed |
| A2 | 18 | 45 | scripts/ci/admin-contract-audit.ts:87 | Wrong gate column must report provenance drift | killed |
| A3 | 19 | 46 | scripts/ci/admin-contract-audit.ts:29 | Unresolved private type must fail standalone compiler check | killed |
| A4 | 20 | 47 | src/lib/admin/api-contract.ts:20 | Missing existing DTO must cause artifact drift and missing export | killed |
| A5 | 21 | 48 | scripts/ci/admin-contract-audit.ts:208 | Regeneration must remove stale fixture artifact | killed |
| G1 | 22 | 49 | scripts/ci/admin-aal2-audit.ts:574 | Canonical gate name must survive alias and wrapped handler | killed |
| W1 | 23 | 50 | package.json:33 | Package must register ci:admin-contract | killed |
| W2 | 24 | 51 | .github/workflows/ci.yml:184 | Registered contract audit must execute in a workflow | killed |
| W3 | 25 | 52 | lefthook.yml:35 | CI contract audit must also execute on local pre-push | killed |
| W4 | 26 | 53 | package.json:33 | Invoked contract audit must exist in package scripts | killed |

Exact candidate identities, selectors and semantic changes:

- **T1** — scripts/ci/__tests__/admin-contract-types.test.ts; compiler-derived response contracts emits portable wire declarations for composed responses and JSON serialization.
  Selector: `compiler-derived response contracts emits portable wire declarations for composed responses and JSON serialization`. Mutation: ``if (type.getSymbol()?.getName() === 'Date') return wire ? 'string \| null' : 'Date';`` → ``if (type.getSymbol()?.getName() === 'Date') return wire ? 'string' : 'Date';``.
  Result: AssertionError: expected '{ "batchSummary": null \| { "id": stri…' to contain '"date": string \| null'
- **T2** — scripts/ci/__tests__/admin-contract-types.test.ts; compiler-derived response contracts specializes nested response helpers and configuration callbacks.
  Selector: `compiler-derived response contracts specializes nested response helpers and configuration callbacks`. Mutation: ``if (ts.isNumericLiteral(bound.node)) return bound.node.text;`` → ``if (ts.isNumericLiteral(bound.node)) return bound.node.text === '200' ? '201' : bound.node.text;``.
  Result: AssertionError: expected [ '201', '503' ] to deeply equal [ '200', '503' ]
- **T3** — scripts/ci/__tests__/admin-contract-types.test.ts; compiler-derived response contracts rejects unsupported wire response types.
  Selector: `compiler-derived response contracts rejects unsupported wire response types`. Mutation: ``if (!nested) throw new Error(`${location(at)}: unresolved top-level unknown/any JSON body`);`` → ``if (!nested) return 'JsonValue';``.
  Result: AssertionError: expected [Function] to throw an error
- **T4** — scripts/ci/__tests__/admin-contract-types.test.ts; compiler-derived response contracts rejects unresolved response-producing callbacks.
  Selector: `compiler-derived response contracts rejects unresolved response-producing callbacks`. Mutation: ``if (!ts.isCallExpression(producer.node)) throw new Error(`${location(node)}: unresolved response return (${node.expression.getText()})`);`` → ``if (!ts.isCallExpression(producer.node)) return;``.
  Result: AssertionError: expected [Function] to throw an error
- **T5** — scripts/ci/__tests__/admin-contract-types.test.ts; compiler-derived response contracts derives finite status codes from domain errors and constant lookup maps.
  Selector: `compiler-derived response contracts derives finite status codes from domain errors and constant lookup maps`. Mutation: ``if (ts.isNumericLiteral(node)) return [Number(node.text)];`` → ``if (ts.isNumericLiteral(node)) return [Number(node.text) + 1];``.
  Result: AssertionError: expected [ '405, 423', '410' ] to deeply equal [ '404, 422', '409' ]
- **T6** — scripts/ci/__tests__/admin-contract-types.test.ts; compiler-derived response contracts does not include uncalled local response helpers or erase mutated local flow types.
  Selector: `compiler-derived response contracts does not include uncalled local response helpers or erase mutated local flow types`. Mutation: ``if (returnedClosure && node.body) visit(node.body, env, true);`` → ``if (node.body) visit(node.body, env, true);``.
  Result: AssertionError: expected [ '418', '400' ] to deeply equal [ '400' ]
- **T7** — scripts/ci/__tests__/admin-contract-types.test.ts; compiler-derived response contracts preserves source DTO uncertainty separately from successful JSON wire types.
  Selector: `compiler-derived response contracts preserves source DTO uncertainty separately from successful JSON wire types`. Mutation: ``if (!wire) return type.flags & ts.TypeFlags.Any ? 'unknown' : 'unknown';`` → ``if (!wire) return 'JsonValue';``.
  Result: AssertionError: expected '{ "date": Date; "payload": JsonValue;…' to contain '"payload": unknown'
- **S1** — scripts/ci/__tests__/admin-contract-schemas.test.ts; admin request schema source analysis generates request schemas without importing runtime modules.
  Selector: `admin request schema source analysis generates request schemas without importing runtime modules`. Mutation: ``return Reflect.apply(method, target, args);`` → ``return Reflect.apply(method, target, operation === 'max' ? [Number(args[0]) + 1] : args);``.
  Result: AssertionError: expected { …(5) } to match object { Object (type, properties) }
- **S2** — scripts/ci/__tests__/admin-contract-schemas.test.ts; admin request schema source analysis labels padded and whitespace-only normalization disagreements.
  Selector: `admin request schema source analysis labels padded and whitespace-only normalization disagreements`. Mutation: ``approximation: result.limitations.length > 0`` → ``approximation: false``.
  Result: AssertionError: expected false to be true // Object.is equality
- **S3** — scripts/ci/__tests__/admin-contract-schemas.test.ts; admin request schema source analysis records refinements without executing their callbacks.
  Selector: `admin request schema source analysis records refinements without executing their callbacks`. Mutation: ``path, operation, source });`` → ``path, operation, source: '' });``.
  Result: AssertionError: expected '' to contain 'never execute'
- **S4** — scripts/ci/__tests__/admin-contract-schemas.test.ts; admin request schema source analysis refuses unsupported dynamic schema dependencies and getters.
  Selector: `admin request schema source analysis refuses unsupported dynamic schema dependencies and getters`. Mutation: ``if (!(declaration.parent.flags & ts.NodeFlags.Const)) return refuse(node, 'mutable schema dependency');`` → ``if (false) return refuse(node, 'mutable schema dependency');``.
  Result: AssertionError: expected [Function] to throw an error
- **S5** — scripts/ci/__tests__/admin-contract-schemas.test.ts; admin request schema source analysis binds callback and parser parameters without including unused callbacks.
  Selector: `admin request schema source analysis binds callback and parser parameters without including unused callbacks`. Mutation: ``return Reflect.apply(method, target, args);`` → ``return Reflect.apply(receiver === ZOD && operation === 'strictObject' ? z.object : method, target, args);``.
  Result: AssertionError: expected { …(5) } to match object { type: 'object', …(1) }
- **S6** — scripts/ci/__tests__/admin-contract-schemas.test.ts; admin request schema source analysis preserves union normalization paths and preprocessing uncertainty.
  Selector: `admin request schema source analysis preserves union normalization paths and preprocessing uncertainty`. Mutation: ``return z.unknown();`` → ``return z.string();``.
  Result: Passed with the wrong restricted preprocessing schema; confirmed by the arbiter reasoning above.
- **S7** — scripts/ci/__tests__/admin-contract-schemas.test.ts; admin request schema source analysis separates parameters, JSON bodies, multipart, and bodyless methods.
  Selector: `admin request schema source analysis separates parameters, JSON bodies, multipart, and bodyless methods`. Mutation: ``multipart ? 'multipart' : schemas.some`` → ``false ? 'multipart' : schemas.some``.
  Result: AssertionError: expected 'none' to be 'multipart' // Object.is equality
- **S8** — scripts/ci/__tests__/admin-contract-schemas.test.ts; admin request schema source analysis recognizes current imported schemas and shared channel parsing.
  Selector: `admin request schema source analysis recognizes current imported schemas and shared channel parsing`. Mutation: ``json ? 'hand-parsed-json' : 'none'`` → ``json ? 'none' : 'none'``.
  Result: AssertionError: expected 'none' to be 'hand-parsed-json' // Object.is equality
- **S9** — scripts/ci/__tests__/admin-contract-schemas.test.ts; admin request schema source analysis accounts for every current admin method without runtime imports.
  Selector: `admin request schema source analysis accounts for every current admin method without runtime imports`. Mutation: ``schemas.some((entry) => entry.location === 'body') ? 'json-schema'`` → ``schemas.some((entry) => entry.location === 'body') ? 'hand-parsed-json'``.
  Result: AssertionError: expected 'hand-parsed-json' to be 'json-schema' // Object.is equality
- **A1** — scripts/ci/__tests__/admin-contract-audit.test.ts; admin contract audit fails on edited declarations and missing or stale route rows.
  Selector: `admin contract audit fails on edited declarations and missing or stale route rows`. Mutation: ``if (existing !== contents) {`` → ``if (false) {``.
  Result: AssertionError: expected '' to contain 'admin-api.d.ts'
- **A2** — scripts/ci/__tests__/admin-contract-audit.test.ts; admin contract audit detects route method and gate provenance drift.
  Selector: `admin contract audit detects route method and gate provenance drift`. Mutation: ``if (columns[2] !== row.gates.join('<br>'))`` → ``if (false)``.
  Result: AssertionError: expected '' to contain 'gate'
- **A3** — scripts/ci/__tests__/admin-contract-audit.test.ts; admin contract audit emits standalone declarations without repository aliases.
  Selector: `admin contract audit emits standalone declarations without repository aliases`. Mutation: ``if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {`` → ``if (false) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {``.
  Result: AssertionError: expected [Function] to throw an error
- **A4** — scripts/ci/__tests__/admin-contract-audit.test.ts; admin contract audit reproduces the current contract including enriched responses and existing DTO exports.
  Selector: `admin contract audit reproduces the current contract including enriched responses and existing DTO exports`. Mutation: ``export type { DemoListItem } from '@/lib/demos/types';`` → ``(removed)``.
  Result: AssertionError: expected [ Array(1) ] to deeply equal []
- **A5** — scripts/ci/__tests__/admin-contract-audit.test.ts; admin contract audit regenerates an isolated contract and rejects drift through the real CLI.
  Selector: `admin contract audit regenerates an isolated contract and rejects drift through the real CLI`. Mutation: ``if (!generated.files.has(file)) await rm(join(destination, file));`` → ``if (!generated.files.has(file)) continue;``.
  Result: AssertionError: expected true to be false // Object.is equality
- **G1** — scripts/ci/__tests__/admin-aal2-audit.test.ts; scanRouteFile — admin AAL2 gate audit reports canonical gate names for every exported method.
  Selector: `scanRouteFile — admin AAL2 gate audit reports canonical gate names for every exported method`. Mutation: ``evidence.names.add(fn);`` → ``void fn;``.
  Result: AssertionError: expected [ { method: 'GET', gates: [] }, …(2) ] to deeply equal [ { method: 'GET', …(1) }, …(2) ]
- **W1** — src/__tests__/ci-audit-wiring.test.ts; ci:* audit wiring includes the generated Admin API contract in package, lint CI and local pre-push.
  Selector: `ci:\* audit wiring includes the generated Admin API contract in package, lint CI and local pre-push`. Mutation: ``"ci:admin-contract": "tsx scripts/ci/admin-contract-audit.ts",`` → ``"unused-admin-contract": "tsx scripts/ci/admin-contract-audit.ts",``.
  Result: AssertionError: expected [ 'ci:tenant-scope', …(22) ] to include 'ci:admin-contract'
- **W2** — src/__tests__/ci-audit-wiring.test.ts; ci:* audit wiring ci:admin-contract runs in some workflow, or is ungated with a reason.
  Selector: `ci:\* audit wiring ci:admin-contract runs in some workflow, or is ungated with a reason`. Mutation: ``run: pnpm ci:admin-contract`` → ``run: pnpm unused-admin-contract``.
  Result: AssertionError: expected { script: 'ci:admin-contract', …(2) } to deeply equal { script: 'ci:admin-contract', …(2) }
- **W3** — src/__tests__/ci-audit-wiring.test.ts; ci:* audit wiring ci:admin-contract also runs in lefthook.yml.
  Selector: `ci:\* audit wiring ci:admin-contract also runs in lefthook\.yml`. Mutation: ``run: pnpm ci:admin-contract`` → ``run: pnpm unused-admin-contract``.
  Result: AssertionError: expected false to be true // Object.is equality
- **W4** — src/__tests__/ci-audit-wiring.test.ts; ci:* audit wiring ci:admin-contract is a real package.json script.
  Selector: `ci:\* audit wiring ci:admin-contract is a real package\.json script`. Mutation: ``"ci:admin-contract": "tsx scripts/ci/admin-contract-audit.ts",`` → ``"unused-admin-contract": "tsx scripts/ci/admin-contract-audit.ts",``.
  Result: AssertionError: expected [ 'ci:tenant-scope', …(22) ] to include 'ci:admin-contract'

T2 attempt 1 (launch 28) changed statusText(undefined) from 200 to 201, but the fixture’s helper supplies a bound numeric initializer. This attempt was unexecuted and therefore non-evidence: neither a kill nor a P0. After lead restoration, attempt 2 (launch 29) changed the exercised bound literal from 200 to 201; the test failed with actual [201, 503] versus expected [200, 503]. It used the permitted second mutation and resolved the inventory row without erasing the first attempt.

Raw per-launch JSON reports, logs, summaries and mutant-source bytes are retained in /private/tmp/1190-redteam-results for this local run. The durable sidecar carries every candidate, disposition and reason; temporary logs are not needed to reconstruct the tested mutation from this report.

## Documentation checked against HEAD

The installed prevalidate-plan.py was run on the changed plan, deviation record and ADR: all passed; the first two contain no path:line citations and the ADR has one resolving citation. Source semantics were checked separately. All 17 generated x-repworth-source path/line/column coordinates resolve to the actual schema initializer. Independent filesystem and direct-export inventories match all 36 README route rows and all 39 exported HTTP methods, with no missing/stale route or method. The method-specific enriched fields resolve to businesses/[id]/route.ts:42 (batchSummary) and businesses/options/route.ts:11 (betaCompActive). The barrel contains only type re-exports, and the real-contract and standalone-emission baseline cases pass.

README claims about proxy Unauthorized/Forbidden/AAL refusals, bearer selection, the CORS origin refusal and legacy impersonation were checked against src/proxy.ts and src/lib/auth/admin-mfa-gate.ts. The batch-halt status union on 404/409 is present in the actual route. The generated schema approximations and source DTO versus wire uncertainty are visible in the generator and their focused cases. No newly introduced false documentation claim was found. ADR context retains its pre-existing route-helpers.ts:52 citation, while errorResponse is now at line 73; the identical citation and helper layout already exist at the merge base, so this unrelated historical staleness is recorded but not opened as a new finding. Other reviewers’ reports were excluded from reading to preserve the instructed independence boundary.

## Missed-sibling search

Searches were read-only and scoped to source/test counterparts of this change:

- `admin-contract|admin-aal2-audit|api-contract` across test files under scripts and src found the expected four audit suites and wiring test; the auth-suite occurrence is an explanatory comment, not a new importer.
- `renderJsonType|describeResponses|generateRequestSchemas|describeRouteHandlers` across production TypeScript under scripts and src found the new generator and shared AAL2 resolver as the only owners/consumers of these contract seams.
- `HANDLER_VERBS|GATE_FNS|CANONICAL.gate` in admin audit scripts found only the canonical AAL2 inventory/provenance implementation; no duplicate gate parser was introduced.
- Unsupported export forms, new Response/NextResponse, redirect/rewrite responses and text/arrayBuffer/blob/bytes readers were searched in current admin route files. The sole body-reader match was uploaded-file `file.text()` in csv-import, correctly distinct from a Request body reader; its route is classified multipart.
- `toMatchObject` with an empty expected object subtree was searched across scripts/ci/__tests__ and src/__tests__; the only match was the confirmed line-98 preprocessing oracle. The other changed partial matchers require concrete type, length or additionalProperties values.

Unchanged unrelated test suites, historical reviewer reasoning, migrations and runtime behavior outside this contract change were not opened as new verification fronts. A zero-additional-sibling result is recorded as such.

## Operational completeness and restoration

No runtime route, worker, webhook, database, feature-flag or provider-call implementation changed. The added terminal failures belong to a developer/CI command: main catches them, prints the actionable error, sets exitCode 1, and closes its temporary artifact directory in finally. There is no added deployed Sentry signal or operator alert-rule row to pair. The six operational alert facets (identity, filter, level, grouping title, threshold/cadence and destination action) therefore have no newly introduced runtime comparison in this diff; the beta-launch alert-rule table was inspected for this scope. Browser verification does not apply to these compiler/CLI mutations; no browser or production journey was executed by this verifier.

Before each mutate and each run, in the same elevated process-visible context, ps command inspection had to exit 0 with output suppressed, a separate nonempty PID list had to include the checking shell, and the unchanged canonical watcher check had to report clear. HEAD and runner hashes were checked each time. No guard failure or new watcher occurred. Every run used the same temporary HOME, canonical environment allowlist, no database argument, live-DB disable switch, and scrubbed on-disk dotenv. The timeout remained 120000 ms; no candidate used more than two mutations.

The invoking lead finalized after every mutant and reopened the same scrubbed dotenv only after restoration. No stacked source mutation was carried forward and the launch counter was never reset. Final confirmation preceded creation of either report artifact: all 53 supervisor entries inactive, all 27 mutation entries restored, dotenv closed, tracked tree clean at the pinned HEAD. The lead reports the original preview command/cwd restarted at 16:56:52 PDT after a 20m02s pause, before the 17:21:50 PDT cutoff. The verifier did not signal processes or perform finalization. Report-time journal inspection independently confirms runs=53, round=1, no active supervisors and no journal errors.

## Operation approval evidence

The owner’s operation approval is budget/environment authority only, not acceptance of either finding. The strict sidecar authorizations array is reserved for finding-linked adjudications and remains empty. The complete operation record is retained here so its scope does not depend on ignored scratch files:

# #1190 round-1 operation authorization

Recorded 2026-09-10 from the owner reply relayed by the orchestrator `/root`.

Verbatim owner reply: **I approve.**

The reply approves the immediately preceding root request for the exact proposal
SHA-256 `53d7b3f1e438399404b7e640a2b8b035b3ececf81594cebbc4d8aa4cd9b9c7a5`:
78 TOTAL supervised launches for #1190 round 1 at committed head
`6c42b8050acdeac698171a57d26b56d4fcbd8fcf`, at most two mutants per candidate,
120000 ms per run, no round reset or additional retry allowance. The temporary
runner `/private/tmp/1190-mutation-runner-proposed.mjs`, SHA-256
`94fb4a29be056939c943b18cf5caedf5a41eb46e599059d9f4c1ea7aaee32d35`, may serve
only `run`; the original runner owns every other operation and finalization.

The approval includes graceful temporary pause of the port 3101 parent preview
only after freshly verifying its port, cwd, command and process identity; never
stop parent PID 8575 or another watcher. Restart the same command/cwd after the
original finalizer and restoration checks. Expected interruption 15–25 minutes;
end measurement within 45 minutes of pause, then complete cleanup/startup.
Original undocumented process-only environment overrides were not preserved;
restart uses the normal shell and existing workspace configuration, as disclosed.
There is no permission for SIGKILL, broad process termination, production writes,
new rounds above their ordinary budget, or merge.

Before execution the lead rechecked the exact head, clean tracked tree, current
green fingerprint `30e17684a306fea6b1c925f7e315326eb2c0eb214a536fa1013a90e45c852795`,
the unchanged proposal and both runner hashes. The original journal reports
round 0, runs 0, no mutations, no open dotenv swap and no supervisors.

This authorization will be retained with the final review evidence; it does not
change the frozen implementation or claim that measurement has begun.

## Execution start

At 2026-09-10 16:36:50 PDT (epoch 1789083410), the lead freshly verified listener
14527 and launcher 14493 against exact port, command, cwd, parents and start
times, then sent only SIGTERM to those two processes. Parent 8575 was untouched.
Process-visible canonical watchers subsequently returned clear. Canonical
round-start opened round 1 with zero launches; its default-cap message is 30,
while only the approved run-only copy permits the authorized ceiling of 78.
Canonical dotenv-swap scrubbed one file, `.env.local`, with its atomic backup.
The verifier uses `/private/tmp/1190-redteam-home-round1`, no database argument,
and the canonical allowlist/live-DB kill switch for every run.

Measurement cutoff: epoch 1789086110, 2026-09-10 17:21:50 PDT. The feature lead
runs the original finalizer after each mutant, then reopens the identical dotenv
swap before authorizing the next mutant. The verifier cannot write reports until
the lead confirms final restoration. This avoids stacked mutations in the
canonical journal and does not reset its launch counter.

## Completion and restoration

Round 1 completed all 26 candidates using 53 supervised launches: 26 green
individual baselines and 27 mutant measurements. Twenty-five candidates killed
a meaningful mutant; one confirmed survivor exposes an insufficient preprocessing
schema assertion. The second attempt for the helper-status case resolved its
first unexecuted-branch attempt. No candidate remains unexecuted or unresolved.

The original finalizer confirmed all 53 journaled process groups empty, all 27
mutation entries restored, no active supervisor and no open dotenv swap. The
tracked worktree remained clean at the approved pin. Only then were report bytes
authorized. No budget reset, timeout increase or additional round occurred.

The exact original preview command restarted in the original parent cwd, using
the existing build. It reported Ready in 128 ms. Listener PID 77175, launcher
77172, started 2026-09-10 16:56:52 PDT; the listener cwd was independently checked.
The preview interruption was 20 minutes 2 seconds, within the estimate and well
before the 17:21:50 measurement cutoff. This completes the approved pause and
restoration; another pause is not implicitly authorized by this record.


## Authorizations

Rendered from findings.json authorizations: none. Both findings remain open; no risk acceptance, rejection or fix is claimed.

## Validation result

Lead triage after restoration: ACCEPT RT-1190-P0-1, supported by its measured
non-equivalent survivor; the schema test now asserts the emitted email projection
equals an empty object exactly. ACCEPT RT-1190-P1-1: the contract does not promise
traversal order, so both assertions now compare sorted complete lists, preserving
membership and cardinality. These fixes pass focused tests; the round-1 sidecar
retains open dispositions until scoped independent mutation verification proves
the fixes. No risk acceptance or CLEAR result is claimed here.

Canonical strict-shape, authorization-link and arbiter-reasoning validators passed before artifact creation. Counts and status are computed by the canonical checker helpers. The complete checker must block reviewed because OPEN_P0 remains, and the high-risk P1 also lacks user adjudication. No mutation remains for a later process to execute.

</details>
