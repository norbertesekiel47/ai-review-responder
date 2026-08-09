# Plan review round 3 — codex adversarial (read-only, verification-only) — FINAL ROUND

**Ticket:** #680 · **Reviewer:** `codex exec --sandbox read-only` (codex-cli 0.145.0)
**Brief:** `<b2dde277>/codex-plan-brief-680-r3.md` · **Raw transcript:** `<b2dde277>/codex-plan-review-680-r3.jsonl`
**Audited at:** clean `HEAD 13806bbf`
**Verdict:** `REVISE` — **2 findings, both traced to the F13 fix.** Round cap reached.

## Trajectory

| round | findings | severity spread |
|---|---|---|
| 1 | 10 | 1 BLOCKER, 4 MAJOR, 5 MINOR |
| 2 | 7 | 2 BLOCKER, 3 MAJOR, 2 MINOR |
| 3 | **2** | 1 MAJOR, 1 MINOR — **no blockers** |

Converging. Every finding across all three rounds was accepted after independent verification
against disk; **none was ever rejected**.

## Findings and triage

| # | sev | finding | verdict |
|---|---|---|---|
| F18 | MAJOR | `SET LOCAL search_path` is a **no-op outside a transaction block** (warning only), and this repo applies migrations with plain `psql -f` — no `--single-transaction`, no `BEGIN`/`COMMIT` in the files. So statement 2 never governed the later `DO` and `ALTER`: **F13 looked fixed and was not.** | **ACCEPT** — verified twice over. `scripts/test-db-setup.sh:53` is `psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$migration"` with no transaction flag, and 099/100/101/102 all use bare session-level `SET lock_timeout = '5s'` — so `SET LOCAL` was both non-functional **and** off-precedent. Fixed to session-level `SET search_path = public, pg_temp`, with the session-scope consequence stated in the header rather than left implicit |
| F19 | MINOR | Test 1's title still enumerates three statements ("a bounded lock, the preflight guard, and the four legacy-column DROPs") while claiming "exactly", contradicting the four-statement body the F13 fix created | **ACCEPT** — an inaccurate locked title is precisely the drift these titles exist to prevent. Retitled to name the pinned `search_path`; **this edits a locked `tests_to_add` entry**, so it is surfaced to the owner rather than absorbed silently |

## Why F18 is the most valuable finding of the whole review

It is the one class of defect the process is worst at catching on its own: **a fix that appears to
work.** The `SET LOCAL` statement was present, well-commented, and argued for in the plan's own
prose — but it would have emitted a warning into the apply log and changed nothing. The migration
would have applied cleanly on staging and prod, the tests would have stayed green, and the
temp-table hijack F13 identified would have remained wide open behind a statement that looked like
its remedy.

Two rounds running, the blocker-class findings have been in the **fixes**, not the original plan.
That is worth weighing before implementation: it is evidence that this surface's failure mode is
plausible-looking remedies, not missing ones.

## Consequences for the plan

1. Statement 2 becomes session-level `SET search_path = public, pg_temp;` (F18). Statement count
   stays four. Header must state the session-scope consequence: a bare `SET` persists for the rest
   of the psql session — harmless here (`test-db-setup.sh` invokes psql once per migration, and 103
   is head today) but not to be silently relied upon by a future migration sharing a session.
2. Test 1 retitled in the plan **and** in both intake copies (F19) → `intakeSha256` re-signed
   (`2cc2017a…` → `149fb035…`).

## Round cap

Three rounds is the cap. Both findings were accepted and applied, so there is **no surviving
disagreement to escalate** — but the fixes themselves are now unreviewed, which is the exact shape
of defect rounds 2 and 3 both caught. That tradeoff is the owner's call, not the workflow's.
