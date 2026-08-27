# Arch-log entry — Pathfinder 2026-08-26

Apply this in the artifacts PR. Two edits to
`.claude/reference/arch-review-log.md`.

**No sequencing hazard from open PRs.** `gh pr list` shows two — #927
(dependabot) and #646 (suppression glossary). Neither touches the arch log.

> ## ⚠ COLLISION — read before applying either edit
>
> **A second task is live in this working tree and has ALREADY STAGED
> `.claude/reference/arch-review-log.md`.** Measured 2026-08-26 16:14:
>
> ```
> $ git diff --cached --name-only
> .claude/commands/feature-resume.md
> .claude/commands/feature.md
> .claude/reference/arch-review-log.md      <-- both tasks write this file
> .claude/skills/preflight/SKILL.md
> .gitignore
> ```
>
> That task is the "insights remediation" work tracked in the repo-root
> `GATES.md` (untracked, gitignored): guardrail hooks, `grill-me-codex`
> pre-validation, and the new `/preflight` skill. Its staged arch-log change is
> its own `ci:merge-ledger` line — **not** this pass's counter reset.
>
> **Whoever commits second must MERGE, not overwrite.** The two edits are
> compatible in principle: theirs appends a ledger line for a governance-only
> merge; this pass rewrites the header and appends a table row. Applied blindly
> in the wrong order, one silently drops the other.
>
> **Note the irony, and record it as a finding rather than a joke:** a
> governance-only merge that must add a ledger line, landing in the same file
> and the same hour as the pass that proves such lines cannot be counted, is
> the exact mechanism §1 of `05-process-findings.md` describes. Under the
> current design that staged line will be indistinguishable from a counting
> merge. Under H7's design — SHA key plus a `counts` boolean from
> `isProductionFile` — it classifies itself correctly with no human judgement.
> **This collision is H7's own worked example.**

---

## Edit 1 — the header

Replace the counter paragraph and the 2026-08-26 correction note with:

```markdown
**Merges since last architecture pass: 0** — reset by the **2026-08-26 pass**
(entry below). Full artifacts: `docs/reviews/PATHFINDER-2026-08-26/`.

> **The counting rule is under repair — do NOT hand-count this file until H7
> lands.** The 2026-08-26 pass measured the prior window at **12** against a
> stated 8, and established that this file cannot be counted reliably as
> structured today. Four reasons, all measured: (a) two accepted locations,
> bullet list and bottom table; (b) no stable key — entries appear under PR
> number, issue number, branch name, or bare prose (`rg '#962'` and `rg '#954'`
> both returned **0** for merges that counted); (c) `ci:merge-ledger` fires on
> production **OR GOVERNANCE** files while the counting rule is production
> **only**, so #957, #960 and #961 were each *required* by CI to add a line and
> must *not* increment — they sit in the bottom table beside merges that do
> count, unmarked; (d) "lines added" ranges 1 to 36 per merge and is not a unit.
>
> **The previous instruction in this spot — "resolve it by COUNTING THE LINES
> BELOW … the lines are the only source that cannot drift" — is unsound and has
> been deleted.** The lines drift relative to the rule by construction.
>
> The fix is one owner: the bottom table, keyed by **merge SHA**, with a
> `counts` boolean set by `isProductionFile`
> (`scripts/ci/merge-ledger-audit.ts:87`) — a classifier the audit already
> computes on every run and discards. Then the counter is a query, not a
> judgement. Handoff H7 in `docs/reviews/PATHFINDER-2026-08-26/04-handoff-prompts.md`.
>
> **Correcting the record:** the 2026-08-24 pass reported this counter correct
> for the first time in five passes and credited `ci:merge-ledger`. That audit's
> own header (`merge-ledger-audit.ts:39-43`) explicitly declines to own the
> number. The audit is working exactly as designed; the counter was never in its
> scope. Six passes, six wrong counts, is the expected output of the current
> design — not a discipline failure.

Prior passes: `PATHFINDER-2026-08-24/`, `-08-22/`, `-08-18/`, `-08-15/`, `-08-10/`.

Merges since the 2026-08-26 pass:

_(none yet)_
```

---

## Edit 2 — the bottom table row

Append:

