# feat/1186 — deviations

Every entry is something the plan or the pipeline did not anticipate. Each needs a
resolved `Verdict:` before the `reviewed` transition (`red-team-status.mjs` parses this file).

---

## DEV-1 — `scripts/feature-setup.sh` carried a STALE ladder into the worktree

**What happened.** `progress.mjs init --size standard --risk high` was run before
`feature-setup.sh`. The setup script's "carry the ladder in" step then overwrote
`.feature/progress.json` with the PARENT checkout's file from an unrelated earlier run that
day (timestamps `2026-09-08T00:03Z`/`00:21Z`), so the ladder read `small·normal` with steps
5, 6 and 7 already `done` before a single line was written.

**Impact.** Cosmetic on this run — the ladder is a record, not a gate — but a resumed
session reading `progress.json` for state would have believed the branch was review-ready.

**Resolution.** Re-ran `init` (which does not reset step statuses) and then explicitly reset
`execute`, `gate`, `review` and `ready` to `pending`, and `plan` to `active`.

**Verdict:** ACCEPT — the adaptation is sound. Worth promoting: `feature-setup.sh`'s carry
step should not import a ladder whose branch does not match the worktree's branch. Recorded
for the post-merge lab-notes sweep.

---

## DEV-2 — intake `tests_to_add` grew 19 → 40 after plan round 1

**What happened.** The Codex plan-skeptic round returned 18 failability findings, all
accepted: the original 19 titles could pass while the feature was still wrong (an
unvalidated allowlist on the self-origin path, a listed loopback entry winning in
production, `new URL()` accepting `file:`/`blob:` entries, a `Vary` overwrite that drops
`Accept-Encoding`, no negative coverage of lookalike hosts or opaque `Origin: null`).
Estimates were corrected in the same edit: 160 → 210 production lines, 430 → 820 test lines.

**Impact.** None on scope. Per `.claude/commands/feature.md` § 5, `tests_to_add` retitles and
estimate corrections are deviations-file entries, **not** surface amendments — the surface
amendment counter is still **0**. Because the estimate was corrected BEFORE implementation,
the step-5 reclassification trigger measures against the honest number rather than firing on
a stale one.

**Verdict:** ACCEPT — this is the plan gate working as designed.

---

## DEV-3 — `vercel env add` cannot be used to set `ADMIN_APP_ORIGINS` on staging

**What happened.** The dispatch brief offered `vercel env add … staging` reading from stdin
as one option. `docs/runbooks/deployment-guide.md:1502` records that **`vercel env add` via
stdin stores EMPTY values** and that the Vercel CLI cannot address a Custom Environment at
all; the runbook's answer is the REST API:
`POST /v9/projects/{id}/env?upsert=true` with `target:[]` + `customEnvironmentIds:[envId]`,
values in the JSON body and never in argv.

**Impact.** A silent empty value would have made the staging smoke's allowed-origin case
refuse, and the failure would have looked like a code defect.

**Resolution.** Set the staging value through the Vercel MCP or that REST call, then read it
back before smoking. Value: `https://admin.staging.repworth.net`, staging Custom Env
`env_Xdvi79MDL9zMt5LmTMRLFSBBeKGT` in project `rep-worth`. The production value
(`https://admin.repworth.net`) is NOT set by this run — it is reported to the owner.

**Verdict:** ACCEPT.

---

## DEV-4 — ADR 0026's cookie premise is imprecise (recorded, not actioned)

**What happened.** ADR 0026 § Context asserts "**No cookie can travel cross-origin**" on the
strength of `SameSite`. `SameSite` is a *site* control, not an *origin* control:
`admin.repworth.net` and `repworth.net` share a registrable domain, so they are **same-site
though cross-origin**, and a `lax` cookie IS attached to a `fetch` between them.

**Impact on this branch: none.** The ADR's conclusion survives through a different control —
`assertSameOrigin` (`src/lib/shared/csrf.ts`) refuses any `Origin` that is not
`NEXT_PUBLIC_APP_URL`, so a credentialed mutation from the Admin app's origin is refused by
CSRF regardless of CORS. The behaviour is also unchanged by this ticket: the same cookie
attachment exists today, before any CORS. This branch adds a *server-side* refusal
(ADR 0026 D4) that did not exist before, so the direction of change is strictly safer.

**Resolution.** Not actioned here: the ADR is LOCKED and out of `allowed_edit_surface`, and
no code on this branch changes. Raised to the owner as an ADR-text correction; recorded in
the plan §5 and in the final report as an open owner question.

**Verdict:** ACCEPT.
