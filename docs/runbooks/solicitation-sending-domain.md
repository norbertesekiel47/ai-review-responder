# Solicitation Sending Domain — Resend domain, DNS, DMARC, warm-up

External-ops runbook for standing up the solicitation lane's **Sending identity**:
the `feedback.` sending domain, its DNS, its DMARC record, the `reviews@` mailbox,
and the warm-up ramp that follows. Every step is a Resend/Cloudflare console action
plus a Railway env var — **no code path in this repo executes any of it.**

> **Authored at #657, EXECUTED at #633.** Nothing here is run as part of #657.
> #657 shipped the machinery (the **Messaging adapter**, `EmailAdapter`, the
> `'solicitation'` header category, the fail-closed config, the **Solicitation
> lane** in the Resend ingress). #633 is the staging-flip-and-evidence ticket that
> actually performs these steps and records their output.

**Nothing in this runbook causes a send by itself.** As of #657 the Messaging
adapter has **zero production callers** — #630's dispatch worker is the first. A
fully configured domain with every env var set still sends nothing until #630
lands. That is deliberate: the identity is provable before anything can use it.

## Scope — two domains, run independently

| Environment | Sending domain | From address | Return-path |
|---|---|---|---|
| Production | `feedback.repworth.net` | `reviews@feedback.repworth.net` | `bounce.feedback.repworth.net` |
| Staging | `feedback.staging.repworth.net` | `reviews@feedback.staging.repworth.net` | `bounce.feedback.staging.repworth.net` |
| Local / preview | — none — | `MOCK_EXTERNAL_APIS=true`; solicitation sends are stubbed | — |

Two Resend domains, not one, because **the staging destination sends to real
inboxes**. Staging reputation is structurally sandboxed under the existing
`staging.repworth.net` delegation, so a staging list mistake can never touch
`feedback.repworth.net`.

**The consequence has to be planned for, not discovered:** `feedback.repworth.net`
inherits *nothing* from staging and arrives **cold at the prod flip**. Run this
whole document twice — once per domain — including a second, independent warm-up
ramp. Staging passing §6 is not evidence about prod.

Design of record: `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md`
(§1 domain, §2 identity, §3 warm-up, §8 DMARC, §9 config). Env behaviour:
`.claude/reference/env-vars.md`. Deploy topology and which platform holds which
var: `docs/runbooks/deployment-guide.md`.

**Order matters.** §1 → §2 → §3 must complete and verify before §4; §4 before §6;
§6 before stage 1 of §5. §7 says which env var is set at which of those points —
and the flag goes on **last**, because the boot assertion refuses a worker that
has sending enabled and no From address.

---

## 1. Create the Resend domain — with three non-default settings

```ts
await resend.domains.create({
  name: 'feedback.repworth.net',      // or feedback.staging.repworth.net
  customReturnPath: 'bounce',
  openTracking: false,                // Resend's default is TRUE
  clickTracking: false,
});
```

- **`openTracking: false` — must be set explicitly.** Resend defaults it to
  `true`. A tracking pixel is a privacy cost and a mild spam signal, and we do not
  consume `email.opened` at all: the Solicitation lane refuses that event
  (`worker/ingress/resend/solicitation-lane.ts`). Leaving the default on buys
  nothing and costs something.
- **`clickTracking: false` — non-negotiable.** Click tracking rewrites every URL
  through `links.<domain>`. That would rewrite **the Google review link**, so a
  recipient asked to review a business would see a redirect domain instead of
  `google.com`. Phishing-shaped, and it destroys the link's provenance — the one
  property that makes the ask credible.
- **Do not create the `links.` CNAME.** Its absence is the belt to
  `clickTracking: false`'s braces: if the flag is ever flipped back by accident,
  the rewrite has nowhere to resolve and fails loudly instead of silently
  reshaping every link.
- `customReturnPath: 'bounce'` puts the envelope sender on
  `bounce.feedback.<env>.repworth.net`. This is what makes §3's `aspf=r` mandatory
  — see there before touching the DMARC record.

Resend returns the exact DNS values at create time. Take them from that response;
the table in §2 is the *shape*, not the values.

---

## 2. Cloudflare DNS

