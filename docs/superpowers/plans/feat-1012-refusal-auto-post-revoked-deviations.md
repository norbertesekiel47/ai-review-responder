# Deviations — #1012, the `auto_post_revoked` Refusal write

Everything the plan did not anticipate. Nothing here re-opens a §0 decision; all
five are mechanical findings from executing the plan against the real code.

## D1 — seven of the nineteen eval titles cannot be RED before the write exists

T1 asks for "every `tests_to_add` title as a FAILING test". **Twelve** were. Seven
are **negative-space or preservation** assertions whose subject is the ABSENCE of
a Refusal row, and a row that does not exist yet cannot be asserted absent and
fail:

* `a no-op downgrade on a missing business writes no refusal_events row`
* `a downgrade whose guarded response UPDATE matches no row writes no refusal_events row`
* `a no-op downgrade on a response that is not downgradeable writes no refusal_events row`
* `a downgrade that loses the outbox attempt CAS writes no refusal_events row`
* `a no-op downgrade with no review anchor writes no refusal_events row`
* `REFUSAL_LEDGER_ENABLED=false changes only the refusal row and preserves the response downgrade, approval audit, notification enqueue, and outbox completion`
* `each production gate routes every AutoPolicyDowngradeReason verbatim to the shared downgrade`

They are written, non-inert (no `.todo`/`.skip`/`.fails`) and each carries real
assertions — the kill-switch case asserts all four pre-existing effects, and each
no-op case asserts the response, audit and notification state as well as the row
count — so they are regression pins rather than placeholders. They are green
before and after by construction.

**The counts below were WRONG in the first draft of this entry and are corrected
here; red team caught the arithmetic.** The unit suite holds 8 `it` blocks — 5
promised titles plus 3 pre-existing — and the live-DB suite holds 14, all
promised. So at the end of T1 the unit suite was **2 RED / 3 pre-existing green /
3 of these**, and the live-DB suite was **10 RED / 4 of these**. That is 7
negative-space titles and **12** genuinely red→green out of 19. The original
"13 of 19" was impossible on its face: 13 + 7 = 20 against 19 titles, and the
original unit line described 9 tests in an 8-test file.

**Verdict:** ACCEPT — and the reasoning is right rather than merely convenient.
An absence assertion cannot fail before the thing whose absence it asserts can
exist; demanding a RED phase for one is demanding a broken test. What matters is
whether these titles are RED against a WRONG implementation, and they are: a
downgrade that wrote a Refusal on a no-op path, or a kill switch that dropped
the audit row, fails every one of them. Red team confirmed that independently:
it planted the defect each of the seven forbids, and every one died.

**This verdict was originally wrong in the way that matters most, and the
correction belongs here rather than in a quiet edit.** It praised the entry for
reporting counts "measured rather than asserted, which is what makes this
checkable" — and then did not check them. Red team did, and the arithmetic was
impossible on its face: 13 red→green plus 7 negative-space is 20 against 19
titles, and the unit line described 9 tests in a file holding 8. Verified by
counting: 19 promised titles, 5 in the unit suite and 14 in the live-DB suite;
the unit file has 8 `it` blocks, so 3 are pre-existing. **12 of 19 is the honest
number.** Endorsing a measurement without re-deriving it is the same failure as
asserting one, and it is worse coming from the reviewer than from the writer.

## D2 — the transaction has TWO `businesses` reads, and only one of them is ours

§2's evidence says "assert the statement COUNT is unchanged, not merely that the
new column appears". Taken literally that is unsatisfiable: the ladder ALREADY
contains a second `businesses` read — `resolveAccountIdFromBusiness`, issued by
`insertAuditLogAutoPolicy` for its own row — and `src/lib/approval/audit.ts` is
out of the edit surface by the owner's decision, so it stays.

What the eval pins instead, and it is the same property in a form that is true:

1. the FULL ordered statement ladder as an equality — exactly one rung longer
   than before this slice, and that rung is the `refusal_events` INSERT; and
2. exactly ONE `FROM businesses … FOR UPDATE`, and it is the one that grew
   `account_id`.

