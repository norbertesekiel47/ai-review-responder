# Runbook: Vercel WAF rate limiting + Attack Mode (Slice 2 platform safety net)

**Owner:** platform / on-call · **Plan:** Vercel **Pro** (WAF custom rules, BotID,
Attack Mode) · **Project:** `rep-worth` (single Vercel project; see "Environment
scoping" below).

This runbook is the **authoritative, version-controlled definition** of
RepWorth's Vercel WAF custom rules. WAF rules are Vercel *platform state*
(staged drafts → publish), not a committable repo config file — there is no
`vercel.json` field for custom rules. Re-running the commands here reproduces the
rule set. **If a live rule is changed, change it here too** (one authoritative
representation).

> **Execution status — 2026-06-09** · Legend: ✅ done & verified · 🟡 done but
> not yet verified, or pending
>
> - ✅ Project linked (repo-link `.vercel/repo.json` → `rep-worth`)
> - ✅ All four rules staged, published by owner, CLI-verified live
>   (`vercel firewall overview` + `rules list --expand`, 2026-06-09)
> - ✅ Priority order verified — enforce rules at positions 1–2, LOG net below
> - ✅ Attack Mode confirmed **Off**, System Mitigations **Active** (untouched)
> - 🟡 BotID Deep Analysis toggle — owner reports enabled; dashboard-only
>   setting, not verifiable from the CLI
> - 🟡 Post-publish traffic review — pending real traffic in the dashboard
> - 🟡 Flip-to-enforce of the broad LOG net — **later, owner-approved**;
>   baseline window starts 2026-06-09
> - ✅ 3c (`qr-redirect-per-ip-enforce`) added + published 2026-08-27 → **5
>   active rules live** (re-verified via CLI 2026-09-07 ahead of #1187)
> - ✅ `api-options-volumetric-log` (1c, #1187) applied by the owner via CLI
>   2026-09-08, id `rule_api_options_volumetric_log_kJJB6d` → **6 active
>   rules live** (CLI-verified 2026-09-08). Spec + how it was applied:
>   Component 1c below.

It covers Slice 2 of the rate-limiting hardening plan:

- **Component 1** — broad per-IP volumetric net on `/api/*`, split by method,
  shipped in **LOG mode** (records matches, blocks nothing). NOT enforced in this
  slice; flip is owner-approved later (see "Flip-to-enforce checklist"). A
  third split, `api-options-volumetric-log` (OPTIONS preflight), was applied by
  the owner 2026-09-08 (#1187) and is **LIVE** in LOG mode.
- **Component 3** — per-path tighter rules on `signup` + `onboarding/start`,
  **ENFORCING now**.
- **Component 4** — Attack Mode, documented as a break-glass toggle (owner-run).

Component 2 (BotID) is **code**, not WAF config — see the PR + ADR 0002. App-layer
per-route limits from Slice 1 stay; the WAF is an additional layer underneath,
not a replacement.

> **DDoS note.** Automatic L3/L4/L7 DDoS mitigation is always on for every Vercel
> project at no cost and needs no configuration. The rules below are
> application-level abuse controls on top of that.

---

## How WAF rules are layered here

```
Request → Vercel automatic DDoS mitigation (always on)
        → WAF custom rules (this runbook), evaluated top→bottom:
            1. signup-per-ip-enforce          (5/min/IP  → 429)   [ENFORCE]
            2. onboarding-start-per-ip-enforce (10/min/IP → 429)  [ENFORCE]
            3. api-mutating-volumetric-log     (100/10s/IP)       [LOG only]
            4. api-get-volumetric-log          (600/10s/IP)       [LOG only]
            5. api-options-volumetric-log      (100/10s/IP)       [LOG only]
        → BotID managed check (code: checkBotId in 4 routes)
        → Next.js function → app-layer per-owner/email/IP limits (Slice 1)
        → worker cost-guard reserve-before-LLM (spend ceiling)
```

Rate-limit rules each keep their own counter, so a single `signup` POST is
counted by rule 1 **and** rule 3. Tighter enforcing rules sit above the broad LOG
net so an enforced 429 short-circuits before the LOG net (which only counts).

---

## Prerequisites (owner)

1. ✅ **Link the project** — done: the repo is linked via the repo-link format
   (`.vercel/repo.json` → project `rep-worth`,
   `prj_wIMnzHKefoQRdzCeMZesg2mIgNc0`, team `norbert-esekiels-projects`), which
   the firewall CLI accepts. On a fresh machine:
   ```bash
   vercel link            # select the rep-worth project / correct team
   ```
2. ✅ Confirm Pro plan and that the acting user has Firewall write permission —
   verified implicitly: staging and the owner publish both succeeded.
3. ✅ All `vercel firewall rules add/edit` commands **stage drafts**. They go live
   only after **`vercel firewall publish --yes`**, which the **owner** runs after
   reviewing `vercel firewall diff`. Do not publish on someone else's behalf.
   (Owner published 2026-06-09.)

---

## Environment scoping (read before adding rules)

RepWorth is **one Vercel project** (`rep-worth`). Production is `main` →
`repworth.net`. Staging is the **`staging` Custom Environment**
(`env_Xdvi79MDL9zMt5LmTMRLFSBBeKGT`, **type `preview`**, branch `staging`) →
`staging.repworth.net`. Previews are per-PR.

WAF custom rules are **project-scoped**: with **no `environment` condition** they
apply to **production, the staging custom env, and previews** alike. That is what
we want — one rule set covers prod **and** staging.

> ⚠️ Do **not** add `{"type":"environment","op":"eq","value":"production"}` to
> "target production." The staging custom env is **preview-type**, so a
> production-only condition would **exclude staging**. Leave the environment
> condition off so prod + staging are both covered. (The only place an
> `environment` condition is used here is the optional "test the flip in preview
> first" step.)

---

## Component 3 — per-path enforcing rules (ENFORCE NOW) — ✅ LIVE (published 2026-06-09; 3c published 2026-08-27)

> ⚠️ **`vercel firewall rules add` only STAGES a rule — it is NOT live until
> `vercel firewall publish --yes`.** This stalled the 2026-08-27 publish of 3c
> twice: the rule showed in `rules ls` but blocked nothing until published.

Live rule IDs: `rule_signup_per_ip_enforce_UMAAj8` (3a),
`rule_onboarding_start_per_ip_enforce_GxpRCA` (3b),
`rule_qr_redirect_per_ip_enforce_<fill from vercel firewall rules ls>` (3c).

Mirrors the existing app limits at the edge (app: signup 5/hour/IP strict,
onboarding-start 10/hour/auth-id strict). The per-IP/min WAF limits are
deliberately **looser than the app limits** (a legit user can't exceed the app
cap anyway), so they won't false-positive real users — they catch a burst flood
at the edge before any function runs. `--rate-limit-action rate_limit` returns
**429** (matches the app's rate-limit response); swap to `deny` (403) if you want
a harder block.

```bash
# 3a. /api/auth/signup — 5 requests / 60s per IP → 429
vercel firewall rules add "signup-per-ip-enforce" \
  --condition '{"type":"path","op":"eq","value":"/api/auth/signup"}' \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --action rate_limit \
  --rate-limit-window 60 \
  --rate-limit-requests 5 \
  --rate-limit-keys ip \
  --rate-limit-action rate_limit \
  --yes

# 3b. /api/onboarding/start — 10 requests / 60s per IP → 429
vercel firewall rules add "onboarding-start-per-ip-enforce" \
  --condition '{"type":"path","op":"eq","value":"/api/onboarding/start"}' \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --action rate_limit \
  --rate-limit-window 60 \
  --rate-limit-requests 10 \
  --rate-limit-keys ip \
  --rate-limit-action rate_limit \
  --yes

# 3c. /q/* (public QR redirect) — 30 requests / 60s per IP → 429, ANY method
vercel firewall rules add "qr-redirect-per-ip-enforce" \
  --condition '{"type":"path","op":"pre","value":"/q/"}' \
  --action rate_limit \
  --rate-limit-window 60 \
  --rate-limit-requests 30 \
  --rate-limit-keys ip \
  --rate-limit-action rate_limit \
  --yes
```

**3c — why it exists (published + burst-verified 2026-08-27):** the public QR
redirect writes one durable `analytics_events` row per anonymous scan, so an
unthrottled `/q/*` flood is a database-write amplifier — feat-qr-review-request
adversarial review finding A2, accepted as an ops gate; `/q/*` sat outside this
runbook's enforcing coverage until this rule. No method condition (a redirect
answers GET, but any method reaches the route) and, per the "Environment
scoping" section above, **no environment condition** — project-scoped, so it
covers prod and the staging custom env alike. Burst-verified 2026-08-27 with a
40-request burst against `repworth.net/q/…`: exactly 30×404 then 10×429.

---

## Component 1 — broad volumetric net, split by method (LOG ONLY) — ✅ 1a/1b/1c LIVE in LOG mode (1a/1b published 2026-06-09; 1c applied by owner 2026-09-08, #1187)

Live rule IDs: `rule_api_mutating_volumetric_log_fQ61fH` (1a),
`rule_api_get_volumetric_log_oLxHcD` (1b),
`rule_api_options_volumetric_log_kJJB6d` (1c).

A default net so every `/api/*` route — including future ones — has baseline
per-IP protection at the edge. **Shipped in LOG mode**: `--rate-limit-action log`
counts per-IP and records threshold breaches to the Firewall dashboard but
**blocks nothing**. Do not flip to enforce in this slice.

**Why split, not one blanket rule:** real SPA polling can legitimately spike one
IP. Past-replies draft-status polls ~every 1.5s (`useEditReplyDraft.ts`),
onboarding demo ~every 2s (`PaywallWithDemoClient.tsx`); shared office NAT +
multiple tabs + concurrent owners compound. A naive 100/10s blanket rule would
log/throttle a busy office on GET polling. So the mutating net is scoped to
`POST/PUT/DELETE` (polling GETs never match it), and GETs get a separate, much
higher LOG threshold.

```bash
# 1a. Mutating methods on /api/* — 100 requests / 10s per IP (LOG)
vercel firewall rules add "api-mutating-volumetric-log" \
  --condition '{"type":"path","op":"pre","value":"/api"}' \
  --condition '{"type":"method","op":"inc","value":["POST","PUT","DELETE"]}' \
  --action rate_limit \
  --rate-limit-window 10 \
  --rate-limit-requests 100 \
  --rate-limit-keys ip \
  --rate-limit-action log \
  --yes

# 1b. GET on /api/* — generous LOG tripwire for scraping; sized FAR above polling
#     (600/10s = 60 rps/IP). Polling carve-out: this threshold is intentionally
#     high so shared-NAT polling never trips it. Tune from baseline before any
#     future flip.
vercel firewall rules add "api-get-volumetric-log" \
  --condition '{"type":"path","op":"pre","value":"/api"}' \
  --condition '{"type":"method","op":"eq","value":"GET"}' \
  --action rate_limit \
  --rate-limit-window 10 \
  --rate-limit-requests 600 \
  --rate-limit-keys ip \
  --rate-limit-action log \
  --yes
```

> The broad net also closes the minor `/api/analytics/enqueue` dodge (its app
> limiter keys on a client-supplied, rotatable `anonymousId`; the per-IP edge net
> doesn't care about that field). No app-code change needed.

> ⚠️ **`POST /api/u/<token>` (#644 unsubscribe) already matches rule 1a and MUST
> be excluded before any flip to enforce.** Rule 1a keys on `path prefix /api` +
> `POST`, so the unsubscribe landing form POST is inside it today. That is
> harmless while the rule is LOG-only — it counts and blocks nothing — and becomes
> a **compliance defect the moment it enforces**.
>
> Spec §9.2 forbids rate limiting, BotID registration, and WAF enforcement on both
> unsubscribe surfaces, because a throttled unsubscribe is a **silently lost
> statutory opt-out**: the recipient sees a failure page, believes they opted out
> or gives up, and keeps receiving mail, while CAN-SPAM §7704(a)(3) requires the
> link operate for ≥30 days. Unlike every other route under this net, there is no
> retry the *user* can be expected to perform and no signal that anything went
> wrong. It is also the one route where hostile volume is already handled in the
> application: a forged token is rejected by a constant-time HMAC gate that opens
> **no database connection at all** (#644 plan §1.4a), which is precisely what
> made edge admission control unnecessary here.
>
> **The GET landing page `/u/<token>` is not affected** — rules 1a and 1b are both
> scoped to the `/api` prefix, so it matches neither. Only the form POST does.
>
> **The Railway ingress `POST|GET /ingress/unsubscribe/<token>` is out of scope for
> the WAF entirely** — it terminates on Railway, not Vercel (invariant #6). Its
> equivalent exemption lives in the worker's own `onRequest` limiter hook, keyed on
> resolved route config; see `worker/index.ts` and `worker/ingress/rate-limit.ts`.

### 1c — `OPTIONS /api/*` volumetric LOG tripwire — ✅ LIVE (applied by owner via CLI 2026-09-08, id `rule_api_options_volumetric_log_kJJB6d`) (#1187)

Surfaced by ADR 0026 D8 while building the Admin API CORS preflight: **no live
WAF rule matched the `OPTIONS` method** — the four/five method-scoped rules
above matched `POST`, `GET`, `PUT`, `DELETE`, but nothing matched `OPTIONS`,
and that gap was app-wide, not admin-specific. D8 explicitly deferred the fix
to this follow-up ticket rather than letting a whole-surface WAF change ride
in on an admin CORS PR. This rule closes that gap.

**Why this is its own rule, never an edit to `api-mutating-volumetric-log`.**
ADR 0026 D8 rejected folding `OPTIONS` into 1a as a bare alternative; the
elaborated reasoning is ticket #1187's: a preflight mutates nothing, so 1a's
name would stop describing what it counts, and one shared counter would let a
preflight burst mask — or be masked by — a real mutating-write burst.
`api-options-volumetric-log` is a fourth, independent counter. Do not add
`OPTIONS` to 1a's `--condition method inc [...]` list.

**Threshold reasoning — same sizing METHOD as 1a/1b (headroom over the
realistic legitimate peak), reusing 1a's NUMBER rather than inventing a
third.** 1a sizes tight (100/10s) because it protects a mutating resource the
app's own limits already cap. 1b sizes loose (600/10s) because real SPA GET
polling under shared-NAT compounding can legitimately spike one IP (see "why
split, not one blanket rule" above). OPTIONS preflight has neither pressure:
per ADR 0026 D8, `Access-Control-Max-Age: 600` caps a compliant browser to one
preflight per path per ten minutes, so legitimate preflight volume per IP
should sit far BELOW 1a's mutating volume — nowhere near 1b's polling-driven
volume. Since expected legitimate OPTIONS volume is lower than 1a's own
traffic, 1a's already-tight **100 requests / 10s / IP** carries even more
headroom here than it does for 1a itself, so it is reused as-is rather than
guessing a lower number with no baseline data to justify it. Applied
2026-09-08 in LOG mode; no baseline data exists yet on this new rule — collect
3–7 days before ever flipping to enforce, exactly as the "Flip-to-enforce
checklist" below requires for 1a/1b.

```bash
# 1c. OPTIONS on /api/* — 100 requests / 10s per IP (LOG) — applied 2026-09-08
#     by the owner, id rule_api_options_volumetric_log_kJJB6d. Reproduced here
#     per this runbook's own "if a live rule is changed, change it here too."
vercel firewall rules add "api-options-volumetric-log" \
  --condition '{"type":"path","op":"pre","value":"/api"}' \
  --condition '{"type":"method","op":"eq","value":"OPTIONS"}' \
  --action rate_limit \
  --rate-limit-window 10 \
  --rate-limit-requests 100 \
  --rate-limit-keys ip \
  --rate-limit-action log \
  --yes
```

**Follow-up (owner-approved, later — mirrors 1a/1b):** flip to enforce only
after a 3–7 day LOG baseline confirms no legitimate shared-NAT source trips
it (baseline window opened 2026-09-08, the day this rule went live) — see its
own entry in the "Flip-to-enforce checklist" below.

#### How this was applied (owner) — dashboard and CLI reference

Applied 2026-09-08 by the owner via the CLI method (step 2 below).

CLI flags verified 2026-09-07 against the installed CLI (`vercel firewall
rules --help`, `vercel firewall rules add --help`) on **Vercel CLI 54.14.5**:
`add`/`reorder`/`publish`/`diff`/`list` all match this runbook's existing
usage exactly, and `--condition`/`--action`/`--rate-limit-window`/
`--rate-limit-requests`/`--rate-limit-keys`/`--rate-limit-action` are
unchanged from the flags 1a/1b/3a–3c already use above — **no CLI drift
found.** `vercel firewall rules list` is the canonical subcommand name;
`rules ls` (used as a placeholder elsewhere in this doc) is accepted as an
alias by the same installed CLI.

Read-only inventory taken 2026-09-07 ahead of this change (`vercel firewall
overview` + `vercel firewall rules list --expand`, project `rep-worth`): **5
active rules, 0 inactive** — `signup-per-ip-enforce`,
`onboarding-start-per-ip-enforce`, `api-mutating-volumetric-log`,
`api-get-volumetric-log`, `qr-redirect-per-ip-enforce`. **None matched
`OPTIONS`**, confirming the gap this ticket existed to close.
`vercel firewall diff` showed no pending draft changes.

1. **Dashboard** (reference — the owner used the CLI path this time) — Vercel
   dashboard → project `rep-worth` → **Firewall → Rules → Add rule** → name it
   `api-options-volumetric-log` → add condition **Path** *starts with* `/api`
   AND condition **Method** *is* `OPTIONS` → Action **Rate Limit** → algorithm
   **Fixed window**, **100** requests per **10** seconds, key **IP address** →
   "If limit exceeded" = **Log only** → Save (stages a draft) → open
   **Firewall → Rules** unpublished-changes diff and confirm only this one
   rule is new → **Publish**.
2. **CLI (used 2026-09-08)** — the `1c` command block above, then:
   ```bash
   vercel firewall diff              # confirmed ONLY api-options-volumetric-log was staged
   vercel firewall publish --yes     # OWNER ran this — production-affecting
   ```
   No `reorder` step was needed: like 1a/1b, this is LOG-only with no
   enforcing action, so its position relative to the enforcing rules
   (3a/3b/3c) doesn't matter.
3. **Verified live 2026-09-08:**
   ```bash
   vercel firewall rules list --expand   # 6 active rules; new rule's action = log
   vercel firewall overview              # "Custom Rules: 6 active, 0 inactive (6 total)"
   ```
   `rules list --expand` showed `api-options-volumetric-log [Enabled]` —
   `path starts with /api`, `method equals OPTIONS`, Rate Limit 100/10s
   (fixed_window), keys `ip`, if exceeded `log` — matching the spec above
   exactly. The "State summary" table below has been updated from PENDING to
   this live rule ID and apply date, per this runbook's own "if a live rule
   is changed, change it here too" rule.

---

## Ordering, review, publish (owner) — ✅ DONE (published 2026-06-09)

Rules evaluate top→bottom. Put the enforcing per-path rules above the LOG net:

```bash
vercel firewall rules reorder "signup-per-ip-enforce"            --first --yes
vercel firewall rules reorder "onboarding-start-per-ip-enforce"  --position 2 --yes
# 1a / 1b (LOG) fall below — order among them doesn't matter (they only log).
```

Review and publish:

```bash
vercel firewall rules list --expand        # sanity-check conditions + actions
vercel firewall diff                       # exactly what will go live
vercel firewall publish --yes              # OWNER runs this — production-affecting
```

🟡 After publishing, watch traffic (pending — review once real traffic accrues):

```
https://vercel.com/norbert-esekiels-projects/rep-worth/firewall/traffic?filter=rule_signup_per_ip_enforce_UMAAj8
https://vercel.com/norbert-esekiels-projects/rep-worth/firewall/traffic?filter=rule_onboarding_start_per_ip_enforce_GxpRCA
https://vercel.com/norbert-esekiels-projects/rep-worth/firewall/traffic?filter=rule_api_mutating_volumetric_log_fQ61fH
https://vercel.com/norbert-esekiels-projects/rep-worth/firewall/traffic?filter=rule_api_get_volumetric_log_oLxHcD
```

With Observability Plus you can instead use:

```bash
vc metrics vercel.firewall_action.count --group-by waf_rule_id --group-by waf_action --since 7d --format json
```

---

## Enable BotID Deep Analysis (owner, dashboard — for Component 2) — 🟡 owner reports enabled 2026-06-09; dashboard-only, not yet independently verified

BotID **Basic** works as soon as the code PR deploys (no toggle). The two
Deep-Analysis routes (`/api/auth/signup`, `/api/onboarding/start`) ask for
`checkLevel: 'deepAnalysis'`; for that ML scoring to run, enable it once:

- Vercel dashboard → project `rep-worth` → **Firewall → Rules → enable "Vercel
  BotID Deep Analysis"** (Pro/Enterprise; **$1 / 1000** `checkBotId()` Deep
  Analysis calls — billed only on the two deep routes. `signup` sits behind a
  feature-flag 404 and `onboarding/start` runs the Deep check only AFTER its auth
  `401`, so disabled / cross-origin / session-less requests aren't charged).

If Deep Analysis is **not** enabled, those routes silently fall back to Basic
validation — they keep working, just without ML scoring. The Basic routes
(`login-attempt`, `lead-intake`) are unaffected and free.

> BotID protects four routes total: `signup` + `onboarding/start` (Deep),
> `login-attempt` + `lead-intake` (Basic). `/api/contact` and `/api/demo-request`
> are intentionally NOT BotID-protected — they are dead public-lead remnants with
> no in-app (token-bearing) caller, so they rely on the per-IP WAF net above
> instead. See ADR 0002 and `src/lib/security/botid-routes.ts`.

---

## Flip-to-enforce checklist — Component 1 broad net (LATER, owner-approved) — 🟡 NOT STARTED (baseline window opened 2026-06-09)

**Do this only after a 3–7 day NAT-safe baseline. It is a separate, owner-approved
follow-up — NOT part of the Slice 2 delivery.** Evidence source = the Vercel
Firewall dashboard (traffic filtered by rule ID) or `vc metrics`.

**Before flipping `api-options-volumetric-log` to enforce** (Component 1c,
#1187 — live 2026-09-08, baseline window opened that day):

- [ ] 3–7 days of LOG data collected across a normal weekly cycle (incl. a
      busy weekday).
- [ ] No legitimate shared-NAT IP (several concurrent admin/owner sessions
      behind one office IP) sustained >100 OPTIONS requests in any 10s window.
- [ ] Re-confirm there is no exclusion case for this rule the way 1a needed
      one for `POST /api/u/*` — a preflight carries no cookies or body, so
      none is currently known, but check before any flip rather than assume.
- [ ] Measured p99 per-IP OPTIONS rate over a 10s window sits comfortably
      below 100 (target 3x headroom or more). If not, raise the threshold,
      re-baseline, then revisit.

Before flipping `api-mutating-volumetric-log` to enforce:

- [ ] 🛑 **BLOCKER — exclude `POST /api/u/*` first (#644, spec §9.2).** Rule 1a's
      `/api` prefix currently matches the unsubscribe form POST. Flipping to
      enforce without an exclusion rate-limits a statutory opt-out, which is
      silently lost rather than retried — see the warning under Component 1. Add a
      negative path condition to 1a (re-specifying ALL conditions, since
      `edit --condition` overwrites the set), then verify with a burst against
      `POST /api/u/<any-token>` that it is **not** throttled while a sibling
      `/api/*` POST still is. Do not treat "the app doesn't rate-limit it" as
      sufficient — the whole point of an edge net is that it acts before the app.
- [ ] **3–7 days** of LOG data collected across a normal weekly cycle (incl. a
      busy weekday).
- [ ] No **legitimate shared-NAT office IP** sustained >100 `POST/PUT/DELETE` in
      any 10s window. (Polling is GET, so it doesn't hit this rule — but confirm.)
- [ ] Measured **p99 per-IP mutating rate** over a 10s window sits comfortably
      below 100 (target ≥3× headroom). If not, raise the threshold to
      `p99 × 3`, re-baseline, then revisit.
- [ ] No legit **batch/admin burst** from one IP (CSV import, admin bulk actions,
      automated owner integrations) trips it.
- [ ] Account for **per-region counting**: WAF counters are per region, so the
      effective ceiling is ~N×100 across N regions. For a per-IP key this is
      usually one region/IP, but verify distributed sources don't skew it.

Before flipping `api-get-volumetric-log` to enforce (lower priority — GET abuse is
scraping, not cost): confirm the **per-IP GET p99** (dashboards + the three
polling endpoints under heavy shared NAT) is well below the chosen threshold;
set the enforce limit to `GET p99 × (headroom)`.

**How to flip (re-specify ALL conditions — `edit --condition` overwrites the
set):**

```bash
# Optional safety: test in PREVIEW first (prod/staging stay LOG).
vercel firewall rules edit "api-mutating-volumetric-log" \
  --condition '{"type":"path","op":"pre","value":"/api"}' \
  --condition '{"type":"method","op":"inc","value":["POST","PUT","DELETE"]}' \
  --condition '{"type":"environment","op":"eq","value":"preview"}' \
  --rate-limit-action rate_limit \
  --yes
vercel firewall publish --yes
# …hit a preview deploy, confirm 429s land for the abuse pattern only…

# Then production+staging: drop the environment condition, keep rate_limit action.
vercel firewall rules edit "api-mutating-volumetric-log" \
  --condition '{"type":"path","op":"pre","value":"/api"}' \
  --condition '{"type":"method","op":"inc","value":["POST","PUT","DELETE"]}' \
  --rate-limit-action rate_limit \
  --yes
vercel firewall publish --yes
```

**Rollback (immediate):** if real users get 429s after the flip —
```bash
vercel firewall rules edit "api-mutating-volumetric-log" \
  --condition '{"type":"path","op":"pre","value":"/api"}' \
  --condition '{"type":"method","op":"inc","value":["POST","PUT","DELETE"]}' \
  --rate-limit-action log --yes        # back to LOG
vercel firewall publish --yes
# or fully disable:
vercel firewall rules disable "api-mutating-volumetric-log" && vercel firewall publish --yes
```
Keep the dashboard URL open for the first 24h after any flip. **Remember to update
this runbook** whenever the live rule changes.

---

## Component 4 — Attack Mode (break-glass, owner-run) — ✅ verified Off 2026-06-09 (as intended; System Mitigations Active)

**What it is:** Attack Mode shows every *unverified* visitor a challenge page;
verified bots and search crawlers (Googlebot, etc.) are exempt. Use it as
**emergency response to an active L7 attack** that is overwhelming the rate
limits + BotID (e.g. a botnet flooding signup/onboarding faster than the per-IP
limits cap, distributed across many IPs).

**It is NOT always-on.** It adds friction (a challenge interstitial) for real
users, so it is a deliberate, time-boxed, reversible break-glass action.

**Why it's owner-run, not automated:** the `vercel firewall attack-mode` command
**requires interactive confirmation and is blocked for agents/scripts** by
design. An agent cannot enable it; surface this section to a human.

Per production.md (authorized · auditable · clear stop · bounded blast radius):

- **Authorized:** owner / on-call with Firewall write access only.
- **Enable (time-boxed):**
  ```bash
  vercel firewall attack-mode enable --duration 1h --yes     # 1h default
  # escalate only if needed: --duration 6h | 24h
  ```
  Takes effect **immediately** (no publish step).
- **Bounded blast radius:** auto-expires after the chosen duration; start at 1h
  and re-enable if the attack persists rather than opening with 24h.
- **Clear stop mechanism:**
  ```bash
  vercel firewall attack-mode disable --yes
  ```
- **Auditable:** matches/challenges appear in the Firewall dashboard traffic
  view; record the incident (start time, trigger, duration, who enabled) in the
  on-call log.

**Decision order during an incident** (least-disruptive first):
1. Confirm the per-path enforce rules (Component 3) are published and firing.
2. Tighten / temporarily enforce the broad mutating net (flip `…-log` →
   `rate_limit`, or lower the threshold) — see the flip section.
3. Block specific offending IPs/CIDRs:
   `vercel firewall ip-blocks block <ip|cidr> --notes "incident <id>" --yes`
   then `vercel firewall publish --yes`.
4. **Only if 1–3 can't keep up:** enable Attack Mode (challenges everyone
   unverified). Disable as soon as the flood subsides.

> Do **not** use `vercel firewall system-mitigations pause` — it removes Vercel's
> platform DDoS protection. It is blocked for agents and should be a last resort
> run by the owner with Vercel support in the loop.

---

## Quick verification

- ✅ `vercel firewall rules list --expand` — all four rules present; 3a/3b actions =
  `rate_limit` (enforce), 1a/1b rate-limit-action = `log`. (Verified live
  2026-06-09 post-publish; a 5th rule, 3c, was added 2026-08-27 — see next
  bullet — bringing the live count to 5 as of 2026-09-07.)
- ✅ `vercel firewall overview` — confirms what's live vs. staged, attack-mode
  state. (2026-06-09: Firewall Enabled, 4 active rules, Attack Mode Off; 3c's
  2026-08-27 addition brings it to 5 active rules — re-verified via CLI
  2026-09-07 ahead of #1187, see the next bullet.)
- 🟡 Dashboard traffic filtered by each `rule_…` id shows hits accruing once
  published. (Pending — needs real traffic; URLs above.)
- ✅ `api-options-volumetric-log` (#1187) — LIVE. Applied by the owner via CLI
  2026-09-08, id `rule_api_options_volumetric_log_kJJB6d`. Verified
  `vercel firewall rules list --expand` shows 6 active rules including this
  one (OPTIONS, `/api` prefix, per-IP, 100/10s, action `log`); `overview`
  reports `Custom Rules: 6 active, 0 inactive (6 total)`.

## State summary

| Rule | Path / method | Limit | Mode | Live where | Status |
|---|---|---|---|---|---|
| `signup-per-ip-enforce` | `POST /api/auth/signup` | 5 / 60s / IP → 429 | **ENFORCE** | prod + staging + preview | ✅ live (2026-06-09) |
| `onboarding-start-per-ip-enforce` | `POST /api/onboarding/start` | 10 / 60s / IP → 429 | **ENFORCE** | prod + staging + preview | ✅ live (2026-06-09) |
| `qr-redirect-per-ip-enforce` | `ANY /q/*` | 30 / 60s / IP → 429 | **ENFORCE** | prod + staging + preview | ✅ live (published + burst-verified 2026-08-27) |
| `api-mutating-volumetric-log` | `POST/PUT/DELETE /api/*` | 100 / 10s / IP | **LOG** | prod + staging + preview | ✅ live (2026-06-09) · 🟡 flip-to-enforce pending baseline |
| `api-get-volumetric-log` | `GET /api/*` | 600 / 10s / IP | **LOG** | prod + staging + preview | ✅ live (2026-06-09) · 🟡 flip-to-enforce pending baseline |
| `api-options-volumetric-log` | `OPTIONS /api/*` | 100 / 10s / IP | **LOG** | prod + staging + preview | ✅ live — applied by owner via CLI 2026-09-08 (#1187), id `rule_api_options_volumetric_log_kJJB6d` · 🟡 flip-to-enforce pending baseline |
| Attack Mode | all unverified visitors | challenge | **OFF** (break-glass) | — | ✅ verified Off (2026-06-09) |
