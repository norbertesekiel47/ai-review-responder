# Contract generator performance diagnosis

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
