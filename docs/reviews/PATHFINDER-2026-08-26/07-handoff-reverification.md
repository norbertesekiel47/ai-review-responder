# Handoff re-verification — Pathfinder 2026-08-26

Verified against `main` @ `1d9b251c`. Window baseline `72dc58ac`.

**A merge title is not evidence. A closed issue is not evidence.** Every verdict
below is a source read at HEAD, several corroborated by an *empty* `git log`
over the exact blast radius — the strongest available evidence that nothing
landed.

---

## Summary

| Handoff | From | Verdict |
|---|---|---|
| H1 — bounced-owner email skip made structural | 08-24 | **NOT LANDED** — 0 of 5 sub-items |
| H2 — one claim contract for the notice family | 08-24 | **NOT LANDED** — 0 of 3 sub-items |
| H3 — name the autonomy control surface | 08-24 | **NOT LANDED** — ordering constraint violated |
| #892 purge tombstone sentinels | 08-18 | **FULLY FIXED** — exceeds the ask |
| #894 tenant-scope blind spot | 08-18 | **FULLY FIXED** — all three ordered steps |
| #895 truth-and-tripwire bundle | 08-18 | **FULLY FIXED** — all five live items |
| `#3a` dangling reference | 08-24 | **NOTHING CHANGED** — nine weeks live |

**The pattern is stark. The three handoffs from the OLDER pass all landed. The
three from the MOST RECENT pass all did not.** The 08-18 items had survived two
windows untouched and the 08-24 pass proposed closing them as won't-fix if they
survived a third. They were actioned instead — and the fresh three were not.

---

## A · H1 — bounced-owner email skip → NOT LANDED

`git log 72dc58ac..HEAD` over `src/lib/notifications/` and all six notice-member
directories returns **nothing**. Not one file in the blast radius was touched.

| Sub-item | State | Evidence |
|---|---|---|
| Filter in `resolveChannels` | **absent** | `resolve-channels.ts:94-106` filters `status='verified'`, `archived_at IS NULL`, `unsubscribed_at IS NULL` only. Zero occurrences of `owner_email_bounced` in the file. |
| `b.owner_email_bounced` in APN context | **absent** | `auto-post-notice/context.ts:106` still selects `google_maps_url`; `AutoPostBusinessRow:47-56` has no such field. |

The five private copies, all still present: `escalation-notice/dispatch.ts:90-94`
· `pending-post-notice/dispatch.ts:100-104` ·
`solicitation-veto-notice/dispatch.ts:84-88` ·
`autonomy-suspended-notice/dispatch.ts:51` · `notification/dispatch.ts:197-198`.

Re-measured reference counts, production files only:

```
notification 9 · escalation-notice 5 · pending-post-notice 5
autonomy-suspended-notice 5 · solicitation-veto-notice 5
auto-post-notice ................................. 0
```

**The zero is exact and reproduces the 08-24 finding.** The non-zero members
measure 5 and 9, not the 7 and 8 the 08-24 pass published; that pass's counting
method could not be reproduced. Immaterial to the finding — the shape is
identical — but recorded rather than smoothed over.

### Is it wrong? YES.

`worker/ingress/resend.ts:90,99` enrolls `auto_post_notice` in
`OWNER_DIRECTED_TEMPLATES`; `:262-264` sets `owner_email_bounced = TRUE`.
`email-channel.ts` `sendAutoPostNotice` sends unconditionally.
`eligibility.ts:65-99` filters subscription and per-channel flag only — and its
own header at `:6-8` says the value *"is applied per-enrollment in the dispatch
loop"*, which this member's dispatch loop does not do.

### Is it reachable? CODE-REACHABLE, DEPLOYMENT-DORMANT.

Asked separately, per the method rule that the 08-24 pass added after publishing
a wrong headline.

- The code path is **complete**: `mark-posted.ts:194-213` enqueues for any
  response reaching `posted` with `approval_method='auto_policy'`; the worker is
  registered at `worker/index.ts:268`; `dispatch.ts:109` sends on every resolved
  channel.
- **But a guard upstream closes it.** `auto-policy-publish.ts:555-562`
  (`evaluateRuntimeGate`) downgrades every unposted `auto_policy` response when
  `autoApprovalRuntimeEnabled()` is false. Measured live on Railway:
  **prod `AUTO_APPROVAL_ENABLED` unset; staging `AUTO_APPROVAL_ENABLED=false`.**
  No auto-policy response can reach `posted` in either environment today.

