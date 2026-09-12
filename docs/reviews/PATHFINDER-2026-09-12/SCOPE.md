# Pathfinder 2026-09-12 — scope brief

Read this before any subagent work. Artifacts live in
`docs/reviews/PATHFINDER-2026-09-12/` (repo convention — CLAUDE.md forbids new
top-level directories, so the skill's `PATHFINDER-<date>/` at repo root does
NOT apply here).

## Pass type

**Windowed, not repo-wide.** The seventh pass, following
`PATHFINDER-2026-08-10/`, `-08-15/`, `-08-18/`, `-08-22/`, `-08-24/`, `-08-26/`.

The entropy counter in `.claude/reference/arch-review-log.md:298` reads **21**
against a threshold of 5. The owner authorised this pass; it resets the counter.

**This window is 8.4× the 2026-08-26 window's merge count and 7× its counted
merges.** The prior six passes each covered two to twenty-one merges. This one
covers 177. The method changes accordingly: the window is **themed first** and
only ~10 features are charted. Charting every merge was never on the table.

---

## The window, measured

Start `40e79e6a8` — the 2026-08-26 pass's own artifacts commit, PR #981.
End `6edacd0b0` — `origin/main` HEAD at dispatch, 2026-09-12.

```
$ git rev-list --count --first-parent 40e79e6a8..HEAD
177
```

**177 first-parent merges. 83 count.**

The counting rule is the arch log's own: a merge counts iff its first-parent
diff names a **non-test file under `src/`, `worker/` or `supabase/`**. It was
applied mechanically, by importing the audit's own classifier rather than
re-implementing it — `isProductionFile` from
`scripts/ci/merge-ledger-audit.ts:96`, with `isTestFile` at `:88`. Every one of
the 177 merges was replayed, its first-parent diff listed, and every path run
through that function. The full classified table is §"The 83" below.

| Class | Count | What it is |
|---|---:|---|
| **COUNTS** | **83** | ≥ 1 non-test file under a production root |
| Governance-only | 17 | `.claude/`, `.github/workflows/`, `scripts/ci/`, `package.json` — **required** by `ci:merge-ledger` to leave a ledger line, **required** by the counting rule not to increment |
| Docs / test-only | 77 | zero production and zero governance files |
| | **177** | |

Production surface moved in the window: **526 production files** (103 added,
66 deleted, 357 modified) · `src/` **+856 file-touches**, `worker/` **+42**,
`supabase/` **+7** · **6 migrations, 115 → 120**.

### The three merges that count but changed no code

