# Step 6 — adversarial review of the implementation (`/codex:adversarial-review`)

**Run** 2026-08-03 against the branch diff vs `main` (43 files, 9148 insertions).
**Verdict: `needs-attention`** — *"Do not ship: valid-token replays can exhaust shared database
capacity, and secret rotation would silently invalidate every delivered unsubscribe link."*

Distinct from the six pre-implementation passes: those reviewed the **plan**, this challenged
what was actually **built**. Both findings survived all six, which is the point of running it.

---

## Finding 1 — a single genuine token bypasses all workload protection (high) → **ACCEPTED, partially fixed**

> The HMAC gate blocks random strings, but every replay of one delivered token passes it and
> opens a transaction. The route is deliberately unrate-limited and uses the shared Postgres
> client, so one recipient can issue unbounded concurrent replays and occupy the worker pool.

**Verified before acting.** `worker/ingress/unsubscribe.ts` imports `sql` from
`src/lib/db/server` — the **shared write pool**, `DB_POOL_MAX=20` on the Railway worker — and
CLAUDE.md records that the hot-four BullMQ workers already sum to **18** concurrent slots
against it. Roughly two connections of headroom, now shared with an unrate-limited public
route.

**This retires a claim the plan made.** §1.4a dismissed the residual as *"no worse than any
other public page"*. That is **false**: every other public route sits behind the app limiter or
the WAF, and this one is deliberately exempt by §9.2. The residual was real and under-argued.

**Fixed in-surface: per-token single-flight** (`24da3528`). Concurrent in-flight redemptions of
the same token hash collapse to one database round trip; later arrivals await the in-flight
promise and share its outcome, which is sound because all three non-`unknown_token` outcomes
map to 200. Verified genuinely red first — **6 concurrent replays opened 6 transactions**
without it. Cap 1024, bypass-not-reject past the cap, released on both settle paths.

**Why not the reviewer's own recommendation of a bulkhead returning 503 when full:** an earlier
revision had exactly that, and owner review deleted it because shedding a well-formed request
is an intentional silent loss of a statutory opt-out. **Single-flight sheds nothing** — every
caller still receives a real outcome — so it bounds the attack without reintroducing that loss
path. It raises the bar from *"one token → unbounded connections"* to *"N distinct genuine
tokens → N connections"*, which requires compromising N recipients' links.

**Residual, NOT closed — needs an owner decision.** The reviewer also recommended a *dedicated
bounded DB pool* so redemption cannot touch webhook/job capacity at all. That is the complete
fix and single-flight is not a substitute for it: many distinct tokens still contend. It
requires `src/lib/db/server.ts` (**outside `allowed_edit_surface`** → surface amendment #3),
re-deriving ADR-0009's connection budget (57 usable backend connections; Vercel isolates × 11
≤ 200 Supavisor clients), and a staging burst drill.

**Owner decision 2026-08-03: follow-up ticket → [#651](https://github.com/RepWorth/ai-review-responder/issues/651).**
Rationale accepted: the residual now requires N *distinct genuine* tokens — compromising N
recipients' delivered links — a far higher bar than the one-token flood that was open before;
a third Postgres client is a real capacity change ADR-0009 requires be re-derived and
burst-drilled; and it sizes better after the staging ride produces real traffic numbers.
Recorded so a step-7 reviewer raising pool isolation finds the decision rather than the gap.

---

## Finding 2 — rotating the shared secret irrecoverably breaks delivered links (high) → **ACCEPTED, fixed**

> Token verification accepts only the current `SESSION_COOKIE_SECRET`… Documentation saying the
> shared secret must never rotate is not a safe rollover mechanism, especially because the same
> secret protects unrelated session/offboarding domains and **may require emergency rotation**.

**This overturns an earlier owner decision on new information.** D1 recorded *document-only*,
and that ruling was made on the framing I supplied: rotation is a thing you choose to avoid.
The reviewer's argument is stronger and I had not put it forward — **a compromise makes
rotation forced**, and at that moment the choice is between session security and statutory
compliance. Owner re-ruled after seeing the finding: implement rollover.

**Fixed** (`24da3528`): optional `SESSION_COOKIE_SECRET_PREVIOUS`; verification tries current,
then previous only on a miss; **minting always uses the current key**, so a token can never
outlive the window meant to retire it. Totality, constant-time-per-candidate and zero-DB all
preserved. A configured-but-short previous key throws at config read *and* fails the boot gate,
so a rollover typo crash-loops the deploy instead of 503-ing every opt-out. The registry entry's
"no safe rollover exists" warning is replaced with the actual procedure and the ≥30-day
retention window.

**Chose current-plus-previous over a dedicated unsubscribe key** (the reviewer offered both): a
dedicated key needs a second long-lived secret provisioned across three environments and two
platforms *before* this can ship, and an unset-in-prod mistake fails every link closed. The
optional previous-key var deploys safely because empty is the default and changes nothing.

**Two residuals, both recorded:**
1. The **keep-my-data offboarding token** has no previous-key path, so a rotation still
   invalidates every outstanding one. Same root cause, different domain — its own ticket.
2. A broken previous key is caught at **worker** boot; **Vercel has no boot phase**, so there it
   surfaces on the first affected link.

---

## Triage summary

| Finding | Verdict | Disposition |
|---|---|---|
| 1 — valid-token replay exhausts the shared pool | **ACCEPT** | Single-flight landed. **Dedicated pool open — owner decision required.** |
| 2 — secret rotation breaks delivered links | **ACCEPT** | Current-plus-previous rollover landed; registry procedure rewritten. |

Gate re-run after the fixes: **GREEN** at `24da3528`, 70/70 promised titles, live-DB
integration suite run for real, `diff-coverage` passing.