> **The 08-24 prompt's framing — "repeated fresh hard bounces on the
> highest-volume notice in the family" — is accurate about the code and
> overstated about today.** The flag it depends on was turned back off on
> staging during the WS8 teardown. **Correct the tense in any PR body: this is
> LATENT, and it becomes live the instant `AUTO_APPROVAL_ENABLED` flips true.**

---

## B · H2 — one claim contract → NOT LANDED

Same empty `git log`. **The line numbers are unchanged from the 08-24
measurement**, which is itself corroboration.

| Sub-item | State | Evidence |
|---|---|---|
| 15-min reap in `claimAutoPostNoticeDelivery` | **absent** | `delivery.ts:84-104` — straight to `INSERT … ON CONFLICT … DO NOTHING`, no `DELETE`. Contrast `claimPendingPostNoticeDelivery`'s reap at `:158-168`. |
| …in `claimEscalationNoticeDelivery` | **absent** | `delivery.ts:113-133` — same shape, no `DELETE`. |
| Return `'claimed'\|'settled'\|'pending'` | **absent, both** | `:90` and `:119` still `Promise<string \| null>`; `:103` and `:132` still `return claimed.length === 1 ? id : null`. The union exists only for the other two members, `:190-192` and `:274-276`. |
| APN + ESC dispatchers THROW on pending | **absent, both** | `auto-post-notice/dispatch.ts:101-107` and `escalation-notice/dispatch.ts:137-143` both increment `skipped` and `continue`. Contrast `solicitation-veto-notice/dispatch.ts:121-127` and `autonomy-suspended-notice/dispatch.ts:76-82`, which `throw`. |

### Is it reachable? BOTH ARMS DEPLOYMENT-DORMANT, for two different reasons.

- `claimAutoPostNoticeDelivery` is called only from `auto-post-notice/dispatch.ts:94`
  — gated off by `AUTO_APPROVAL_ENABLED` as in §A.
- `claimEscalationNoticeDelivery` is reachable only via the Guardian escalation
  notice, and **`ESCALATION_ENABLED=false` on staging, unset in prod**.

**LATENT, not live.** The "silently loses a Guardian escalation notice"
characterisation is a correct description of the code and cannot occur today,
because escalation notices are not being produced anywhere.

---

## C · H3 — name the autonomy control surface → NOT LANDED, and this is the pass's headline

