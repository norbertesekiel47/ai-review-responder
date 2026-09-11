# Contract generator performance diagnosis

## Final CI configuration correction — 2026-09-11

The sections below retain the historical five-second experiments; that value
was Vitest's generic default, not a product SLO or a locked intake/ADR/ticket
requirement. The final configuration gives only the whole-repository compiler
integration case a bounded **10000 ms** timeout. All other test defaults,
coverage, concurrency, compiler inputs and complete golden/provenance assertions
remain unchanged. This supersedes the historical characterization of five
seconds as the integration regression signal; ten seconds remains its hang bound.

PR #1232's CI run `34561092588` failed two cases at head
`430b9cede8c788e76c66de0ed954008a76398688`: whole-repository generation took
5754 ms and the unsupported-wire fixture took 5110 ms. The run passed 15879
tests, failed two and skipped eleven. Local full verification and staging had
passed at that same head; those facts did not imply cloud CI was green. The
canonical local gate counter remained zero after its prior green; this separate
completed CI failure was preserved rather than manually changing the counter.

The tight reproduction ran the two cases together with coverage and two workers:

```bash
pnpm exec vitest run scripts/ci/__tests__/admin-contract-audit.test.ts \
  scripts/ci/__tests__/admin-contract-types.test.ts \
  -t 'reproduces the current contract|rejects unsupported wire response types' \
  --coverage --maxWorkers=2 --reporter=json
```

It reproduced a 5186 ms generator timeout; the unsupported case took 4458 ms.
Fresh Node CPU profiles attributed approximately 3007 ms of the unsupported case
to eight separate TypeScript programs, with approximately 2926 ms parsing.
The generator's approximately 3997 ms included 2124 ms of program creation,
617 ms response analysis, 490 ms schema analysis and 168 ms portable emission.
Inclusive profiler values overlap and are not additive.

The fixture correction keeps all eight source bodies and expected refusal
categories, plus native `Response.json(undefined)` throwing `TypeError`, but
places each exported GET in its own module within one compiler program. The
same parallel reproduction then passed at 4362 ms / 669 ms. All five affected
suites passed 224 tests with four-worker coverage (4699 ms / 499 ms); a broader
58-file CI-tooling workload passed 1489 tests (4959 ms / 513 ms). These results
proved the fixture speedup but left insufficient margin for the compiler
integration under cloud contention, motivating its explicitly bounded timeout.

Speculative production caching was rejected: a symbol cache had no repeatable
timing benefit, and expression/map caching was unsound because traversal mutates
the binding map. A temporary old-program fixture reuse experiment also showed
no measurable benefit and was removed. No such cache or production change ships.
All nineteen artifacts remained byte-identical during the independent generator
probe. Scratch profiles and timing JSON remain under `/private/tmp/1190-ci-*`.

The original correctness reviewer independently confirmed eight-case assertion
parity and module isolation. A separate independent reviewer confirmed the
10000 ms integration setting is appropriate for the measured complete compiler
workload and found no locked five-second SLO. These are candidate diagnostic
verdicts, not claims of a new gate, CI pass or mutation round. Final verification
and fresh review after the required main alignment remain explicit next steps.

After the bounded timeout was applied, the same broader four-worker coverage
workload passed all 1489 tests in 58 files: whole-repository generation 4577 ms,
unsupported-wire fixture 510 ms. These are local results; the failed cloud run
is not replaced by a claim of new cloud verification.

The full gate at `024297b928ecb527c4d7c0834265427d088d69f9` failed only the
real-repository contract integration test's existing 5000 ms timeout. The other
14,696 tests, build and audits passed. This was the first full failure after the
prior green at `6c42b805`; the durable gate counter was incremented once to 1.
Earlier history contains a timeout before that green; it was not erased or
reclassified. No timeout, coverage requirement or test oracle was relaxed.

## Reproduction and resource context

The tight reproduction was:

```bash
VITEST_WORKERS=1 VITEST_MAX_WORKERS=1 pnpm exec vitest run \
  scripts/ci/__tests__/admin-contract-audit.test.ts \
  -t 'reproduces the current contract' --coverage --reporter=json \
  --outputFile=/private/tmp/1190-contract-coverage-timing.json
```

It failed at **5532 ms**. At measurement time the host reported 46% memory free,
load averages approximately 6.18/5.93/5.73, and the restored preview consumed 0%
CPU with approximately 59 MB resident memory. No preview pause was needed.

The hypotheses were repeated request-provenance traversal, TypeScript program
creation, and repeated response-helper specialization. A Node CPU profile of
that same coverage test attributed approximately 5133 ms to generation: 3232 ms
inside TypeScript program creation, including 2597 ms parsing source files and
622 ms parsing JSDoc. Response analysis accounted for about 623 ms, request-schema
analysis 385 ms, and standalone declaration emission 546 ms. These inclusive
measurements overlap and must not be summed. The profile identified compiler
parsing as the dominant cost rather than workstation interference.

## Narrow corrections and measured results

1. The source-analysis program uses TypeScript 6.0.3's documented
   `JSDocParsingMode.ParseForTypeInfo`. Its declaration documents that JavaScript
   JSDoc needed for type information remains parsed, while TypeScript documentation
   ASTs are omitted. This program extracts types; it does not produce diagnostics.
   The standalone validation/emission program retains the ordinary full metadata
   and diagnostic path. The isolated coverage test passed at **4776 ms**, with
   byte-identical generated artifacts.
2. The standalone declaration program explicitly loads the ES2022 standard
   library, retaining built-ins such as Date while avoiding unrelated ambient DOM
   declarations. Missing or browser-only names fail diagnostics rather than
   becoming weaker types. The same isolated coverage test passed at **4172 ms**,
   again with byte-identical artifacts.
3. After the consolidated request-provenance and guard assertions, all **27 focused
   tests passed under coverage**. The real-repository test measured **4378 ms**.

The isolated CLI fixture imports a JavaScript function whose numeric return type
comes from JSDoc and asserts the generated numeric wire declaration. This protects
the type-information boundary. Standalone fixtures retain Date and reject both a
missing private name and a DOM-only name. Current repository artifact equality
protects all existing DTO and wire declarations. No timing assertion or new
dependency was added; the existing five-second integration limit remains the
regression signal.

CPU profiles and temporary timing files remain debug artifacts under
`/private/tmp/1190-cpu-profile` and `/private/tmp/1190-contract-*-timing.*`; no
instrumentation was inserted into production source. Final full verification and
independent scoped review are still required after the consolidated commit.

## Expanded C2 fixture matrix

The full gate at `6bb33d9d73e1219931a85b088470cb2895a37ccb` passed the real-repository
contract check and 14,697 other tests, but the expanded mutable-status test hit
its existing 5000 ms limit. All other gate rows, including the focused tests,
build and audits, passed. This completed failure was recorded once; the durable
counter became 1 after the preceding full green. No counter was manually reset.

The mutable-status test created fourteen independent TypeScript programs, each
loading the same standard library. The bounded hypothesis was repeated fixture
program creation, not the production proof: the production generator passed its
full-coverage integration case. The correction batches the test's separate module
files into one program. Every file still exports its own GET and owns its own
NextResponse/helper declarations, so fixture names do not become shared globals.
The shared fixture helper and cleanup hook are unchanged.

The same patch completed the independently enumerated U4–U10 coverage gaps. It
retains all eleven previous refusal and three previous preservation scenarios,
adding five refusals and four preservation scenarios: sixteen plus seven modules
inside the existing single test case. No oracle or timeout was relaxed.

All three affected compiler suites then passed **27/27 tests with coverage**.
The expanded status test took **494.3 ms** and the real-repository contract case
took **4381.4 ms**. Generated artifact bytes remained unchanged. The independent
inventory verified the complete fixture matrix and identified no remaining
coverage edit before the next committed gate. This evidence validates the narrow
fixture-cost correction; it does not substitute for the final full gate or
independent source and mutation verification.