Together those two fail on every implementation that pays for the account key
with an extra query, which is what §2 exists to prevent.

**Verdict:** ACCEPT, and it corrects the plan rather than working around it. The
plan's §2 evidence line was written on a false premise — I checked the ladder for
a read I might ADD and never checked for one already there, and
`insertAuditLogAutoPolicy` has issued its own `businesses` read the whole time.
The substitute is STRONGER than what §2 asked for: a full ordered-ladder equality
catches a rung added anywhere, not just a `businesses` one, and the
single-`FOR UPDATE` assertion pins the specific defect §2 named. The plan's other
`account_id` claims are unaffected — nothing here adds a read, which is what the
owner's decision actually bought.

## D3 — the missing-business no-op is unreachable against live Postgres

`responses.business_id` carries a foreign key, and `anchorReviewLockOrder` reads
the response by `(id, business_id)` before the business lock is taken. A response
whose review anchor resolves therefore ALWAYS has a `businesses` row to lock, so
the second no-op exit cannot be reached from a live database. It is a unit case
(mocked `sql`, real helper), asserting zero emitted `INSERT INTO refusal_events`
statements. The plan named "the same two suites" as T4's seam, so this is a
placement note, not a departure.

**Verdict:** ACCEPT. The unreachability is argued from the schema and the lock
order rather than asserted, and it is checkable: `responses.business_id` carries
an FK and `anchorReviewLockOrder` reads by `(id, business_id)` first. A unit case
is the right home for a branch live Postgres cannot produce — the alternative is
a fixture that lies about what the database permits. The branch stays covered,
which is what matters: the guard is still pinned against a write placed above it.

## D4 — the duplicate cases need the response re-armed between downgrades

Calling the downgrade twice in a row does NOT exercise the partial unique index:
the first call leaves the response `pending_approval` with a null approval
method, so the second exits at the non-downgradeable guard and never reaches the
ledger at all. Both duplicate titles would have passed while measuring nothing.

The suite therefore has a `reArmForSecondDowngrade` helper that terminalises the
spent outbox row and restores the auto-approved state before the second call, so
the second write genuinely meets `refusal_events_subject_uniq`. The
two-different-reasons case is the discriminating one — the reasons carry two
different categories, so a future `DO UPDATE` fails on both columns.

**Verdict:** ACCEPT, and this is the most valuable entry in the file. Both
duplicate titles would have been GREEN while exercising nothing — the exact
false-green class three plan-review rounds were hunting, found here by executing
the plan rather than reading it. Round 1 added the two-different-reasons title
precisely because the same-reason one could not tell `DO NOTHING` from
`DO UPDATE`; this deviation shows that neither could tell anything at all without
re-arming. The helper is test scaffolding, touches no production path, and the
discriminating case now genuinely reaches `refusal_events_subject_uniq`.

## D5 — two smaller things

* **Import specifier.** The write site imports `@/lib/refusals/{write,vocabulary}`
  while the rest of `auto-policy-downgrade.ts` imports `src/lib/**` relatively.
  `judge-gate.ts` in the same directory already uses the alias, and matching the
  specifier the integration suite's `vi.mock` uses keeps the forced-CHECK-
  violation cases from silently mocking a different module instance.
* **A second `docs/directory.md` line.** §6 asks for the `auto-policy-downgrade.ts`
  row. The test-inventory row for "Judge worker/publisher" enumerates that
  module's suites by name and would have been stale, so it names the new live-DB
  suite too. No new row in either table, and `ci:directory-map` is unaffected —
  it covers production files only.

**Verdict:** ACCEPT, both. The import specifier is not cosmetic: a `vi.mock` and
an import that disagree about a module's specifier mock DIFFERENT instances, so
matching them is what keeps the forced-CHECK-violation cases testing the real
helper. `judge-gate.ts` in the same directory already sets that precedent. The
`docs/directory.md` test-inventory line is the rule this repo states in its own
words — a doc that enumerates a module's suites by name is stale the moment one
is added, and leaving it stale is the defect the prerequisite branch's F1 was.