H3 was marked **"MUST LAND BEFORE #633 FLIPS ANYTHING."** #633 flipped
solicitation send-mode on staging inside this window (#973, #974, #979). **The
flip shipped. No part of H3 did.**

### (a) No single owning table exists

`rg 'autonomy control surface'` hits only the 08-24 artifacts and the arch log's
record of the finding. No new doc, no new section, no ADR.

`.claude/reference/env-vars.md` per-flag rows are good, and #974 **improved**
`:663`–`:664` to record the staging flip precisely. But H3's own text said
*"env-vars.md:661 is already correct and thorough. Do not rewrite it."*
**#974 improved the part that was already fine and left the missing part
missing.** The flags remain eight scattered rows under one heading, plus two
unrelated blocks in `docs/eservices-variables.md:204-212` and `:218-219` with no
relationship stated.

### (b) The two named runbooks are untouched, and a THIRD has the same defect

| File | Last touched | False at HEAD |
|---|---|---|
| `launch-flag-readiness.md` | `1a47985b` (#821) | `:104-108` names `AUTO_APPROVAL_ENABLED` and says *"Staging has all of these `true`"*. **Both solicitation flags are absent from the entire file.** |
| `agentic-staging-copilot-autopilot-e2e.md` | `f23888c5` (#521) | `:251` *"all six autonomy flags → false"*. `:256-258` *"Instant kill switches … `AUTO_APPROVAL_ENABLED=false` (stops all auto-posting)"*. `:77-82` a copy-pasteable `grep -E` enumerating exactly those six names. |
| **`beta-production-standup.md`** — *not on H3's list* | — | `:143` lists seven flags *"all unset/false"* and **omits both solicitation flags. This is the production go-live checklist.** |

### (c) The underlying claim is still exactly true

```
rg -P '(?<!SOLICITATION_)\bAUTO_APPROVAL_ENABLED\b' src/lib/solicitation/  →  ZERO
```

The only hits anywhere in the solicitation surface are two comments, one of
which (`SolicitationVetoNoticeWorker.ts:12`) **explicitly disclaims the
precedent**: *"AUTO_APPROVAL_ENABLED as a kill switch; that precedent does NOT
apply here."*

### Live flag state — measured on Railway, not inferred

| Environment | State |
|---|---|
| **production** | `AUTOPILOT_PURCHASABLE=false`; `AUTO_APPROVAL_ENABLED`, `TRIAGE_ENABLED`, `ESCALATION_ENABLED`, `JUDGE_ENABLED`, `GOVERNOR_ENABLED`, `SOLICITATION_SEND_ENABLED`, `SOLICITATION_AUTO_APPROVAL_ENABLED` — **all unset** |
| **staging** | `AUTO_APPROVAL_ENABLED=false`, `TRIAGE_ENABLED=false`, `ESCALATION_ENABLED=false`, `GOVERNOR_ENABLED=false`, `JUDGE_ENABLED=true`, **`SOLICITATION_SEND_ENABLED=true`**, **`SOLICITATION_AUTO_APPROVAL_ENABLED=true`** |

The 08-24 pass's *"production Railway has none of the three flags set; zero live
hazard"* **still holds.**

### The fair reading — and it is worse than "a doc is stale"

The dramatic reading is **not supported**: production is untouched, invariant #3
is not implicated (this lane does not post to Google), nothing auto-sends in
prod.

The sober reading is a live operational trap:

> **Staging is currently in the exact configuration the missing document was
> written to describe.** The only two autonomy flags ON in the entire deployed
> estate are the two the runbooks do not know about. Every Reply-lane flag the
> runbooks *do* enumerate is `false`.
>
> An operator who follows `agentic-staging-copilot-autopilot-e2e.md:77-82` today
> runs its `grep`, sees six flags at false/unset, and concludes **"you are at the
> Copilot baseline"** — while staging is autonomously generating and sending
> solicitation asks.
>
> And the documented **"instant kill switch" would change nothing**:
> `AUTO_APPROVAL_ENABLED=false` is already false and has **zero reads** in that
> lane.

Confined to staging — but staging is where the #633 evidence campaign runs, and
`beta-production-standup.md:143` propagates the same omission into the
production checklist.

**Verdict: NOT LANDED. Ordering constraint violated. Zero production risk, one
concrete mis-operation hazard live on staging, one latent omission in the
production go-live checklist.**

---

## D · The three 08-18 carry-forwards → ALL THREE FULLY FIXED

### D1 · #892 purge tombstone sentinels — `62cc98df` (#972) — exceeds the ask

`purge-sentinels.ts:51` is a frozen object with **nine** members, imported by
both writer (`purge-stages.ts:10`) and verifier (`purge-verification.ts:2`).
Zero tombstone literals remain on either side. The issue's table listed seven;
the PR **found and included a ninth** (`accounts.flags`, `'{}'::jsonb`) and split
the email into prefix/suffix.

Every one of the nine verifier comparisons is now `IS DISTINCT FROM`, including
the two former `NOT LIKE` sites. Remaining `NOT LIKE` uses (`:283,284,300,301,360,402,534`)
are `'scrubbed:%'` real-wildcard checks — a different class, correctly untouched.

Both anti-pattern guards honoured, with the reasoning written into the file
header (`:20-23`, `:28-31`). `docs/directory.md:1223` corrected from 27 to **28**.

> **QUALIFIED after the cross-feature phase — this verdict is correct for what
> it measured, and the class is larger than what it measured.** #972 gave the
> **tombstone sentinels** one owner and stopped one literal class short. The
> same two files still hand-share **20 copies of the `'scrubbed:'` prefix** and
> **2 of `'account purged'`**, split **10 ↔ 10**. (F11 measured 7 ↔ 9; the
> cross-feature re-measurement is 10 ↔ 10.)
>
> This is not a tidy-up. The verifier is a **fail-closed compliance gate**, so a
> drift on the *verifier* side does not fail loudly — it silently converts a
> failing purge into a **PASS**. Tracked as U10 / H10.
>
> The verdict above stands: nothing #892 **asked for** is missing. The scrub
> prefix was never in that issue's scope.

### D2 · #894 tenant-scope blind spot — `388d0297` (#962) — all three ordered steps

- **Step 1** — the false *"the audit requires this join"* claim corrected at
  `pending-count.ts:29-33`, and the convention applied at 10 production sites.
- **Step 2** — `users` taught as a **BRIDGE binding class** anchored on a
  qualified `u.auth_id` predicate, with three shapes including the issue's 4th
  and a generalised 5th. Measured `--no-allowlist`: **355 → 331 findings; 24
  allowlist entries deleted; baseline 393 → 369.** `TENANT_TABLES` correctly
  **not** widened.
- **Step 3** — `tenant-tables.ts:189-240`, eight entries with substantive
  reasons, keyed on coverage rather than column presence.
  `solicitation_send_breaker` at `:227` is called out as *"the entry a
  column-presence predicate could never demand"*. The integration test asserts
  every live public table is in **exactly one** list.

> **Not a gap:** `rls-audit.ts:14` still couples `REQUIRED_RLS_TABLES` to
> `TENANT_TABLES`. Issue #894 asked for no such thing. Worth a future pass's
> attention — with `users` now a bridge class, the RLS audit inherits that
> decision silently — but it is not an unmet requirement.

### D3 · #895 truth-and-tripwire bundle — `13a11e4d` (#970) — all five live items

(a) `SolicitationBatchPanel.tsx:72-75` guards the label lookup with
`Object.hasOwn`; the anti-pattern guard against a shared helper is honoured.
(c) The stale purge suppression contract is fixed at **both** sites, and
deliberately does not enumerate callers — *"a hand-maintained caller census here
is what went stale last time."*
(d) The one-sided lock-order comment **retracts the issue's own premise** and
states the real constraint.
(e) `solicitation-lane.ts:669` now logs `business_id`, matching its four
siblings.
(f) `auth-island.css:5-11` — all ten redeclared tokens **deleted**, not
realigned, now guarded by `design-token-single-source.test.ts` walking
`src/components/auth` dynamically with a non-empty census assertion so it cannot
pass vacuously.

**Two of the three PRs actively corrected the issue's own text** — #892's
sentinel count 7 → 9, #895(d)'s FK premise. That is stronger than compliance.

---

## E · The `#3a` dangling reference → NOTHING CHANGED

`grep -rn "#3a" docs/` returns 9 lines. **Eight are Pathfinder artifacts
discussing this very problem.** The one substantive hit is unchanged:

```
docs/superpowers/specs/2026-07-07-ws4-trust-dial-veto-window-design.md:260
  …including the bounced-owner email skip from day one (the WS3 parity fix —
  known follow-up #3a does not grow a third instance)…
```

That file's last commit is `0ae6a09c` (#464, the original WS4 feature). **It has
never been edited since the sentence was written, and the sentence is still
false.** No issue was opened. The reference was not deleted.

### The contrast that names the mechanism

The **sibling** identifier `#3b`, invented in the same era for the stale-claim
reap, **is** tracked — in four places including two production files
(`delivery.ts:157`, `ws6-judge-governor-design.md:397`, and two WS4 docs) — and
has been progressively narrowed template by template.

`#3a` got identical treatment in prose and **zero** follow-through.

**The 08-24 process finding — "a follow-up named in a spec gets an issue number
in the same PR, or it does not get named" — was not adopted. It is now nine
weeks live.**

---

## Confidence and gaps

**High confidence:** A, B, D, E. Direct source reads at HEAD, several
corroborated by an empty `git log` over the exact blast radius. D was verified
three ways — commit stat, full commit body, current source at cited lines.

**High confidence with one soft edge:** C. Doc facts, the `rg` result and the
runbooks' last-touched commits are hard. Railway readings are live and
authoritative **for the worker**. **Vercel environment variables were not read.**
None of the three flags has a `NEXT_PUBLIC_*` companion (invariant #13) and all
are server-only, so a Vercel-side value would not change the finding — but it
was not confirmed.

**Other gaps:**

1. Per-member `owner_email_bounced` counts do not reproduce the 08-24 figures
   (5/9 measured versus 7/8 published). Counting method undetermined.
2. The tests the three D-merges added were **read, not run**. `pnpm test` was
   not executed.
3. For A's residual `recoverAutoPolicyProviderTruth` path, the call site was
   traced and established as downstream of `evaluateRuntimeGate`, but no
   exhaustive proof was made that a flag-off entry into the ambiguity branch is
   impossible. Described as *narrow and requiring a carried-over in-flight
   ambiguity* rather than asserted closed.
