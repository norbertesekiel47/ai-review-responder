# Plan review round 3 — codex report (#656, verification-only, CAP)

Reviewer: `codex exec` --sandbox read-only. Brief: verification-only against the
round-2 dispositions. Raw transcript trimmed to the final report.

## Round-2 disposition verification

| Item | Status | Evidence |
|---|---|---|
| d1 | PARTIALLY ADDRESSED | Architecture, Glossary, and Design decision #1 are narrowed at plan lines 7, 34, and 43–46. However, T2 still says, “The attestation covers THESE BYTES” at plan lines 404–406. The digest only proves that it matches the stored bytes; it does not prove the preserved metadata attested those bytes. |
| d2 | ADDRESSED | T4 resolves scope at line 624, calls `getOffboardingState` and `isOperationalUIBlocked` at lines 636–639, and only then parses the body at line 641. Design decision #2 explicitly says the subscription gate does not cover offboarding at lines 53–58. |
| d3 | ADDRESSED | T6 Step 5 item 3 identifies the unattested shared fixture and prescribes attestation plus resetting all five columns and `owner_email_bounced` at lines 781–783. The only existing flag-on/send-positive paths are the unit enqueue case at `batch-builder.test.ts:662` and integration case at `batch-builder.integration.test.ts:508`; items 2 and 3 cover both. The other flag-on unit case at `batch-builder.test.ts:618` has zero sends, so the new gate is not evaluated. |
| d4 | ADDRESSED | T2 lines 408–414 correctly identify `convert_to` as STABLE and `encode`/`sha256` as IMMUTABLE, explain the fixed-UTF8 CHECK rationale, and warn against index reuse. PostgreSQL 16’s catalog confirms `convert_to` volatility `s` at `postgres.bki:1152`, versus `i` for `encode` at `:1732` and `sha256` at `:2186`. |
| f10 | ADDRESSED | T2 lines 359–363 use two independent guarded statements with explicit `exit 1`. Shell probes returned exit 1 for both simulated failure modes and exit 0 for the current valid state. |

## Intake v3 consistency

| Check | Result | Note |
|---|---|---|
| `tests_to_add` has exactly 47 entries | PASS | `.feature/intake.json:82–129`; mechanical count: 47. |
| `allowed_edit_surface` remains 20 globs | PASS | `.feature/intake.json:60–80`; 20 entries and unchanged from `70274f79`. |
| All 47 titles appear verbatim in the plan | PASS | Mechanical comparison returned zero missing titles. |
| Per-suite table sums to 47 | PASS | Plan lines 96–107: `4+6+7+9+5+1+8+2+1+1+3 = 47`. |
| Route suite is listed as 9 | PASS | Plan line 99. |
| Offboarding refusal title is wired through | PASS | Intake line 103; plan lines 256 and 636–652. |
| No surviving `46` in the plan | FAIL | Plan line 923 still says “v2 had 46.” |

## Defects introduced by a fix

| # | Severity | Defect | Which fix introduced it | Suggested correction |
|---|---|---|---|---|
| 1 | Low | Intake-v3’s count update left a prohibited `46` in the plan at line 923. | Intake-v3/offboarding-test addition | Replace “v2 had 46” with “v2 had one fewer promised test,” or remove the parenthetical. |

VERDICT: REVISE
