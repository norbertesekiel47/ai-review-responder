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

---

## DEV-5 — T1's test files carry two type errors of their own (found by T2)

**What happened.** `pnpm typecheck` at the end of T2 reports five errors. One is T2's
expected `isSelfOrigin` gap (T3) and one is T4's not-yet-written `addVaryOrigin` export.
The remaining two are defects **inside the eval-task test files**, unrelated to any tracer's
production code, and neither can be fixed from T2's edit lease (`__tests__` is forbidden):

- `src/lib/config/__tests__/admin-origins.test.ts:205` — `TS18048: 's' is possibly
  'undefined'`. The Edge-safety scan does
  `[...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])`, which is
  `(string | undefined)[]` under `noUncheckedIndexedAccess`; the later
  `specifiers.filter((s) => s === bad || s.startsWith(...))` then dereferences it.
- `src/lib/config/__tests__/flags.test.ts:87` — `TS2540: Cannot assign to 'NODE_ENV'`.
  `@types/node` types `NODE_ENV` as read-only on `ProcessEnv`.

Both suites nevertheless RUN and pass (vitest transpiles without typechecking), so the
failure surfaces only in the `lint` job, not in the test job.

**Resolution.** Owner is whoever holds the `__tests__` lease — T1's author or the step-7
gate run. Both are one-line fixes: `.map((m) => m[1] ?? '')` for the first, and for the
second an `Object.assign(process.env, { NODE_ENV: 'production' })` (element access does not
escape the `readonly` modifier, so an indexed write is not the fix). Recorded here rather
than silently absorbed, because T2 must not edit a test file to make its own gate green.

**Verdict:** ACCEPT — both fixed by the root (which holds the `__tests__` lease) in the
T3 commit, exactly as T2 proposed: `.map((m) => m[1] ?? '')` and
`Object.assign(process.env, { NODE_ENV: 'production' })`. T2 was right to refuse to edit a
test file to make its own gate green, and right to report rather than absorb it.

---

## DEV-6 — a `//` comment naming `/api/admin/**` opens a phantom block comment

**What happened.** Both structural tests strip comments before scanning source, with the
usual two-pass idiom — block comments first, then line comments. On
`src/lib/config/admin-origins.ts` that produced a file with **zero import statements**, and
the two structural assertions failed against code that was perfectly correct.

The cause: the module's header comment contains the literal `` `/api/admin/**` ``. Inside a
`//` line that is still just text — but the FIRST pass does not know that. It sees the `/`
before `**` as a block-comment opener, matches non-greedily to the next `*/` (the end of the
first JSDoc, ~10 lines later), and deletes everything in between — which is exactly where
the `import` statements live.

**Why it matters beyond this branch.** Every module in this repo documents its own rules in a
header comment, and any module whose rules concern an API path will contain `/**`. The
existing precedent (`src/lib/auth/__tests__/admin-transport.test.ts` § Edge safety, #1183)
uses the same block-first order and is only safe because that module's header happens not to
name a `/**` path. The next one will not be so lucky.

**Resolution.** Strip LINE comments FIRST, then block comments — the line pass removes the
phantom opener before the block pass can see it. Applied in both scan sites
(`admin-origins.test.ts`'s `stripComments` helper and `csrf.test.ts`'s `read`), each with a
comment saying why the order is load-bearing.

**Verdict:** ACCEPT. Promote at merge: this is a durable trap for any future source-scanning
test, and belongs in the lab notes (testing topic page) — the failure mode is that a
structural guard silently scans an empty file and PASSES, which is worse than the red we got.

---

## DEV-7 — production diff is 1.9× the estimate (under the trigger, recorded)

**What happened.** Measured from the fork point: **398** production lines against a 210
estimate (1.9×) and **797** test lines against 820. The step-5 `reclassify` row did not fire
(the trigger is ~2×) and the gate is green.

**Why the estimate was low, honestly:** the estimate counted logic, and this repo's house
style is comment-dense — `src/lib/config/admin-origins.ts` is 189 lines of which roughly half
are the header and the per-function rationale that ADR 0026's decisions require to survive.
`src/proxy.ts`'s +130 is the same shape: the three `Access-Control-*` constants and the block
are small; the paragraphs explaining why the block runs before `isProtectedRoute` are not.

**Impact.** None on scope or classification. The 398 also crosses the 300-line threshold in
`execution-lanes.md` § The review wave, so the standards axis joins the wave — it would have
anyway at RISK = high, but the measurement is recorded rather than estimated, as that section
requires.

**Verdict:** ACCEPT.
