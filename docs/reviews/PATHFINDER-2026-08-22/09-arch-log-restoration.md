# Restoration for the 2026-08-22 arch-log entry

The original entry was written on 2026-08-22 and lost to `git reset --hard`
before it was committed. PR #935 carries a rebuild. The rebuild is a faithful
summary and it lost four things.

**This file holds the four losses, verbatim from the original.** Insert them into
the entry in `.claude/reference/arch-review-log.md` before #935 lands. The
rebuild's own text and its provenance note stay; this is additive.

---

## 1. The correction to the #920 entry  — HIGHEST VALUE

**Why it matters: line 137 of this same file still carries the false number.**
The original entry corrected it. Without this block the next reader trusts
*"+4 platform-wide predicates under a standing sign-off"*.

Insert after the "What it found" list:

```markdown
  **Three claims in this log were measured wrong and corrected.** The #920 entry
  below says *"+4 platform-wide predicates"*: the move is **381 → 383 (#904) →
  390 (#920)**, split across two merges, seven of them from #920, and all seven
  are `background-global-scan` — only #904's two are `platform-cross-account`.
  The allowlist's own header narrative records all nine correctly; **this log is
  the artefact at fault**. Second: this is the **FOURTH** consecutive pass to find
  the counter wrong, not the third. Third: `#895(b)` was **delivered by #920** and
  its docstring cites the issue by number while the issue stayed open.
```

Evidence: `02-duplication-report.md` X26 · `05-process-findings.md` P7, P1, P2.

---

## 2. The two findings dropped from the "what it found" list

The rebuild kept items (1) and (2) of five. Restore these two:

```markdown
  (2) **`!== 'not_settled'` is a wrong proxy.** Halting an all-withheld `built`
  batch makes both halt routes report `closed: true` against
  `send_closed_at IS NULL` — `'no_send_parent' !== 'not_settled'` is true, and
  the arm is reachable through `haltBatch` → `latchHalt`, which passes no
  failure. (4) **`ci:admin-aal2`'s P2 parity misses `/admin/solicitation`**: it
  anchors on a sibling route that does not exist for that page, so flipping the
  page's `aal2` off would pass CI while the API route stays gated — and that page
  reads `solicitation_send_breaker` directly via `sql`. (5) **`ci:rls-audit`
  guards no platform-scoped table** — `REQUIRED_RLS_TABLES = TENANT_TABLES`, so
  neither `solicitation_send_breaker` nor four older tables are covered.
```

Evidence: `02-duplication-report.md` X13 · `01-flowcharts/F3-send-breaker.md` Q6, Q8.

---

## 3. X10's graduation from pattern to rule

The log mentions X10 four times, all in older entries. The rule itself is absent.

```markdown
  **X10 graduated from pattern to rule** — an enumeration that defines a guard's
  SUBJECT SET must be derived from the artefact that produces subjects; an
  enumeration listing only EXEMPTIONS inside a derived scan is legitimate.
  Seven silent instances against ten-plus loud ones, plus one (`SQL_TAG_NAMES`)
  that made the transition in-repo. Phase 2 amended it: apply the classifier to a
  guard's **discriminator and its transitive inputs**, which found two more.
```

Evidence: `01-flowcharts/F7-F8-postal-gate-and-allowlist.md` Q3 ·
`02-duplication-report.md` X10 verdict.

---

## 4. "What the next pass should look at"

**Six other entries in this log carry this section. The rebuild has none, so the
next pass gets no carry-forward.**

```markdown
  **What the next pass should look at.** (a) Whether the send-path integrity
  tests landed — they are rank 1 and nothing else in the backlog protects those
  three failure modes. (b) **`ci:fallow:coverage` has no unit-size axis**:
  `line_count` never appears in any finding's `exceeded` field, so a 202-line flat
  orchestrator with high coverage is invisible to the PR gate in any file,
  forever. (c) Whether `#896` landed — three hand-corrections of a hand-kept
  number is not a process that has converged. (d) The four false
  `docs/directory.md` rows, and whether H11's split retired two of them
  structurally rather than by prose.
```

Evidence: `05-process-findings.md` P3, P4 · `04-handoff-prompts.md` ranks 1–2, 6.

---

## Note on item (a) of §4

By the time #935 lands, **PR #932 has merged and the send-path tests exist.**
Change (a) to read: *"(a) Whether the three send-path integrity tests still go RED
under their own mutations — #932 pinned them; a later refactor can silently
unpin them again."*