DNS for `repworth.net` is on Cloudflare (`wally.ns.cloudflare.com`,
`zahir.ns.cloudflare.com`). All five record groups go there.

| Record | Name | Type | Value |
|---|---|---|---|
| SPF (return-path) | `bounce.feedback` | MX | `feedback-smtp.us-east-1.amazonses.com` (priority 10) |
| SPF (return-path) | `bounce.feedback` | TXT | `"v=spf1 include:amazonses.com ~all"` |
| DKIM | `resend._domainkey.feedback` | TXT | `p=<key>` — **one TXT record**, from the create response |
| DMARC | `_dmarc.feedback` | TXT | see §3 |
| Tracking | — | — | **deliberately absent** (§1) |

> Shape corrected at #633 (staging run, evidence D-3): Resend now returns a
> single `resend._domainkey` DKIM **TXT** record, not the historical three
> `<selector>.dkim.amazonses.com` CNAMEs this table showed. The create
> response stays authoritative either way.

For staging, every name gains the `staging` label (`bounce.feedback.staging`,
`<selector>._domainkey.feedback.staging`, `_dmarc.feedback.staging`).

> **Cloudflare proxy must be OFF — grey cloud — on every record above.** Proxying
> a CNAME breaks DKIM resolution **silently**: the domain still verifies in some
> views, mail still leaves, and receivers simply see `dkim=none`. There is no
> error to notice; the only symptom is the placement you were trying to protect.
> This is the single most likely way to get all of §1–§3 right and still fail §6.

---

## 3. DMARC — `p=reject` from day one, `aspf` relaxed

```
_dmarc.feedback.repworth.net  →  v=DMARC1; p=reject; adkim=s; aspf=r;
                                 rua=mailto:re+ywyu7bdater@dmarc.postmarkapp.com; pct=100
```

- **`aspf=r` must stay relaxed.** §1's custom return path makes the envelope
  sender `bounce.feedback.<env>.repworth.net`, which is **not** an exact match for
  the From domain. **`aspf=s` would fail SPF alignment on every single message.**
  This is the one place in the whole setup where reflexive strictness silently
  breaks sending, and it is worth knowing its signature: an
  `Authentication-Results` header showing **`spf=pass` together with
  `dmarc=fail`** is this trap and nothing else. If §6 produces that pair, come
  back here before touching anything upstream.
- **`adkim=s` is free.** Resend signs with `d=feedback.<env>.repworth.net`,
  exactly matching the From domain, so strict alignment costs nothing.
- **`p=reject` from day one — no `p=none` ramp.** The only reason to start
  permissive is to discover unknown legitimate senders. This subdomain is brand
  new with exactly one authorized sender; there are none to discover. A permissive
  window on the domain we are about to use for unsolicited commercial mail is the
  worst possible place to leave spoofable.
