# #757 — deviations from the locked intake

Entries are things the intake/plan did not anticipate. Each gets a one-line
ACCEPT / RE-PLAN verdict at step 6 (deviations read-back) before review.

---

## D1 — `allowed_edit_surface` amendment #1: `scripts/ci/tenant-scope-allowlist.ts`

**When:** step 3, codex plan review round 1 (BLOCKER).

**What the intake missed:** `scripts/ci/tenant-scope-allowlist.ts` carries **seven** allowlist
entries whose `file` is `src/lib/kpi/service.ts` (under the `// --- KPI service ---` header at
~line 2258), plus `ALLOWLIST_BASELINE = 408`. The audit fails on a stale entry
(`UNUSED_ALLOWLIST_REASON = 'unused tenant scope allowlist entry'`) **and** on a baseline/count
mismatch. So deleting Stack A without touching this file breaks `pnpm ci:tenant-scope` — and the
file was outside the declared surface.

**Amendment:** added `scripts/ci/tenant-scope-allowlist.ts` to `allowed_edit_surface` in both
intake copies. One file, inside `scripts/ci/`, a tree the surface already reached into
(`scripts/ci/__tests__/db-imports-audit.test.ts`) — auto-approved under step 2's rule, recorded
here, and it **counts as amendment #1 of the 2 allowed** before abort criteria apply.

**Verdict:** ACCEPT — mandatory to keep the branch green; scope is one file and seven entries whose
only reason to exist is the file being deleted.

---

## D2 — `tests_to_add` extended by five titles (not an amendment)

**When:** step 3, codex plan review round 1 (six MAJOR findings about eval holes).

**What changed:** the eval suite could pass while the feature shipped wrong in five distinct ways.
Added to `tests_to_add` in both intake copies:

1. `avg star prior window and sample size bucket on the review-time anchor` — the prior bucket,
   `star_n_prior` and the delta were unproven; only `.current` was asserted.
2. `time-saved keys on approved_at so an imported review answered today still counts` — the
   original negative control selected the response-rate query by a string both queries share, so
   timeSaved was never inspected.
3. `aggregate windowedReceived and windowedResponded still count on detected_at` — the account
   response-rate counters had no live proof and could be re-anchored silently.
4. `a location with no reviews still gets a zero-filled velocity series in the aggregate slice` —
   nothing stopped an implementer moving the anchor from `LEFT JOIN … ON` into `WHERE`, which
   degenerates the outer join and drops empty locations entirely.
5. `the Review-time anchor is spelled only in kpi/fragments.ts` — every other test passes if
   Stack B hand-spells `LEAST(...)` and leaves `fragments.ts` dead, violating the intake's
   single-owner invariant.

Per step 5's rule, `tests_to_add` additions are owner-approved deviations-file entries, **not**
surface amendments — they do not count toward the abort budget.

**Verdict:** ACCEPT — each closes a demonstrated hole in the failable definition of done.

---

## D3 — Pathfinder P1 item 1 superseded (four fragments → two)

**When:** step 1 grilling (owner-adjudicated), re-raised by codex round 1 as an undocumented
reversal of a cited decision of record.

**What changed:** P1 required extracting `reviewTimeAnchor`, `reviewTimeWindowFilter`,
`detectedAtWindowFilter` and the TTR validity filter. Only the first two are extracted: once
Stack A is deleted the other two have **zero composers** (Stack B's response rate stays literal per
ADR 0019 D2 — P1 itself forbids touching it — and Stack B has no duration metric). The reversal is
now recorded explicitly in the plan header and the ADR 0019 addendum rather than left implicit.

**Verdict:** ACCEPT — the owner adjudicated this at intake; the defect was the missing written
adjudication, which is now written.

---

## D4 — plan review counted, phase record

Plan review rounds are counted in `.feature/state.json` (`planReviewRounds`), not in prose — a
resumed session continues the count rather than restarting at 1 (#628 lesson). Round 1 = full
eval-first review, rounds 2–3 verification-only, stop after 3.
