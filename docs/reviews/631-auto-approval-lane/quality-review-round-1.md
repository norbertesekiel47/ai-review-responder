# #631 Auto-approval lane — standards & maintainability review, round 1

- **Reviewer**: STANDARDS & MAINTAINABILITY agent, thermo-nuclear-code-quality-review process
- **Diff base**: `a7dd67ee..HEAD` (24 commits, 55 files, +7,140/−65)
- **Date**: 2026-08-24
- **Inputs read**: full branch diff; `CONTEXT.md` § Solicitation (send-mode) incl. the three
  #631 LOCKED terms (**Auto-approval lane**, **Veto notice**, **Veto anchor**);
  `docs/superpowers/plans/631-auto-approval-lane-deviations.md` (all entries ACCEPT — accepted
  design decisions were reviewed for execution quality only, not re-litigated);
  `release.ts`'s pre-existing phase seam; the sibling notice families
  (`pending-post-notice/`, `autonomy-suspended-notice/`) as the mirroring baseline.
- **Verification observed**: `pnpm typecheck` green at HEAD (run during this review).

## Verdict

**No structural regression. Six findings survive the ≥80% confidence bar — none blocking, two
MEDIUM classes worth fixing before merge (glossary drift in comments; a duplicated locked
semantic), one MEDIUM adjudication (extraction of the duplicated phase-isolation idiom — extraction
wins), three MINOR.** The branch is high-discipline work: the four-condition gate has exactly one
DB reader shared by approval-time and release-time paths, the pure decision core is
property-tested, the downgrade split was extracted verbatim rather than copied, the worker family
mirrors its siblings faithfully, and every registry (directory map, env-vars, migrations log,
tenant-scope allowlist, anchor-pairing meta-guard) shipped complete in the same branch.

---

## Findings

### F1 (MEDIUM) — "auto lane" in code comments violates the LOCKED term's Avoid list

`CONTEXT.md`'s **Auto-approval lane** entry (coined by this very branch) says:
_Avoid: autopilot lane, **auto lane (in code comments)**, policy approval._ The branch then adds
"auto lane" to code comments 12 times:

- `src/lib/solicitation/release.ts:118, 129, 1160, 1205, 1299, 1809, 1873, 1904`
- `src/lib/solicitation/__tests__/release.integration.test.ts:593, 2544`
- `src/lib/solicitation/__tests__/auto-approval.integration.test.ts:717`
- `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` ("its auto-lane paths", the #631
  lock-order note)

The glossary lock exists precisely so grep-for-the-term finds every site. "the auto lane's
re-check" should read "the Auto-approval lane's re-check" (or "the auto_policy arm" where the
column value is meant). Mechanical fix, 12 sites.

Out of scope but noted: `src/lib/solicitation/approval.ts:80`,
`worker/jobs/publisher/ResponsePublisherWorker.ts:52`, and
`worker/jobs/response-generation/__tests__/persist.test.ts:782` carry pre-existing "auto lane"
comments that predate the lock. The Reply-lane two are a different (unlocked) sense; the
`approval.ts:80` one is this lane's and is now stale against the lock — candidate for the same
sweep or a follow-up.

### F2 (MEDIUM) — "the Autopilot lane" in `flags.ts` violates the same Avoid list

`src/lib/solicitation/flags.ts:19-20`: "Gates ONLY the Autopilot lane — …". _Avoid: autopilot
lane._ Should read "Gates ONLY the **Auto-approval lane**". One site (it spans a comment line
break, which is why a naive grep misses it — worth a multiline-tolerant pattern if a docs audit
ever pins these terms).

### F3 (MEDIUM) — adjudication of the flagged duplication: **extraction wins**. Home: a shared phase-seam module both `release.ts` and `auto-approval.ts` import

The deviations file flags `isolateAnchorItem` (`src/lib/solicitation/auto-approval.ts:518-542`,
plus the duplicated `VetoAnchorTally` at 469-472) — a copy of `release.ts`'s
`isolateItem`/`recordItemFailure`/`PhaseTally` — as "a possible extraction". Adjudication:

**Extraction is warranted NOW**, for three reasons:

1. **Two callers exist and a third is structurally predictable.** The release cycle's phase
   vocabulary (`PhaseTally`, `isolateItem`, `recordItemFailure`, `alertPhaseFailure`,
   `tallyPhase`) is a cohesive seam the Veto anchor is the first *external* phase to consume.
   `release.ts`'s own module header now describes phase 3.5 as living in another file; the next
   phase that outgrows `release.ts` (already at 2,097 lines) will copy a third time.
2. **The drift the duplication invites has already happened, in the first copy.**
   `release.ts:263-266` states the design rule: the failure message is a *stable prefix* and "the
   phase is a Sentry TAG rather than part of the text so one query answers 'which phase is
   poisoned'". The copy breaks that rule — `ANCHOR_ITEM_FAILURE_MESSAGE` bakes the phase into the
   message text ('Veto anchor candidate failed and was isolated'), so the anchor's isolated-item
   log lines no longer group with every other phase's under the one stable prefix. See also F4.
3. **This is safety-critical error-sink code.** The isolate-don't-poison-the-tick idiom (the #915
   wedge-closure) is exactly the kind of invariant that must have one owner.

**The circular-import rationale dissolves under extraction**: the cycle exists only while the seam
lives *inside* `release.ts` (which imports `anchorVetoDeadlines` from `auto-approval.ts`). Move
`PhaseTally`, `isolateItem`, `recordItemFailure`, `alertPhaseFailure`, `tallyPhase`,
`ITEM_FAILURE_MESSAGE`, and `PHASE_FAILURE_MESSAGE` into a new
**`src/lib/solicitation/release-phases.ts`** (with its `docs/directory.md` row in the same PR, per
`ci:directory-map`), and both `release.ts` and `auto-approval.ts` depend downward on it — no cycle,
`isolateAnchorItem` and `VetoAnchorTally` are deleted, and the anchor path calls
`isolateItem('veto_anchor', context, tally, body)` like every sibling. The seam's docstrings (the
"WHY EVERY PER-ITEM LOOP NEEDS THIS" essay) move with it, so `release.ts` also gets ~120 lines
lighter. This clears the repo's "no new file by default" bar: it is the removal of a duplicate,
with two production importers on day one.

If the owner declines the new file, the minimum fix is to align the copy: phase in the tag only,
message text identical to `ITEM_FAILURE_MESSAGE`, and fix the F4 comment.

### F4 (MINOR) — `isolateAnchorItem`'s justifying comment is factually wrong

`src/lib/solicitation/auto-approval.ts:480-482`: "Stable Sentry title / log prefix —
`Sentry.captureException` groups by message text, matching every other per-item failure sink in
this lane." Two errors: (a) `captureException` groups by exception type/stack, not by an unrelated
constant — it is `captureMessage` that groups by text (release.ts's own comments make this
distinction correctly); (b) the constant is **never passed to Sentry at all** — it appears only in
the `logger.error` line at :539. A comment that misstates why a divergence from the sibling is
safe is worse than no comment. Fixed for free by F3's extraction; otherwise correct the comment
and the message text together. (House standard: comment idiom/accuracy matching surrounding code.)

### F5 (MEDIUM) — the D19 account-wide suspension read now has two spellings

