# Branch review round 1 — triage verdicts (#656)

Full reports: `branch-review-round1-codex.md`. Both axes: **REVISE**.
Dual-axis `codex exec`, read-only, against `git diff 4a16bcfd..HEAD`
(3,561 lines of code across 24 files). `branchReviewRounds=1`.

## Headline

**Zero standards findings and complete contract coverage.** The STANDARDS axis
returned an **empty findings table** — no invariant violation, no tenant-isolation
gap, no gotcha trip, no `any`, no silent catch, across all fifteen numbered
invariants. The SPEC axis walked every `user_visible_behavior`, `invariant` and
`edge_case` in the intake and marked **every one Delivered**, each with a
`file:line`.

Both REVISE verdicts rest on four narrow items. **Two accepted, two rejected** —
every one re-verified against the code before triage, because a reviewer's
citation is a hypothesis.

## SPEC axis — 1 finding

| # | Sev | Verdict | Note |
|---|---|---|---|
| 1 | Medium | **ACCEPT** | Two `COMMENT ON COLUMN` strings overclaimed: `_attested_at` said "when the owner attested the CURRENT bytes" and `_attested_digest` said "sha256 of the attested address bytes". The schema proves neither — it proves the digest equals the *currently stored* address. This is the same class round 3 caught in the header comment, and it matters for the same reason: `COMMENT ON COLUMN` is the `\d+`-visible record every future schema author reads, and the migration's own caveat 30 lines below contradicted it. Both narrowed. |

Note the shape of this finding: the reviewer accepted the owner-declined trigger
without re-proposing it, and audited only whether the *stated width* matched the
*delivered width*. That is exactly what the brief asked for.

## STANDARDS axis — 0 findings, 3 weak-test claims

| Claim | Verdict | Evidence |
|---|---|---|
| `every #656 promised test is executable with zero pending cases` "only scans for markers; empty tests still pass" | **REJECT** | The title claims executability with zero pending cases, and that is precisely what it checks. It does not claim the tests are meaningful, and it is not the thing that makes them so. A scope-correct title is not an overclaim. |
| `PUT … rejects an address that fails the lint` "remains green if the real attestation function stops linting" | **REJECT** | The reviewer read one test in isolation. `postal-address.integration.test.ts:339-346` drives the **real** `attestPostalAddress` with a lint-invalid address and asserts `{ status: 'invalid', reason: 'single_line' }`. The route test's job is mapping that status to a 400. Coverage is complete and correctly split by layer. |
| `ask generation reads solicitation_postal_address directly without the to_jsonb shim` "asserts only rendered bytes; the shim returns identical bytes once 099 exists" | **ACCEPT** | True, and **T7 reported the same limitation itself** — two independent observers reaching it is the signal. `to_jsonb` is genuinely gone from production, but behaviour cannot distinguish the shim from the direct read once the column exists, so only the source can. Added a provenance leg asserting `ask-generation.ts` contains no `to_jsonb` and does contain the direct projection — the technique T5 used for the attestation label. The positive assertion also proves the file was really read, so the negative one is not vacuous. |

## What the two axes agreed on

Nothing overlapped, which is the point of running them separately: the STANDARDS
axis never looked at the intake, and the SPEC axis never looked at CLAUDE.md. The
one thing both implicitly confirmed is that the **narrowed digest guarantee is
stated consistently** — SPEC checked its width everywhere it appears and found
only the two column comments too wide; STANDARDS found no place where code
behaved as if the guarantee were broader.

## Outcome

Both accepted findings are applied. No finding touched behaviour — one narrowed
two SQL comments, one strengthened a test. **No production code path changed as a
result of this review**, which is the expected shape after three plan-review
rounds and per-task correction during execution.