Only **3 of the 83** have a production diff that is comment- or blank-only:
`9c2f12fbb` #1147 (4 comment lines), `91094be2d` #1136 (2), `715b88f58` #1070
(40 comment lines — *"name the in-tx account lock as the overage job's
replica-safe guarantee"*). A further three changed ≤ 6 code lines: `c5e94e6ca`
#1268 (3), `85e531512` #1135 (4), `3e1bcec01` #1067 (4). **80 of 83 changed
executable production code.** The counting rule is a file rule, not a behaviour
rule, and this window shows that the distinction costs almost nothing: the
overcount from comment-only merges is 3.6%.

---

## HEADLINE FINDING — the counter is wrong for the **seventh** consecutive pass, and by the widest margin yet

**The log says 21. The window measures 83. The delta is 62.**

| Pass | Counter read | Window measured | Delta |
|---|---:|---:|---:|
| 2026-08-10 | — | — | 3 missed |
| 2026-08-15 | — | — | #803 invisible |
| 2026-08-18 | 8 | 11 | +3 |
| 2026-08-22 | 3 | 7 | +4 |
| 2026-08-24 | 7 | 7 | **0 — the only correct one** |
| 2026-08-26 | 8 | 12 | +4 |
| **2026-09-12** | **21** | **83** | **+62** |

**Seven passes, six wrong counters.** And the mechanism is no longer in doubt,
because the log convicts itself in its own prose.

### What `ci:merge-ledger` did and did not catch

**It caught what it is built to catch, on every one of the 100 triggering
merges.** `ci:merge-ledger` runs on the merging PR and fails when a diff that
touches production **or** governance adds zero lines to
`.claude/reference/arch-review-log.md`. 83 production + 17 governance = 100
merges in this window were required to leave a trace, and no merge in the
window was blocked for missing one — so by its own contract the audit is green
and honest. Its header says so explicitly: *"It never reads or writes the
counter number"* (`merge-ledger-audit.ts:38-43`).

**It did not catch — and cannot catch — the counter drifting by 62.** The
number is a separate artefact from the lines, and nothing derives one from the
other. The four structural reasons the 2026-08-26 pass named
(`arch-review-log.md:318-344`) all still hold at HEAD, unrepaired:

1. **Two accepted locations.** Bullet list and bottom table.
2. **No stable key.** Entries appear under PR number, issue number, branch
   name, or bare prose.
3. **The audit's trigger is wider than the counting rule.** 17 governance-only
   merges in this window were *required* to leave a line and must *not*
   increment. They sit in the ledger unmarked and indistinguishable.
4. **"Lines added" is not a unit.**

### The log already told us, twice, inside this window

This is the part worth reporting plainly, because it is not a discipline
failure and it is not a surprise:

- `arch-review-log.md:306-316` — *"The number moved 3 → 9 on 2026-09-01, and
  six of those merges were never recorded here… The six were recovered
  MECHANICALLY rather than by reading this file, because the H7 note is right
  that it cannot be hand-counted."*
- `arch-review-log.md:427-431` — *"**The count lags reality** — #1069, #1071,
  #1073, #1074, #1075, #1097, #1098 and #1099 all merged with production
  changes and no entry in this section… **Eight unrecorded merges, not
  reconciled here: reconciling them is the next architecture pass's job.**"*

That is this pass. The reconciliation is 62, not 8. The bullet list stopped
being maintained entirely after `2026-09-04` — **the last 39 counted merges
(#1140 through #1270, 2026-09-06 onward) have no bullet at all**, including the
entire Admin split wave and Owner Operator Run A.

**H7 is now the highest-value unlanded handoff in the backlog.** It was filed
by the 2026-08-26 pass, it was not landed, and the cost of not landing it grew
from a 4-merge error to a 62-merge error in seventeen days. The pass's
recommendation is unchanged and is restated as **H1** in
`04-handoff-prompts.md`: one owner (the bottom table), keyed by merge SHA, with
a `counts` boolean set by `isProductionFile` — the classifier the audit already
computes on every run and discards, and the same one this brief used to produce
the 83.

---

## Themes — eight, and the shape of the window

| | Theme | Merges | `src/` files | `worker/` files | Charted as |
|---|---|---:|---:|---:|---|
| **A** | Admin split + legacy-admin retirement (#1183–#1268) | 24 | 199 | 0 | F2, F3 |
| **B** | The Refusal ledger (#1008–#1129) | 13 | 43 | 10 | F4 |
| **C** | Console / Harbor redesign + the 160-finding UX audit | 16 | 362 | 0 | F5 |
| **D** | Marketing / landing rebalance and copy | 10 | 166 | 0 | F6 |
| **E** | Offboarding / billing fixes (incl. #614) | 5 | 12 | 15 | F7 |
| **F** | **Owner Operator v1 Run A (#1270)** | 1 | 24 | 8 | **F1 — priority** |
| **G** | Agent-context split (#1135) | 1 | 26 | 4 | process only |
| **H** | Outbox / dashboard / auth perf + worker health | 8 | 11 | 4 | F8 |
| **Z** | Review QR, and four singletons | 5 | 13 | 1 | F9 |

Two facts about the shape:

1. **`src/app/` NET SHRANK by 3,750 lines** — the first time any production
   root has shrunk across a Pathfinder window. Ten legacy admin pages were
   deleted (66 production files removed). `src/lib/` grew +9,727 and
   `src/components/` +2,709 over the same period.
2. **The largest single merge in any window to date is `f797d2506` #1075 —
   223 `src/` files** remediating 160 UX-audit findings across all 73 routes.
   The second is #1174 at 66 files (a copy sweep), third #1233 at 37.

---

## What this pass weighs, in priority order

**1 — the Owner Operator seams.** Run B (Apply, Decline, receipts, the Operator
screen) starts the moment this pass ships. Run A is charted end to end as F1,
and the eight seams Run B will touch are each ruled on in
`03-unified-proposal.md` §U1 and `02-duplication-report.md` §1. This is the
section the intake reads; everything else in the pass is secondary to it.

**2 — the arch log's own "for the next pass" items** from the #1270 entry: the
`agent_turn` lane's six domain terminals, the `boundedErrorClass` copies, and
the two files past 1,000 lines. Answered in `05-process-findings.md` §4.

**3 — standing obligations.** Six of them: the 2026-08-26 pass's H1/H2/H3 and
its `08-next-session-prompt.md` PR 1/2/3, plus the issue-number rule it
recommended. Every verdict is measured at HEAD in
`07-handoff-reverification.md`; none is inferred from a title.

**4 — health baseline.** `00-health-baseline.md`. Gates, sizes, fallow, and the
migration lockstep — re-introspected on both live databases this time.

**5 — duplication, proposal, handoffs.** `02`/`03`/`04`. Every claim carries
≥ 2 `file:line`; every finding is labelled LIVE or LATENT; every handoff is
issue-shaped.

---

## Method notes for subagents

- Every diagram node and every duplication claim cites `file:line`. A claim
  without one is rejected and the agent redeployed.
- **A citation is not a verification.** For any finding ranked as a bug, answer
  **"is it wrong?"** and **"is it reachable?"** as two separate questions. If
  reachability cannot be shown, the finding is **LATENT** and says so.
- **Specialization is not duplication.** The DO-NOT-UNIFY register at
  `docs/reviews/PATHFINDER-2026-08-26/02-duplication-report.md:903-922` carries
  12 entries; the 08-18, 08-22 and 08-24 registers carry more. Read them and
  re-propose nothing on them.
- Live-DB test conventions apply to anything proposed: `*.integration.test.ts`,
  no run-time DDL.
- Barred by CLAUDE.md or a prior pass: a new top-level directory, a
  `NEXT_PUBLIC_*` companion for a feature flag, a third autonomy umbrella flag,
  collapsing the 25 `SCAN_DIRS` into one constant.

---

## Sequencing

`gh pr list` was checked before the counter reset. Recorded in
`05-process-findings.md` §7 along with whether any open PR touches
`.claude/reference/arch-review-log.md`.

---

## The 83 — every counting merge, oldest first

Columns are counts of **non-test files** under each production root, produced
by the same classifier as the headline.

| # | SHA | PR | Date | src | wkr | supa | Subject |
|--:|---|---|---|--:|--:|--:|---|
| 1 | `43afb2b71` | #982 | 2026-08-27 | 10 | 0 | 1 | feat(qr): Review QR — per-location printable QR → Google write-review page |
| 2 | `0732408fa` | #987 | 2026-08-28 | 25 | 0 | 0 | feat(console): Harbor dashboard redesign — floating canvas, new type + palette, Rep Pulse |
| 3 | `e87e20319` | #989 | 2026-08-28 | 20 | 0 | 0 | feat(console): Harbor shell — account menu, docked utility nav, toasts, real tabs |
| 4 | `926d9b74b` | #990 | 2026-08-28 | 8 | 0 | 0 | feat(console): glance dashboard — weekly recap, in-place "why", Rep Pulse decomposition |
| 5 | `5ab6bfeee` | #993 | 2026-08-29 | 8 | 0 | 0 | feat(console): dashboard density + notice placement |
| 6 | `80f68f86c` | #1019 | 2026-08-30 | 2 | 1 | 1 | feat(1008): **migration 116** `refusal_events` — the Refusal ledger's table |
| 7 | `dbc66c61c` | #1031 | 2026-08-30 | 3 | 2 | 0 | feat(1009): the Refusal ledger's write path — helper, kill switch, retention arm |
| 8 | `95597c4b9` | #1034 | 2026-08-30 | 3 | 1 | 0 | feat(994): the five Refusal lane category maps |
| 9 | `220f03643` | #1043 | 2026-08-31 | 0 | 1 | 0 | feat(#1012): the `auto_post_revoked` Refusal write, and the `account_id` widening |
| 10 | `7349acc6d` | #1042 | 2026-08-31 | 1 | 0 | 0 | feat(#1011): the `outreach_withheld` render lane — four writers |
| 11 | `2ef07b4f9` | #1044 | 2026-08-31 | 7 | 0 | 0 | feat(#1010): the three solicitation Refusal lanes, and the ledger's set-based arm |
| 12 | `15e9f0cb1` | #1049 | 2026-08-31 | 8 | 0 | 0 | chore(refusals): the post-merge sweep, and one owner-facing promise it exposed |
| 13 | `9d26c5a33` | #1055 | 2026-08-31 | 2 | 2 | 0 | feat(#1013): the `held_draft` and `policy_gate_held` Refusal lanes |
| 14 | `3e1bcec01` | #1067 | 2026-09-01 | 1 | 0 | 0 | ops(phase-h): open the launch evidence, fix two runbook defects, record the RPO decision |
| 15 | `715b88f58` | #1070 | 2026-09-02 | 0 | 3 | 0 | fix(billing): name the in-tx account lock as the overage job's replica-safe guarantee |
| 16 | `e180360bb` | #1072 | 2026-09-02 | 1 | 0 | 0 | perf(admin): take the businesses page BEFORE joining responses |
| 17 | `f87c80622` | #1073 | 2026-09-02 | 2 | 0 | 0 | perf(dashboard): fold two statements out of the cache-miss wave; coalesce concurrent misses |
| 18 | `e4294692d` | #1069 | 2026-09-02 | 3 | 0 | 0 | perf(auth): one `getUser`, one users read, one scope per owner page render |
| 19 | `862dbf2b6` | #1071 | 2026-09-02 | 1 | 1 | 0 | perf(outbox): bulk dispatch per topic group + drain within the tick |
| 20 | `cf2199809` | #1074 | 2026-09-02 | 11 | 0 | 0 | feat(#1014): the Restraint tab, and the Coverage start |
| 21 | `f797d2506` | #1075 | 2026-09-02 | **223** | 0 | 0 | ux: remediate the 160 findings of the 2026-09-02 frontend UX audit (all 73 routes) |
| 22 | `9e12bbc1f` | #1097 | 2026-09-03 | 17 | 0 | 0 | fix(#1078): one brand suffix per page, and a failed demo can be retried |
| 23 | `7adabe10c` | #1098 | 2026-09-03 | 2 | 1 | 0 | fix(#1079): `REFUSAL_LEDGER_ENABLED` contains a vocabulary fault, not only a write fault |
| 24 | `b9fb96016` | #1099 | 2026-09-03 | 1 | 0 | 0 | fix(#1080): the compiler proves `AUTO_APPROVAL_BLOCK_PRECEDENCE` is total |
| 25 | `9c40633f8` | #1100 | 2026-09-03 | 6 | 0 | 0 | fix(#1090): enforce the password number requirement the auth forms already display |
| 26 | `13540eed6` | #1101 | 2026-09-03 | 3 | 0 | 0 | feat(#1091): downloadable contacts CSV template |
| 27 | `862a039d1` | #1109 | 2026-09-03 | 6 | 0 | 0 | feat(#1093): closed 92-item category vocabulary on the onboarding Category field |
| 28 | `4502ed1f8` | #1110 | 2026-09-03 | 16 | 0 | 0 | feat(#1092): sidebar children on desktop, routed pills on mobile, Review QR under Requests |
| 29 | `e99a7a91f` | #1111 | 2026-09-03 | 1 | 0 | 0 | perf(#1082): the generation-exhaustion settlement writes its Refusals in one statement |
| 30 | `75b777bfd` | #1117 | 2026-09-03 | 6 | 0 | 0 | feat(#1086): dashboard info tips — one shared affordance, five placements |
| 31 | `8e2acd883` | #1118 | 2026-09-03 | 3 | 0 | 0 | refactor(#1086): one owner for Console popover dismissal |
| 32 | `313a3e01f` | #1119 | 2026-09-03 | 1 | 0 | 0 | feat(#1086): the aggregate dashboard gets its two missing tips |
| 33 | `7d23b7528` | #1122 | 2026-09-04 | 1 | 1 | 0 | fix(#1105): an unmapped block reason raises its own operator signal on a dark ledger |
| 34 | `dec98bab5` | #1123 | 2026-09-04 | 2 | 0 | 0 | fix(#1087): the Import offer's actions get a slot instead of an inline flex |
| 35 | `91b32506a` | #1121 | 2026-09-04 | 5 | 10 | 0 | feat(offboarding): redact the Stripe Customer on a `delete_data` purge |
| 36 | `dd883b1af` | #1126 | 2026-09-04 | 3 | 0 | 0 | refactor(offboarding): one owner for the offboarding lane's Stripe retry policy |
| 37 | `0bfc75c0a` | #1128 | 2026-09-04 | 6 | 0 | 0 | feat(#1088): every chart states what it plots, in what unit, over what window |
| 38 | `3fc206806` | #1130 | 2026-09-04 | 4 | 0 | 0 | fix(offboarding): a detached PaymentMethod is a retention, not an erasure |
| 39 | `dc9f421eb` | #1129 | 2026-09-05 | 2 | 1 | 0 | fix(#1083): ledger attribution moves onto the writer's side of the seam |
| 40 | `85e531512` | #1135 | 2026-09-05 | 26 | 4 | 1 | docs(agent-context): split the reference layer and add path-scoped rules |
| 41 | `91094be2d` | #1136 | 2026-09-05 | 1 | 0 | 0 | fix(fallow): split `globToRegExp` into token helpers |
| 42 | `fbe6fa82c` | #1138 | 2026-09-05 | 5 | 0 | 0 | fix(#1076,#1077,#1048): disclose historical policy holds and archival truncation |
| 43 | `07a2c856f` | #1140 | 2026-09-06 | 32 | 0 | 0 | feat(marketing): rebalance landing, features, how-it-works to the five jobs of the system |
| 44 | `d880bbacb` | #1141 | 2026-09-06 | 2 | 0 | 0 | feat(pricing): name the five jobs per tier |
| 45 | `132aacc31` | #1146 | 2026-09-06 | 0 | 1 | 0 | fix(worker): admin-alert claim-before-send; document the three lock-across-HTTP sites |
| 46 | `9c2f12fbb` | #1147 | 2026-09-06 | 0 | 1 | 0 | docs(504): the shared-client reclaim residual is tracked by #504 — **comment-only** |
| 47 | `65affb22a` | #1148 | 2026-09-06 | 4 | 0 | 1 | fix(auth): **migration 117** — admin MFA events in a dedicated `admin_audit_log` |
| 48 | `0816cc591` | #1150 | 2026-09-06 | 5 | 0 | 0 | feat(landing): section 5 becomes the route map |
| 49 | `aa2d5b2da` | #1151 | 2026-09-06 | 0 | 2 | 0 | fix(offboarding): purge-window override never claims a row with a live keep-my-data token (#614) |
| 50 | `4bd1b90f3` | #1152 | 2026-09-06 | 3 | 0 | 0 | feat(landing): the route map's header becomes the map's title |
| 51 | `bb28251ea` | #1153 | 2026-09-06 | 1 | 0 | 0 | fix(landing): the cloud layer fades at its top and bottom |
| 52 | `5d4cf4e98` | #1155 | 2026-09-06 | 2 | 0 | 0 | fix(landing): the route map's phone trail is an accordion |
| 53 | `002285fd4` | #1157 | 2026-09-06 | 1 | 0 | 0 | fix(landing): the phone trail fades into the closing band |
| 54 | `8faf5c317` | #1156 | 2026-09-06 | 2 | 2 | 1 | fix(judge): **migration 118** — durable sweep heartbeat closes the `isJudgeHealthy` blind spot (#949) |
| 55 | `602e98930` | #1174 | 2026-09-07 | **66** | 0 | 0 | copy: remove AI-slop patterns and em dashes from marketing and dashboard copy |
| 56 | `7a1484a93` | #1175 | 2026-09-07 | 0 | 0 | 1 | fix(db): **migration 119** lands deny-all RLS on `job_outbox` (#1171) |
| 57 | `e36f975e5` | #1213 | 2026-09-08 | 4 | 0 | 0 | feat(1183): Admin transport seam + dual-mode `requireAdminWithAal2` |
| 58 | `6e14c8a23` | #1217 | 2026-09-08 | 5 | 0 | 0 | feat(1186): Admin API CORS — one owner in `src/proxy.ts`, exact-origin allowlist |
| 59 | `e88935442` | #1218 | 2026-09-08 | 17 | 0 | 0 | docs: Brand Asset Library — one home for brand, design systems, and assets |
| 60 | `ba207f57d` | #1220 | 2026-09-08 | 15 | 0 | 0 | feat(1184): fold the nine admin GET handlers onto `requireAdminWithAal2` |
| 61 | `c951bc2eb` | #1229 | 2026-09-09 | 25 | 0 | 0 | fix(admin): route bearer auth through proxy and split CSRF (#1185) |
| 62 | `8b92d8539` | #1230 | 2026-09-10 | 2 | 0 | 0 | fix(admin): complete business detail and options reads |
| 63 | `afacb62c3` | #1233 | 2026-09-11 | 37 | 0 | 0 | feat(landing): ship the selected landing design as plain sections; remove exploration |
| 64 | `becdb113d` | #1232 | 2026-09-11 | 1 | 0 | 0 | feat(admin): generate and gate the Admin API contract (#1190) |
| 65 | `7a88f17c9` | #1237 | 2026-09-11 | 1 | 0 | 0 | Expose send-breaker thresholds for the Admin app port |
| 66 | `d87677af3` | #1239 | 2026-09-11 | 3 | 0 | 0 | Expose manual Disconnect through the Admin API for #1226 |
| 67 | `4ad91aa96` | #1240 | 2026-09-11 | 5 | 0 | 0 | Retire legacy Security and Runbook pages (#1200) |
| 68 | `0ad5c1bdc` | #1252 | 2026-09-11 | 27 | 0 | 0 | Retire legacy business pages after Admin app parity |
| 69 | `d6fdb841d` | #1253 | 2026-09-11 | 24 | 0 | 0 | feat(admin): cut over home and retire legacy Overview (#1192, #1201) |
| 70 | `f3d289f9d` | #1254 | 2026-09-11 | 4 | 0 | 0 | refactor(admin): retire legacy Costs page (#1242) |
| 71 | `f26ca945f` | #1255 | 2026-09-11 | 4 | 0 | 0 | refactor(admin): retire legacy Notifications page (#1243) |
| 72 | `4c6a38252` | #1256 | 2026-09-11 | 4 | 0 | 0 | refactor(admin): retire legacy Jobs page (#1244) |
| 73 | `6130de603` | #1257 | 2026-09-11 | 3 | 0 | 0 | refactor(admin): retire legacy Autonomy page (#1245) |
| 74 | `aadb59ef6` | #1258 | 2026-09-11 | 4 | 0 | 0 | refactor(admin): retire legacy Flagged page (#1246) |
| 75 | `90391afb6` | #1259 | 2026-09-11 | 4 | 0 | 0 | refactor(admin): retire legacy Offboardings page (#1247) |
| 76 | `34db1ca6c` | #1260 | 2026-09-11 | 5 | 0 | 0 | refactor(admin): retire legacy Solicitation page (#1248) |
| 77 | `a718d30db` | #1261 | 2026-09-11 | 3 | 0 | 0 | refactor(admin): retire legacy Suppressions page (#1249) |
| 78 | `727e23920` | #1262 | 2026-09-11 | 5 | 0 | 0 | refactor(admin): retire legacy CSV import page (#1250) |
| 79 | `386426a0d` | #1263 | 2026-09-11 | 4 | 0 | 0 | refactor(admin): retire legacy Demos page (#1251) |
| 80 | `f747cb7b6` | #1264 | 2026-09-11 | 21 | 0 | 0 | refactor(admin): retain minimal legacy support shell (#1193) |
| 81 | `f4a3441d0` | #1266 | 2026-09-11 | 30 | 0 | 0 | refactor(admin): finish bearer-only API transport and stale reference cleanup |
| 82 | `c5e94e6ca` | #1268 | 2026-09-11 | 1 | 0 | 0 | fix(admin): route the Admin API's caught 500 to Sentry |
| 83 | `d8e3f334f` | #1270 | 2026-09-12 | 24 | 8 | 1 | **feat(operator): Owner Operator v1 Run A — migration 120, `agent_turn` worker, POST/GET turns routes, flag off** |

### The 17 governance-only merges

Each was **required** by `ci:merge-ledger` to add a ledger line and is **required**
by the counting rule not to increment. Under H1's design they classify themselves.

`e44adfec8` #984 · `5fc45a28b` #985 · `914a797aa` #1007 · `888f196be` #1017 ·
`f35b8b49e` #1018 · `78bd5a17d` #1020 · `b4044ea96` #1021 · `800f9697d` #1023 ·
`cec1f2904` #1058 · `23facb7bf` #1060 · `5a1f0b205` #1064 · `b9c907841` #1131 ·
`5670f63a7` #1142 · `51ced257d` #1170 · `c52e4d1cd` #1214 · `cca344758` #1216 ·
`6604951b6` #1236

### Borderline, called IN

Six merges are titled `docs(…)` or `ops(…)` but change files under a production
root. The rule is about the files, not the title — the same call the 2026-08-26
pass made for #969. Counted: `e88935442` #1218 (17 `src/`), `85e531512` #1135
(26 `src/` + 4 `worker/` + 1 `supabase/`), `9c2f12fbb` #1147 (1 `worker/`,
comment-only), `3e1bcec01` #1067 (1 `src/`).