```markdown
| 2026-08-26 | **[CENSUS ADDENDUM — fold into the Outcome cell when applying]** The cross-feature phase censused **46 mechanical guards**: **18 Class A** (pure subject enumeration), **25 Class S** — a class this pass NAMES: *derived* subject discovery **narrowed by a hand-written scan root** — **4 Class C**, and **only 6 that detect an EMPTY scan**. **Class S is bigger than Class A and is the real problem**; `ci:pool-fanout` proves it — the #505 fan-out pins did not disappear when they became a rule, they **became `SCAN_DIRS`**. It is **NOT the same four guards** the 08-18 pass named: one identical, three descended, two new — **the class has grown**. New failure mode named: **exemption transit** — `owner_leads`'s CORRECT Class-B exemption at `tenant-tables.ts:210` silently became an OMISSION in `table-disposition.test.ts`'s required set; nobody erred, and 08-22's proposed two-line `linkedColumnPattern` fix would NOT have caught it. General fix in two steps, **cheaper than the `ci:guard-scope` meta-audit 08-22 deferred and strictly wider**: a `scannedCount === 0` fatal inside `ratchet-harness.ts`, plus exporting every `SCAN_DIRS` with one `ci-audit-wiring` case that fails on a directory covered by zero audits. **Largest duplication measured in six passes: the `businesses ⋈ accounts` subscription read is 33 sites**, byte-identical predicate, alias pair at 15, no fragment and no comment anywhere — and it **corrects this pass's own F8 flowchart**, which reported five, one of them a false positive (`autonomy-suspended-notice/context.ts` does not do the join). **#892's verdict QUALIFIED:** #972 gave the tombstone sentinels one owner and stopped one literal class short — writer and verifier still hand-share `'scrubbed:'` ×20 and `'account purged'` ×2, split 10↔10, and because the verifier is a **fail-closed compliance gate** a verifier-side drift converts a failed purge into a **PASS**. 9 DO-NOT-UNIFY additions. 10 handoffs H1–H10. | 12 counted merges ≥ 5 threshold across a 21-merge window after `72dc58ac` (the marketing/landing wave #953/#955/#959/#968/#976; the solicitation attribution + suppression trio #954/#964/#975; the three 08-18 carry-forwards #962/#970/#972; plus #969). The counter itself read **8** | Pathfinder pass, **windowed** (owner's call): 8 features charted — F1 landing composition root, F2 landing motion primitives, F3 landing sections, F6 Island design system, F7 Daylight marketing pages, F8 solicitation attribution, F9 suppression & unsubscribe, F10 ask dispatch, F11 purge & verification. **664 nodes**, every node `file:line`-cited. Three features (F12/F13/F14) recorded as no-chart: comment-only in this window. Artifacts `docs/reviews/PATHFINDER-2026-08-26/00-09` | **Headline: the enumerated-scope guard class the 08-18 pass NAMED produced FIVE new findings two windows later — and the pass's own prior handoffs inverted, 3-of-3 landed from 08-18 versus 0-of-3 from 08-24.** **The counter is wrong for the sixth consecutive pass and this file's own prescribed fix is UNSOUND** — `ci:merge-ledger` fires on production OR governance while the rule counts production only, so three merges (#957/#960/#961) were required to add a line and must not increment; "count the lines" over-counts by construction (§1 of 05-process-findings). **First pass where the MARKETING surface, not the pipeline, is the largest changed area** — `src/components/` took 51% of the window's net production growth; the surface is 100 files / 17,141 lines, 46% CSS, and had never been charted. **The arch log's own CSS claim was refuted:** `agent-flip-card.css` is import **#1**, not last; there are **three** unguarded order dependencies, not two, and the one that IS guarded (`globals.css:186-189`, pinned by `design-scope-purity.test.ts:39-45`) got no credit. **Arrival grammar has SIX spellings of one idea**, four live — proven one system by `carousel.css:112-113` neutralising all three Landing variants with a single `!important`. **Live defects, each with reachability answered separately:** `ProblemSection.tsx:47` branches on `usePrefersReducedMotion` with no mount gate, so every reduced-motion visitor is served the video branch until hydration — and `HeroSection.tsx:48-56`'s own docstring names the bug, having solved it twice privately without extracting it (MEDIUM; `preload="none"` mitigates the download); `owner_leads` retains owner PII through an account purge, invisible to `table-disposition.test.ts:112` because it has no tenant column or FK **by design**; `contacts-repo.ts:103` runs the two-way `Promise.all` that #893 reverted elsewhere, invisible to `ci:pool-fanout` whose `SCAN_DIRS` excludes that directory; `/pricing` freezes `isFoundingWindowOpen()` at build (`pricing/page.tsx:17`, `"compute":"static"`) while checkout evaluates at request — **date-bounded, cannot fire before 2027-01-01**. **H3's ordering constraint was VIOLATED** — #633 flipped send-mode on staging and the doc gate never landed; the only two autonomy flags ON in the deployed estate are the two no runbook mentions, the documented "instant kill switch" `AUTO_APPROVAL_ENABLED=false` has **zero reads** in that lane, and a third file H3 never listed — `beta-production-standup.md:143`, the **production** checklist — omits both. Production risk **zero**, every flag unset. **08-24's H1 and H2 confirmed still present but re-classified LATENT** (`auto-policy-publish.ts:555-562` + measured flag state) — their prompts' present tense was wrong and is corrected. **F8, the newest subsystem (#954, migration 114), passes EVERY invariant** — outbox, explicit-client, tenant-scope, idempotency, and `ON CONFLICT` matching its partial index byte-for-byte. **Seed 6 REFUTED twice independently:** all four locked suppression terms hold. **Migration 114 lockstep verified by introspecting BOTH databases**; the 078 standing exception shows its exact documented prod signature. Gates 21/21 green (audit count grew 20→21 with `ci:env-registry`). **Method note: the "a citation is not a verification" rule caught an error in the ORCHESTRATOR's own work** — a `head -12` truncation hid the `/pricing` call site and nearly produced a false refutation of a real finding. 8 handoffs H1–H8; `#3a` deliberately NOT carried a third time — folded into H4. |
```

---

## Node count derivation

For the "664 nodes" figure, so the next pass can check it:

| Feature | Nodes |
|---|---:|
| F1 landing root | 67 |
| F2 motion primitives | 81 |
| F3 landing sections | 128 |
| F6 Island system | 59 |
| F7 Daylight pages | 58 |
| F8 attribution | 75 |
| F9 suppression | 66 |
| F10 ask dispatch | 78 |
| F11 purge | 52 |
| **Total** | **664** |

> **Two numbers, both honest — stated rather than reconciled away.** 664 is the
> sum of each agent's own count of **flow nodes**. A crude orchestrator-side
> grep for bracket-labelled tokens across the nine files returns **760**,
> because it also counts subgraph titles and dotted-edge constraint labels.
> Neither is wrong; they count different things. Quote **664** as the node
> count. The 760 is recorded so the next pass does not "correct" it.