`src/lib/auto-approval/settings.ts:1131-1137` (`assertSolicitationExpansionAllowed`) re-spells,
verbatim, the `SELECT EXISTS (… FROM auto_approval_policies WHERE account_id = … AND suspended_at
IS NOT NULL)` statement that `readAutoApprovalConditions` owns
(`src/lib/solicitation/auto-approval.ts:160-166`) — the exact statement that implements the locked
D19 semantic ("ANY suspended row on the account trips this, not merely a `persona='solicitation'`
one"). `auto-approval.ts`'s module header stakes its design on "ONE CONDITIONS READER … two readers
with the same intent are exactly how a gate drifts from its own re-check" — and this branch then
ships a second reader of one of the four conditions, in the settings gate whose whole job is to
agree with `decideAutoApproval` about suspension. No other spelling exists in the repo
(`governor.ts`/`suspension.ts` are Reply-row-scoped writers, a different fact).

Fix: export a tiny `readAccountWideSuspension(sql, accountId): Promise<boolean>` from
`auto-approval.ts` (or have `readAutoApprovalConditions` delegate to it) and call it from
`assertSolicitationExpansionAllowed`. `settings.ts` already imports from `@/lib/solicitation/`
(flags, send-caps), and no cycle arises. (Violated standard: single authoritative owner for a
locked semantic; the file's own stated doctrine.)

### F6 (MINOR) — `SolicitationCapField` copies `DailyCapField`'s subtle draft mechanics

`src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:933-990` duplicates
`DailyCapField` (:739-804): the draft state, the `validity.badInput` blur-discard, the
normalize-then-compare-then-commit flow, and the epoch-keyed remount contract. The original's
badInput branch carries a seven-line comment explaining a genuinely subtle invariant (a stray 'e'
must not silently PATCH an explicit cap to "Default"); the copy compresses that to a one-line
pointer, and the invariant now has two owners. `DailyCapField` already takes `ariaLabel` as a
prop; give it `label`, `hint`, and `placeholder` props (its `expansionBlocked` arm no-ops when
`false`) and delete the copy. Both lanes' bounds are the same `MIN_DAILY_CAP`/`MAX_DAILY_CAP`
(1..50), which today matches `DailySendCapSchema` — see appendix A3 for the coupling note.
(Violated standard: copy-pasted logic instead of the canonical helper; codebase-design deep-module
discipline — one owner per subtle behavior.)

### F7 (MINOR) — `settings.ts` grew 1,161 → 1,523 lines; the Solicitation section is a module trapped in a file

The `── Solicitation lane (#631 D20) ──` section (`src/lib/auto-approval/settings.ts:993-1290`,
~300 lines) is a self-contained unit: its own row-state types, mutation applier, exposure
classifier, expansion gate, audit writer, loader, and upsert. It shares only
`assertConfirmationProvided`, `buildAutoApprovalReadiness`, `accountSubscriptionWritable`,
`isBillingMutationBlocked`, and the entitlement row type with the Reply machinery — all cleanly
importable. The `ReplyLanePatchInput`/`SolicitationPatchInput` split (a good move — it kept the
Reply machinery's exhaustive switches honest) is exactly the seam an extraction to
`src/lib/auto-approval/solicitation-settings.ts` would cut along, with
`updatePolicyInTransaction`'s two-line branch as the only join point. Not blocking (the file was
already >1k before this branch, and the section is well-fenced), but the next lane dial lands
better in its own file. (Standard: file-size/decomposition; the skill's 1k-line discipline.)

---

## Execution review of the accepted deviations (not re-litigated — quality only)

| Accepted decision | Execution verdict |
|---|---|
| Veto-notice family mirrors `pending-post-notice/` | **Faithful.** Orchestrator/context/dispatch/errors split matches; the two deliberate divergences (business-first load for tenant proof; zero-enrolled logged as systemic failure) are documented at the divergence site AND in directory.md. Bounced-email and WhatsApp-SID pre-filters byte-match the sibling pattern. |
| `confirmReason` resolver on `downgradeApproval` | **Clean.** The generic `R extends DowngradeReason` + optional in-tx hook is the narrowest shape satisfying decisions 6+7; `applyJudgeSplit` survives as a 4-line wrapper and the Judge arm's five tests pass untouched. The extracted `applyDowngradeSplit` deleted a would-be second copy of the held/skipped/alerting arms — the right judo move. |
| `releaseOutreachRow` 3-member outcome union | **Clean.** The union replaced a boolean that could no longer carry the withhold; per-batch counting + `break` is documented against the `withheldByReason` per-act convention at the consumption site. |
| anchor returns `{handled, failed}` (tallyPhase contract over plan prose) | Correct call; but the shape's duplication is F3. |
| Task 7 fix A/B (spine key + allowlist) | **Exemplary.** The duplicate spine writer is gone; the tenant-scope entries hoist the shared scan SQL into one constant with the two-table attribution explained; the anchor-pairing meta-guard entry documents the full batch → account → run lock order and the ABBA warning. |
| Flag-first finale reorder (`4a310289`) | **Clean.** `decideFlags` extraction gives the fast path and the full decision one owner for the two flag reasons — precedence cannot drift. |

## Checked and found clean

- **No `any`** added anywhere in the diff; `tx.json(payload as never)` and `data!.id` match the
  file-local house idiom at every sibling site.
- **No silent catches**: every empty `catch {}` added is the documented Sentry-unreachable
  fallback shape with the log line outside the guard, matching the lane's precedent.
- **No string literals for statuses/job names/tiers**: `APPROVAL_METHOD.AUTO_POLICY`,
  `QUEUE_NAMES.SOLICITATION_VETO_NOTICE`, `POLICY_PERSONA_SOLICITATION`/`POLICY_ACTION_SENDING`
  constants used at call sites; the migration-113 and ON CONFLICT literals are the documented
  byte-for-byte partial-index contracts (with `topic-audit-ignore` where sanctioned).
- **Outbox invariant #2**: approval CAS + spine step + `enqueueSolicitationVetoNotice` in one tx;
  typed helper added for the new topic; in-flight status set re-spelled per contract.
- **Invariant #15**: `auto-approval.ts` takes `Sql`/`TransactionSql` params throughout;
  worker composition roots import the singleton.
- **Invariant #13**: `available` is server-computed; no `NEXT_PUBLIC_*` companion; client renders
  from API state only.
- **#520 discipline**: the anchor CAS computes the deadline in SQL from `MIN(sent_at)`; `::text`
  round-trips in the RETURNING.
- **Registries complete in-branch**: directory.md rows (incl. the family sub-table), env-vars.md,
  migrations-log, arch-review-log, health-alert topic list, resend `OWNER_DIRECTED_TEMPLATES`,
  queue registration + `topicToQueue`, anchor-pairing allowlist.
- **Tests**: no live `it.todo`/`it.skip` remains; the property test exercises the pure core; the
  1,159-line integration suite reuses the shared tenant/outreach/schema-ready helpers rather than
  re-seeding bespoke fixtures; the mock-sql finale regression (deviations "pre-existing red") is
  resolved at HEAD (`6e0267ea`).
- **Glossary positives**: "Veto notice", "Veto anchor", "phase, not a poller", "SEND-anchored"
  usage is consistent everywhere outside F1/F2's sites.

## Appendix — low-confidence / informational (not findings)

- **A1.** `loadSolicitationVetoNoticeContext`'s `ok` result carries `batch`
  (`worker/jobs/solicitation-veto-notice/context.ts:80`) which no caller consumes — the worker
  uses `business` + `requestCount` only (verified by grep). One-line slim-down candidate; kept out
  of the table as sibling families also return their subject row.
- **A2.** `delivery.ts` now holds a third ~80-line claim function
  (`claimSolicitationVetoNoticeDelivery`) structurally identical to its two siblings. The
  byte-for-byte ON CONFLICT partial-index constraint genuinely blocks naive parameterization of
  the template literal, and the copies follow the sanctioned re-spell-by-hand precedent — but at
  the *fourth* template a fragment-based extraction (per-template SQL fragments feeding one
  classify-conflict body) is worth pricing.
- **A3.** The client shares one `MIN_DAILY_CAP`/`MAX_DAILY_CAP` pair between the Reply post cap
  and the Solicitation send cap; they coincide (1..50) today. If either schema bound ever moves,
  the shared constants clamp the other lane wrongly. A per-lane constant (or importing the zod
  bounds) would decouple.
- **A4.** `evaluateAutoApproval` re-reads the two flags that `runFinaleAutoApproval` just
  checked — harmless (single source via `decideFlags`, documented), noted only for completeness.
- **A5.** Pre-existing "auto lane" comments (`approval.ts:80` and the Reply-lane files) predate
  the lock — see F1's note; a follow-up sweep could align `approval.ts:80` with the new term.
- **A6.** The six-family notice-clone pattern (orchestrator/context/dispatch/errors ×
  channel-method × body-formatter × email template) now has a sixth member. The mirroring was the
  owner-approved design for this branch and executed faithfully; recorded here only as input to
  any future "notice family seam" consolidation the platform considers.

## Orchestrator triage (2026-08-24, receiving-code-review)

All 7 findings ACCEPTED, applied as F-Q1..F-Q7 in the round-1 fix commit:
Q1/Q2 glossary comment sweep; Q3 phase seam extracted to
src/lib/solicitation/release-phases.ts (duplicate isolateAnchorItem deleted,
tag-not-text drift fixed); Q4 one owner for the D19 suspension read; Q5 the
auto-downgrade path now ACTUALLY calls Sentry.captureMessage (the finding
exposed a broken intake observability promise, not just a wrong comment);
Q6 DailyCapField parameterized, duplicate deleted; Q7 solicitation lane
extracted to src/lib/auto-approval/solicitation-settings.ts.