- **`rua` — RESOLVED 2026-08-17, no longer an open input.** Spec §12 recorded this
  as unresolved (a real address or a DMARC reporting vendor). The decision is
  **Postmark DMARC Digests**, free tier, digests delivered to
  `norbert.esekiel@repworth.net`. Postmark parses the gzipped XML nobody reads and
  emails a weekly summary; that readability is the whole reason a vendor beat a
  plain mailbox here, on a subdomain sending unsolicited commercial mail where
  alignment failures must be noticed early. Registered addresses:

  | Domain | `rua` |
  |---|---|
  | `feedback.repworth.net` | `re+ywyu7bdater@dmarc.postmarkapp.com` (in the record above) |
  | `repworth.net` (apex, separate concern) | `re+zidxljbfmt1@dmarc.postmarkapp.com` |

  The addresses **differ by design** — Postmark keys each digest to the domain it
  was registered for, so reusing the apex address here would fold solicitation
  reports into the wrong digest or drop them. (Authorisation is *not* the reason:
  Postmark publishes a wildcard `_report._dmarc` record, so reuse would pass
  RFC 7489 §7.1 verification and still give you the wrong report.)

  The apex previously reported to `dmarc_rua@onsecureserver.net` — GoDaddy's
  default, which is why we saw none of our own reports. It was replaced on
  2026-08-17. **Only its `rua` changed**; `p=quarantine`, `adkim=r` and `aspf=r`
  are untouched, because those govern how receivers treat approval emails
  (invariant #3). Retuning the apex *policy* is still follow-up FU-2.

  > **TRAP — do not paste Postmark's suggested record.** Its signup returns
  > `v=DMARC1; p=none; pct=100; rua=…; sp=none; aspf=r;`. **Take only the `rua`
  > value.** `p=none` and `sp=none` are wrong here for the reasons in the two
  > bullets above and below: a permissive window on this subdomain is precisely
  > what we refuse, and `sp=none` would hand any future sub-subdomain a
  > permissive policy by inheritance. `adkim=s` is absent from their suggestion
  > and we want it.

  Before creating the record, confirm the authorisation exists, or reports fail
  **silently** — no bounce, no error, just nothing:

  ```bash
  dig +short TXT feedback.repworth.net._report._dmarc.dmarc.postmarkapp.com
  # expect: "v=DMARC1;"
  ```

The explicit record on the subdomain **overrides** the apex's inherited policy and
insulates the solicitation domain from any future apex change. Leave the apex
alone — retuning it is spec follow-up FU-2 and touches the approval-email lane.

---

## 4. The `reviews@` mailbox — real, routed, not `no-reply@`

`reviews@feedback.<env>.repworth.net` **must accept and route mail.** A forward
to a monitored destination is sufficient — this needs a destination, not a
staffed desk. Use the org's actual mail provider: the apex runs on **Zoho**, so
the staging run (#633) added the subdomain to the Zoho org (auto-verified as a
child of verified `repworth.net`) with `reviews@`/`unsubscribe@` as user
aliases; Cloudflare Email Routing does not fit this zone (apex MX is Zoho's,
and subdomain routing is plan-gated).

Three reasons, and the third is the one that bites:

1. Gmail's bulk-sender guidance explicitly discourages unmonitored `no-reply`
   senders.
2. CAN-SPAM §7704(a)(3) wants a working opt-out. A recipient who hits **Reply**
   instead of the unsubscribe link must reach a human.
3. `Reply-To` points at the business owner (`businesses.owner_email`), so this
   mailbox only catches strays, auto-replies, and reply-based opt-outs — which is
   exactly why it is easy to forget it exists until one arrives.

**Setting up this mailbox creates a servicing obligation.** Anything arriving here
that reads as an opt-out must be entered into the **Suppression ledger** manually
within CAN-SPAM's **10 business days**. Nothing automates it: reply parsing is
spec follow-up FU-4 and is out of scope for v1. Use the admin suppression console
(`/admin/suppressions`) — an `admin_manual` entry — never a direct table write.

**Do not confuse this with the unsubscribe mailbox.** The address advertised in
`List-Unsubscribe` is `SOLICITATION_UNSUBSCRIBE_MAILTO`
(`unsubscribe@feedback.<env>.repworth.net`), a *second* mailbox on the same
domain with its own, tighter servicing ritual — daily on business days, per
`docs/runbooks/channels-rollout.md` §6. Two mailboxes, two obligations; standing
up one does not discharge the other.

---

## 5. Warm-up ramp — five stages, per domain

What is cold here is **domain reputation on the DKIM `d=` domain**, not IP
reputation: we are on Resend's shared IP pool, which is already warm. So there is
no 30-day IP ramp — the job is "send consistently, keep complaints near zero, do
not spike."

The operator raises `SOLICITATION_PLATFORM_DAILY_CAP` one stage at a time,
checking the health window **before** each step. Table is spec §3.3, unchanged:

| Stage | Ceiling | Dwell | Advance only if |
|---|---|---|---|
| 1 | 50/day | 3–4 days | hard bounce < 2% **and** complaints < 0.3% |
| 2 | 200/day | 3–4 days | same |
| 3 | 500/day | 3–4 days | same |
| 4 | 1,500/day | 3–4 days | same |
| 5 | 5,000/day | — | same |

- **Never advance on a breached window; roll back a stage on any breach.**
- **Same table, run independently for each of the two domains.** Staging's ramp
  teaches prod nothing (see Scope).
- The health window itself is rolling **7 days with a minimum of 100 sends** — do
  not read a rate off a handful of messages and act on it.
- The ceiling is an env var rather than a state machine on purpose: one
  authoritative owner for the number, reversible without a deploy, and it doubles
  as the emergency brake. **`0` is a legitimate resting value, not a
  misconfiguration** — an explicit `0` boots fine and admits no sends.
- The reputation circuit breaker (spec §3.2B, owned by #630) is the part a runbook
  genuinely cannot do — it has to fire at 3am, platform-wide, and it never
  self-clears. It pages through the existing `HealthAlertPoller` sink
  (`docs/runbooks/beta-launch-alerting.md`). This ramp is the deliberate,
  human-paced half; the breaker is the automatic half. Do not treat either as a
  substitute for the other.

---

## 6. Seed-inbox gate — before any real recipient

On a freshly verified domain the **first sends go to owner-controlled and seed
inboxes only**: Gmail, Outlook, Yahoo, and `reviews@` itself. This is the only way
to catch an auth misconfiguration before it costs reputation — after real
recipients see it, the damage is already in the receivers' models.

Open the raw source of each seed message and confirm all three, by eye, in
`Authentication-Results`:

```
Authentication-Results: ... spf=pass ... dkim=pass header.d=feedback.<env>.repworth.net ... dmarc=pass
```

- `spf=pass` **with** `dmarc=fail` is the §3 `aspf` trap — go back to §3.
- `dkim=none` or a `header.d` that is not the sending domain is the §2 grey-cloud
  trap — go back to §2.

Then confirm, per provider:

- inbox vs. spam **placement** for each of Gmail / Outlook / Yahoo;
- the footer renders — **Attested postal address**, unsubscribe line,
  identification line;
- the RFC 8058 header is present **and the one-click POST executes**. Not "the
  header is there" — actually trigger the client's unsubscribe and confirm the
  POST lands on `worker/ingress/unsubscribe.ts` and the **Suppression ledger** row
  appears. A header that is present but whose endpoint 404s is worse than no
  header;
- no URL in the body has been rewritten through a `links.` domain (§1). If one
  has, click tracking is on — stop and fix the domain settings before anything
  else.

Evidence from this gate is an input to #633's staging flip doc. Capture the raw
headers and the placement result per provider; "it looked fine" is not evidence.

---

## 7. Env vars, by stage

Full behaviour of each var — including its fail-closed contract — is
`.claude/reference/env-vars.md` (rows 105–107 were added by #657;
`SOLICITATION_UNSUBSCRIBE_MAILTO` is row 104, added by #644). **Every flip of any
of these follows the `flag-flip` skill.** All are server-only with no
`NEXT_PUBLIC_*` companion (invariant #13).

| When | Var | Value | Why then |
|---|---|---|---|
| After §1–§3 verify | *(none)* | — | Domain verification needs no app config. Setting keys before DNS passes just means the fail-closed errors are hiding a DNS problem. |
| After §4 | `SOLICITATION_UNSUBSCRIBE_MAILTO` | the `unsubscribe@` mailbox, **bare address, no `mailto:` prefix** | It is dual-lane — **Vercel + Railway, and the two values MUST be equal.** Setting it is what creates the §4 servicing obligation, so it comes after the mailbox exists, never before. |
| Before §6 | `SOLICITATION_RESEND_API_KEY` | the **domain-scoped** key, `sending_access` restricted to `feedback.<env>.repworth.net` | Deliberately **not** `RESEND_API_KEY`. A key leaked from this lane then cannot forge an approval email — invariants #3 and #5 reached sideways. Provision a new key; do not widen the transactional one. |
| Before §6 | `SOLICITATION_SEND_FROM_ADDRESS` | `reviews@feedback.<env>.repworth.net` | Address only — the display name is per-business (`"Joe's Diner" <reviews@…>`), built by `EmailAdapter`. |
| Before §6 | `SOLICITATION_PLATFORM_DAILY_CAP` | the smallest value that admits the seed list | The seed list is a handful of owner-controlled inboxes. **Do not jump to stage 1's 50/day here** — stage 1 begins only once §6 has passed. |
| Last, before §6 sends | `SOLICITATION_SEND_ENABLED` | `true` | **Order is enforced by the worker.** `assertSolicitationSendEnv` requires all four vars above when this flag is on, so flipping it first fails boot. That is the intended failure — a worker that boots with sending enabled and no From address would fail at dispatch time instead. |
| §5, one stage at a time | `SOLICITATION_PLATFORM_DAILY_CAP` | 50 → 200 → 500 → 1,500 → 5,000 | The ramp dial and the emergency brake are the same var. Roll it *down* on any breach. |

Two ordering facts worth stating plainly:

- **Railway restarts the worker on any env change**, which is what makes an
  unset-the-key rollback actually take effect — the Resend clients are cached
  per-process, so without the restart a key change would not be observed.
- **`SOLICITATION_SEND_ENABLED` masters *sending* only** (glossary rule DR1). The
  **Solicitation lane** in the Resend ingress, the unsubscribe ingress, and the
  `/u/<token>` landing page stay fully live when it is off. Turning the flag off
  is not a way to quiet the webhook, and the lane must never grow a flag gate.

---

## 8. Reputation circuit breaker

The automatic half of deliverability protection. §5's ramp is the deliberate,
human-paced half; this is the part that has to fire at 3am, platform-wide, and it
**never self-clears**. Shipped at #898 — `src/lib/solicitation/send-breaker.ts`
plus migration 110's `solicitation_send_breaker` latch table. The release-side
consumer that actually refuses to send while a trip is open is **#900**; until it
lands the breaker trips, pages and can be reset, but nothing reads it on the send
path.

The asset being protected is the **Sending identity** (§1–§4), which is one
mailbox and one sending domain shared by every account. That is why the breaker
is a platform singleton and not a per-tenant dial: one account's bad list burns
the deliverability every other account sends on. It is **not** the **Halt latch**
— that stops one batch.

### 8.1 The read model — one window, two thresholds

`evaluateSendBreaker` computes one **Breaker window** per `HealthAlertPoller`
tick, as a single pass over `solicitation_outreach`:

| Figure | Basis | Trips when |
|---|---|---|
| sends (denominator) | `sent_at` inside the last **7 days** | — |
| hard bounces | `bounce_kind = 'hard'`, `bounced_at` inside the window | rate **> 2%** |
| complaints | `complained_at` inside the window | rate **> 0.3%** |
| minimum volume | — | **< 100 sends never trips** |

These are the same two rates §5's ramp advances on, and the same 7-day/100-send
health window §5 already describes — read them there, they are not restated here.
The difference is only who checks: a human before each ramp stage, the breaker
continuously. Never re-tune one side without the other.

Three properties that surprise people:

- **The window is not a cohort.** The denominator is send-dated, the numerators
  are signal-dated. A burst of bounces from a send nine days ago still trips it,
  and the ratio can exceed 1.0 in a pathological burst. That is a trip, not a
  bug — the intuitive cohort measure dilutes a fresh bad batch with sends whose
  bounces have not landed yet, which is the fail-*open* direction.
- **Hard bounces are read from `bounce_kind`, never by parsing `provider_error`.**
- **Breach precedence is fixed**: volume floor → hard bounce → complaint. When
  both rates breach in the same window the page names the hard-bounce rate,
  because that is the one to fix first.

### 8.2 What a trip looks like

The `HealthAlertPoller` is the breaker's **only** tripper — nothing else writes a
trip. It emits one `error` finding through the §1 Sentry → Discord sink of
`docs/runbooks/beta-launch-alerting.md`:

```
tags.subsystem=health_alert
tags.finding=solicitation_send_breaker_tripped
```

- **Title** — `Solicitation sending halted — hard bounce rate 3.10% over 420
  sends in 7 days exceeds 2.00%` (or the complaint-rate wording).
- **Detail is aggregate-only** — counts, rates, thresholds, `min_sends`,
  `window_days`, `trip_reason`. Never a recipient address, subject or body: this
  finding leaves the platform through an alert sink.
- **It re-pages on every tick while the trip stays open — level-triggered, not
  an alerting bug.** The trip *insert* is still a no-op on a second breached tick
  (it conflicts on the one-open-trip partial index), but the poller probes for an
  open trip **first** and returns a finding whenever one stands, so events keep
  arriving for as long as sending is halted. The re-page carries a different but
  deliberately **constant** title — `Solicitation sending is STILL halted — the
  <reason> breaker trip is open and has not been reset` — under the same
  `tags.finding` routing key, so Sentry collapses the repeats into one issue that
  keeps receiving events instead of opening a fresh one every five minutes.
  **An open breaker is a STATE, not an event**, which is the whole reason this is
  level-triggered: one dropped page must never equal a silent platform-wide halt,
  so the condition is re-asserted until an operator resets it. A stream of repeats
  reads "still halted", never "paging is broken".
- **The re-page needs its own routing rule, and the code half alone does not
  deliver it (#907).** `beta-launch-alerting.md` §1a-do **rule 5** keys on
  `tags.finding = solicitation_send_breaker_tripped` with an event-FREQUENCY
  trigger. The §1 blanket `subsystem:health_alert` rule (rule 1) fires on *first
  seen*, so it delivers the opening page and nothing after it — two constant
  titles, two notifications, then silence for as long as the halt lasts. Rule 1
  gives the latency, rule 5 gives the repeat. If rule 5 is not configured in
  Sentry, treat every re-page above as written but undelivered.

**Trip latency is bounded by one `HEALTH_ALERT_POLL_INTERVAL_MS`** (default
300000 ms = 5 min; row in `beta-launch-alerting.md` §5). That bound is the price
of keeping the expensive 7-day aggregate off the send loop — #900's read is a
cheap indexed existence probe, not this query.

**A trip is not a pause, and it is not free — read §8.5 before you start
diagnosing.** Every hour the breaker stays open converts more already-approved
batches into cancelled ones, platform-wide.

### 8.3 Diagnosis — in this order

1. **Read the window figures off the page.** `sends`, `hard_bounces`,
   `complaints`, and the two rates are all in the finding detail; you do not need
   a DB session to know which threshold broke and by how much. `/admin/solicitation`
   shows the same `metrics` snapshot, frozen at the instant of the trip.
2. **Find what changed.** A hard-bounce spike is a list-quality problem (a stale
   or unverified contact import); a complaint spike is a content, cadence or
   consent problem. A rate that exceeds 1.0 means the bounces belong to sends
   older than the window — look at what was sent 8–14 days ago, not at today.
3. **Roll `SOLICITATION_PLATFORM_DAILY_CAP` down one stage** per the §5 ramp
   table, following the `flag-flip` skill. Do this *before* resetting, and the
   reason is the shape of what a reset starts: the reset moves the measurement
   window's lower edge to the reset instant, so the breaker is deliberately quiet
   until 100 fresh sends have accumulated (§8.4). The ceiling is what governs how
   much mail goes out inside that quiet period. Railway restarts the worker on
   the change (§7).
4. **Only then reset** (§8.4). Resetting with the ceiling untouched does not
   re-trip on the next tick — it spends the whole 100-send probe at the volume
   that just breached.
5. **Never advance a ramp stage on a window that tripped**, even after a reset —
   §5's advance rule is unchanged by the reset.

### 8.4 Reset — `/admin/solicitation`

The only thing that clears a trip. There is no timeout, no self-clear and no
automatic reset: a breach is a fact someone has to look at.

- Sign in as an admin with **AAL2** (the page and the route both gate on it) and
  open **Safety → Solicitation send breaker** in the admin nav. The page is an
  **Island**-system surface.
- The panel shows the open trip: when it tripped, the reason, and the frozen
  window snapshot.
- **A reset note is mandatory** — enforced both by the route's schema (blank ⇒
  400) and by migration 110's `reset_consistency` CHECK, so "who cleared this,
  and why" cannot be unanswerable by omission. Write what you changed, not "ok".
- The actor is taken from the admin session, never from the request body.
- Resetting when nothing is open returns **409 `not_tripped`**; that is the
  expected answer to a double-submit, not an error to chase.

**A reset is a real recovery, not a gesture — and it does NOT re-trip on the next
poller tick.** `readBreakerWindow` bounds every counter at
`GREATEST(NOW() - 7 days, MAX(reset_at))`, so the reset moves the window's lower
edge to the reset instant and only **post-reset** activity is ever measured
again. Immediately after a reset the window is empty, `BREAKER_MIN_SENDS` holds
the breaker quiet until **100 fresh sends** accumulate, and the very next
`evaluateSendBreaker` returns nothing. That silence is the expected answer;
reading it as "the window recovered on its own" is the error this section exists
to prevent.

**What the reset actually buys you is a bounded half-open probe** — roughly 100
sends of un-governed volume, measured honestly, after which the breaker judges
the *new* window and trips again if the list is still bad. That is why §8.3 puts
the ceiling roll-down **before** the reset: the ceiling is the only thing bounding
how much mail leaves during the probe. It is not a blind re-arm, and it is not a
free look either — an operator who resets "just to check whether the breach still
stands" has not checked anything, they have **zeroed the measurement** and started
the probe.

**Pre-reset bounces that land late no longer count, and that exclusion IS the
fix.** A bounce for a send made before the reset, arriving after it, falls outside
the new lower edge and is dropped from the numerator. Before this bound the
breaker measured a history no operator action could change, so a reset re-tripped
within one poll interval every time and recovery was arithmetically unreachable.
Excluding the pre-reset tail is what makes the reset mean something.

If you need sending stopped while you work, the honest control is
`SOLICITATION_PLATFORM_DAILY_CAP=0` or `SOLICITATION_SEND_ENABLED=false` (§7), not
the latch — and note that with the reset now bounding the window, repeatedly
clearing the latch is worse than useless: each reset restarts the 100-send quiet
period.

### 8.5 What a trip costs the batches already in flight

**Read this before you reset, not after.** A trip is not a pause. The breaker and
the send window run on different clocks, and nothing reconciles them:
`BATCH_SEND_WINDOW_HOURS = 72` (`src/lib/solicitation/outreach.ts`) is anchored on
`approved_at` and keeps running while the breaker is open, but a real trip stays
open for **days** — as long as it takes a human to diagnose, roll the ceiling
down and reset.

So the blast radius of one trip is **every batch approved in the 72 hours before
it, across every account on the platform**. Those batches stop being released,
their windows elapse under the halt, and #900's expiry sweep terminalizes them
`cancelled`: every remaining ask dead.

**Since #917 the reason on those cancellations is `platform_halt`, not
`send_window_elapsed`** — the sweep reads the breaker once per tick and picks the
reason that is true. The owner is told RepWorth paused sending platform-wide and
that this was not about their list; the admin batch panel labels it "Send window
elapsed under a platform halt". **The cost is unchanged** — the same batches, the
same 72h clock, the same cancellations — so everything below still applies. Only
the story an owner is told has stopped being false. A cancellation from a tick
where the breaker probe itself failed reads `send_window_elapsed`, deliberately:
the fallback never claims a platform halt it could not establish.

**That is a deliberate trade, recorded in amendment B14** of
`docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md`. The
alternative — suspending expiry while the breaker is open — is worse, not better:
those batches then run past the "≤10 days by construction" bound that
`STALLED_THRESHOLD_SEND_BATCH_DAYS = 11` is derived from, and
`solicitation_send_batch_stalled` fires for every one of them, burying the trip
you are actually working under an alert storm. A cancelled batch is an honest
terminal state an owner can act on; a stalled run is not.

Practical consequences for the operator:

- **Time is the cost.** Every hour the trip stays open converts more approved
  batches into cancelled ones. Diagnose (§8.3) with that clock running.
- **Tell the affected owners anyway (#917 changed what they read, not whether
  they need to hear from you).** They now see an honest `platform_halt` message
  saying RepWorth paused sending for everyone and that it was not about their
  list, with an invitation to get in touch. That removes the falsehood; it does
  not remove the loss, and the owner still cannot resume the batch. Reach out to
  the accounts whose batches this trip cancelled.
- **Rebuilding is not free.** A cancelled batch leaves its asks `status='send'`,
  so `MIN_GAP_DAYS` withholds those contacts as `over_contacted` on any rebuild
  inside 30 days (ADR 0020 § "Cost, as verified"). Advise owners to wait rather
  than immediately rebuild.
- **This is why §8.3 step 3 comes before step 4.** A reset does not re-trip on
  the next tick — it opens a ~100-send half-open probe (§8.4) — so the ceiling is
  the only thing bounding how much mail goes out while the breaker is quiet.
  Reset with the ceiling untouched and the probe runs at the volume that just
  breached; if it breaches again, the new trip restarts this clock on a fresh 72
  hours of approvals.
