# CI timeout fixture candidate review

Original fixture reviewer: `/root/feature_1190/correctness_review`. This section
is copied from that reviewer's staged report. The separately attributed timeout
assessment below was delivered by `/root/redteam_1190_round2` on 2026-09-11;
neither diagnostic is a fresh mutation pass or final gate-backed verdict.

Diagnostic verdict: **CLOSED — no actionable correctness finding in the proposed fixture batching change.** This is candidate review before the next full gate, not formal gate-backed approval.

Reviewed baseline HEAD `430b9cede8c788e76c66de0ed954008a76398688` and the authorized uncommitted diff in `scripts/ci/__tests__/admin-contract-types.test.ts:58`. Candidate test blob: `2548b300998e6e8302d4f41b76f59fd375bfafea`. `git status --short` showed only that tracked file modified. Unchanged production code was inspected through the pinned Git object; unrelated correctness fronts were not reopened.

## Assertion parity

All eight original source bodies and their expected refusal categories remain present:

| Case | Expected refusal preserved |
| --- | --- |
| Top-level `unknown` body | `unknown` |
| Object containing `1n` | `bigint` |
| Top-level `undefined` | `undefined` |
| Top-level `Symbol("value")` | `unsupported JSON type` |
| Unresolved generic `T` body | `unsupported JSON type` |
| Object with `toJSON()` implementation | `/toJSON\|tuple/` |
| Nested declared `toJSON()` | `/toJSON\|tuple/` |
| Tuple with optional member | `/toJSON\|tuple/` |

The former string expectations become unanchored literal regular expressions containing no special metacharacters, retaining their substring acceptance. The last three regular expressions are unchanged. Each entry still calls `describeResponses` with its own corresponding source and asserts a thrown error. The native `Response.json(undefined)` assertion still requires `TypeError`; moving it after the eight compiler assertions does not weaken its oracle. Failure still fails the same test. The added assertion message identifies the fixture text.

## Isolation and semantics

Each fixture is written to a distinct `route-N.ts` file and contains an exported `GET`, making every file an external module. Its `NextResponse` declaration and local bindings therefore remain module-scoped; there are no imports or global augmentations connecting the cases. Array indexing pairs each expected error with the exact file written for that entry.

The declaration prefix and compiler options remain identical to the old helper (`strict: true`, target ES2022). A single TypeScript program shares library parsing and compiler infrastructure. The response analyzer selects exports from the supplied source module and allocates its traversal state per call, so sharing the program does not merge handlers or analysis state. Temporary files remain registered for existing `afterEach` cleanup. The shared fixture helper, production source, timeout, and coverage settings are unchanged.

## Evidence limits

This review independently inspected source and assertion parity; it did not run tests, coverage, application code, or gates. The supplied before/after timing results support the proposed performance rationale but are not a timing guarantee or a substitute for the forthcoming full gate. No merge or operational authorization is implied.

## Independent integration-timeout assessment

Verbatim assessment delivered by `/root/redteam_1190_round2`:

> APPROVED as a bounded candidate change: a 10,000ms timeout only on real-repository generation test at audit.test.ts:73 is appropriate integration configuration; no correctness evidence that it conceals a production regression. Independently read saved JSON: real-repo4362/4699/4958.836ms after batching, CI5754ms; batch668.6/498.7/513.0ms. CPU profiles show71.9%/78.7% sampled worker time in TypeScript. Current production diff empty; complete source graph and exact artifact/DTO/response/gate assertions retained. No5s SLO in locked intake, plan or ADR. Independently verified all8 unsupported-wire bodies/error categories and native TypeError survive batching, isolated external modules, identical compiler options, per-call traversal, error throws not cached. Caveat: performance-diagnosis.md currently describes5s as regression signal; preserve historical account but append rationale that final integration bound is10s, so documentation reflects final configuration. Final changed-test/gate verification still required; this is not CI/mutation/round3 approval. No tests/state edits performed.

The accepted documentation follow-up is recorded in `performance-diagnosis.md`.
Final code uses the ten-second setting only on the named real-repository test;
the unsupported-wire case retains the generic default after its measured setup
correction. No other timeout, global default, coverage or concurrency setting
is changed.
