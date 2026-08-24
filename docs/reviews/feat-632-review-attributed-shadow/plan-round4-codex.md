# Plan review round 4 — codex report

**Reviewer:** codex, same thread `01a0353b-3877-78d3-858a-c36c8fc5b35a`
**Mode:** `codex exec --sandbox read-only --json` — read-only, no file changed.
**Round counter:** `planReviewRounds=4`.
**Why a round 4 exists:** the owner explicitly overrode the workflow's
three-round cap. Round 3's four fixes landed after the last review and carried
no reviewer verification, and the owner chose to buy that verification rather
than rely on Task 0's eval-contract test alone.
**Scope given to the reviewer:** commit `b2cf606b` ONLY — the round-3 fixes for
C1–C4 — plus one consistency question about the owner's match-rule decision.
The prompt forbade re-litigating rounds 1–3 and forbade manufacturing findings.

---

| Item | (a) Fix landed? | (b) Correct? | (c) Adjacent break? |
|---|---|---|---|
| C1 | Yes | **No.** Lines 189–191 use lexical regex replacement rather than syntax-aware comment removal. For example, `.replace(/(^|[^:])\/\/.*$/gm, '$1')` turns `const marker = "//"; it.todo("hidden")` into `const marker = "`, hiding the parked test. Likewise, the block stripper erases a parked test between string literals containing `"/*"` and `"*/"`. Both scans do use stripped `code`, the standing note is removed, and the named direct/chained/x-prefixed forms are otherwise matched. | Yes — the new stripping step creates false-green cases by corrupting strings or regex literals containing comment delimiters. |
| C2 | Yes | Yes. `worker/__tests__/solicitation-attribution.integration.test.ts` is spelled identically at lines 157, 358, and 1242. The ownership categories cover all 54 intake titles exactly once, and every assigned home appears in `SUITE_FILES`. | No. |
| C3 | Yes | Yes for newly created files: every `Create:` target across Tasks 0–8 is covered by its task’s scoped `git add`; Task 0 now stages all nine promised-suite homes and Task 4 stages both integration suites it unparks. | **Yes.** The changed commands removed files still declared as modified: Task 0 lines 218–219 and Task 4 lines 947–948 say `Modify: job-outbox-helpers.test.ts` and `Modify: process-review.test.ts`, but the revised `git add` blocks omit both. Following the document leaves declared modifications unstaged—or shows that both task file manifests are stale. |
| C4 | Yes | **No.** The budget arithmetic is correct: `4 + 10 + 16 + 7 + 5 + 5 + 6 + 1 = 54`, and Tasks 1–2 now expect 4 and 10. However, task-local claims still contradict it: Task 3 says `"Turns green: the 8 attribution: integration tests"` at line 739 but owns 16; Task 4 says `"the 2 enqueueSolicitationAttribution tests"` at line 940 but owns 7; Task 6 says three list tests plus one route at line 1266 but owns 5; Task 7 says three UI tests at line 1386 but owns 6. | Yes — the added budget table now directly conflicts with four unchanged task headers. |
| Owner decision | N/A | **No.** Matcher code, worked examples, test titles, and the Task 8 glossary are compatible with the broad rule, but line 77 still says `"Flagged for the owner"` and offers the narrower reading, while line 1511 still lists `"The mirror-rule narrowing, if the owner prefers"` as a follow-up. Both incorrectly present the resolved decision as open. | N/A |

VERDICT: REVISE