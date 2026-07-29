# Sender Identity + Deliverability — LOCKED SPEC (#622)

> **AMENDED 2026-07-28 — read `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` first.** Amended
> here: §7.1's idempotency key → **outreach row id** (attempt grain, not
> `ask_id`); §7.4 subject rules fold into #623's lint table (80-char max wins);
> §11's #624 binding → fields live on `solicitation_outreach`, not
> `solicitation_asks`; D4's cap number (10) stands but resolves through
> `auto_approval_policies` + LEAST, not a twin resolver (B3).

> **Status:** Locked 2026-07-28 via grilling session. Resolves wayfinder ticket **#622**
> (part of map **#617**, Solicitation SEND-MODE Phase 2b, design doc §9.3).
> **Implements map decision 6.** Binding compliance reference: `docs/research/2026-07-23-solicitation-policy-constraints.md`
> (#531) — this spec cites its §2 (CAN-SPAM) and §5 rows 5–6 rather than re-deriving them.
>
> **Consumes:** nothing. **Feeds:** #627 (email adapter + sending domain — the primary
> implementation ticket), #626 (suppression + unsubscribe ingress), #630 (dispatch/drip
> worker), #628 (ask generation — subject lint), #633 (staging flip evidence).
>
> This is engineering research and product spec, **not legal advice.** Counsel gates the
> PROD flip only (map decision 5), never the staging destination.

---

## 0. Decision register

Ten decisions, each locked in the #622 grilling session. Everything below is derivation.

| # | Decision | Locked value |
|---|---|---|
| D1 | Sending domain | `feedback.repworth.net` (prod) · `feedback.staging.repworth.net` (staging) · custom return-path `bounce` on both |
| D2 | Sender identity | One shared mailbox `reviews@feedback.<...>` for every account; per-account distinction via From display name, Reply-To, Resend tags |
| D3 | Warm-up | Env ceiling + health circuit breaker in **code**; ramp table in **runbook**; seed-inbox gate before first real recipient |
| D4 | Per-account daily cap | **10/day**, account-level, UTC day, counted on dispatch attempts, nullable per-account override |
| D5 | Webhooks | Tag-discriminated routing (`lane=solicitation`); 7 events subscribed; `opened`/`clicked` refused; open + click tracking OFF |
| D6 | Suppression scope | **Global** on normalized email address for permanent bounce, complaint, and unsubscribe. Never pushed to Resend's team-wide list |
| D7 | Postal address | Owner-attested `businesses.solicitation_postal_address`; enforced at batch-build, render, and dispatch (byte-match) |
| D8 | Unsubscribe | Split URLs — Railway worker ingress for the RFC 8058 POST, Vercel for the human landing page |
| D9 | From line | Business name only; identification line in the body footer; `owner_email_bounced = TRUE` blocks batch build |
| D10 | DMARC | `p=reject; adkim=s; aspf=r` with an `rua` we control, from day one |

---

## 1. Sending domain (D1)

### 1.1 Domains

| Environment | Sending domain | From address | Return-path |
|---|---|---|---|
| Production | `feedback.repworth.net` | `reviews@feedback.repworth.net` | `bounce.feedback.repworth.net` |
| Staging | `feedback.staging.repworth.net` | `reviews@feedback.staging.repworth.net` | `bounce.feedback.staging.repworth.net` |
| Local / preview | — no sending domain — | `MOCK_EXTERNAL_APIS=true`; solicitation sends are stubbed | — |

Two Resend domains, not one. **The staging destination sends to real inboxes**, so staging
reputation must be structurally sandboxed under the existing `staging.repworth.net`
delegation. A staging list mistake can then never touch `feedback.repworth.net`.

**Consequence, and it must be planned for:** `feedback.repworth.net` inherits *nothing*
from staging and arrives **cold at the prod flip**. The prod bring-up (design doc §8.4)
owns a second, independent warm-up ramp (§3).

### 1.2 Isolation is real but not absolute — stated honestly

Verified via DNS on 2026-07-28: **transactional Resend is verified on the apex
`repworth.net`** (`send.repworth.net` carries `v=spf1 include:amazonses.com ~all`,
MX `feedback-smtp.us-east-1.amazonses.com`, region `us-east-1`).

So `feedback.repworth.net` is a **child of the transactional domain, not a sibling.**
Mailbox providers carry primary reputation at the subdomain level but some weight at the
organizational-domain level. Isolation is therefore strong — not total.

Symmetric isolation would require moving transactional onto its own subdomain
(`notify.repworth.net`) so neither domain is the other's parent. **That is a change to the
approval-email lane — invariant #3 blast radius — and is deliberately out of scope here.**
Recorded as follow-up FU-1 (§10).

### 1.3 Naming risk

`feedback.` sits one semantic step from the "private feedback funnel" that constraints
§5 row 1 identifies as review gating. **The domain is not gating — only copy is.** But the
#623 content lint MUST treat any pairing of this domain with private-feedback diversion
phrasing ("tell us privately instead", "if you're not happy, reply to us") as a hard
fail. Recorded as a binding constraint handed to #623.

### 1.4 Resend domain configuration

Created via `resend.domains.create()` with **non-default** settings:

```ts
await resend.domains.create({
  name: 'feedback.repworth.net',
  customReturnPath: 'bounce',
  openTracking: false,     // Resend's default is TRUE — must be set explicitly
  clickTracking: false,
});
```

- **`openTracking: false`** — Resend defaults this to `true`. A tracking pixel is a
  privacy cost and a mild spam signal, and we do not consume `email.opened` (D5).
- **`clickTracking: false`** — **non-negotiable.** Click tracking rewrites every URL
  through `links.<domain>`. That would rewrite **the Google review link** — recipients
  would see a redirect domain instead of `google.com` on a message asking them to review.
  Phishing-shaped, and it destroys the link's provenance.
- **Do not create the `links.` CNAME.** Its absence is the belt to `clickTracking: false`'s
  braces.

### 1.5 DNS records (Cloudflare)

DNS for `repworth.net` is on Cloudflare (`wally.ns.cloudflare.com`, `zahir.ns.cloudflare.com`).
All records below go there. Resend returns exact values at domain-create; the shapes are:

| Record | Name | Type | Value |
|---|---|---|---|
| SPF (return-path) | `bounce.feedback` | MX | `feedback-smtp.us-east-1.amazonses.com` (prio 10) |
| SPF (return-path) | `bounce.feedback` | TXT | `"v=spf1 include:amazonses.com ~all"` |
| DKIM ×3 | `<selector>._domainkey.feedback` | CNAME | `<selector>.dkim.amazonses.com.` |
| DMARC | `_dmarc.feedback` | TXT | see §8 |
| Tracking | — | — | **deliberately absent** (§1.4) |

> **Cloudflare proxy must be OFF (grey cloud) for every record above.** Proxying a CNAME
> breaks DKIM resolution silently.

### 1.6 API key scoping — un-grilled addition, flag if unwanted

**Recommendation carried into this spec without a separate grilling round:** provision a
**separate, domain-scoped Resend API key** (`sending_access` restricted to
`feedback.<env>.repworth.net`) rather than reusing `RESEND_API_KEY`.

Rationale: the solicitation dispatch worker then *cannot* send transactional mail. A key
leaked from the solicitation lane cannot forge an approval email — which would otherwise
be a direct path around invariant #3 and invariant #5. Costs one env var.

Env var: `SOLICITATION_RESEND_API_KEY`. Fail-closed — unset ⇒ no solicitation sends
(§9). The transactional `RESEND_API_KEY` is untouched.

---

## 2. Sender identity (D2, D9)

### 2.1 One shared mailbox

Every ask from every account is sent from **`reviews@feedback.repworth.net`**.

Per-account local-parts (`joes-diner@feedback.repworth.net`) were rejected. What they
would have bought, against what already covers it:

| Claimed benefit | Actually covered by |
|---|---|
| Deliverability isolation between accounts | **Not real.** Mailbox providers reputation-track domain + sending IP, not local-part. We are on Resend's shared IP pool. |
| Reply routing to the right owner | `Reply-To: owner_email` |
| Per-account suppression scoping | Our suppression ledger (#621/#626), `account_id` recorded |
| Per-account analytics / debugging | Resend tags (§5.2) |

And what they would have cost: an unbounded, enumerable mailbox surface on a domain we
must keep pristine; **varying local-parts on one shared domain is a classic snowshoe-spam
heuristic** — the worst possible signal for a cold domain; a name-collision problem; and a
PII leak (business name in every envelope, visible in team-wide Resend logs).

### 2.2 The mailbox is real and monitored — not `no-reply@`

`reviews@feedback.repworth.net` must accept and route mail (Cloudflare Email Routing
forward is sufficient).

- Gmail's bulk-sender guidance explicitly discourages unmonitored `no-reply` senders.
- CAN-SPAM §7704(a)(3) wants a working opt-out. A recipient who hits **Reply** instead of
  the unsubscribe link must reach a human.
- `Reply-To` points at the owner, so this mailbox only catches strays, auto-replies, and
  reply-based opt-outs. It needs a destination, not a staffed desk.

**Reply-based opt-outs are an operational obligation, not an automated path.** Anything
arriving at this mailbox that reads as an opt-out must be entered into the suppression
ledger manually within CAN-SPAM's **10 business days**. Recorded as follow-up FU-4 (§10)
— automating it is out of scope for v1.

### 2.3 From line

```
From: "Joe's Diner" <reviews@feedback.repworth.net>
```

Display name is the business name (map decision 6, locked). **No `via RepWorth` suffix.**

Because DKIM `d=feedback.repworth.net` aligns with the From domain, **Gmail will not
auto-append its "via" annotation** — the line renders as purely the business.

CAN-SPAM §7704(a)(1) forbids header info "materially false or misleading as to the
origin." The address truthfully identifies the transmitter, so this is defensible — but
*defensible*, not airtight, on an unsolicited commercial message. The identification is
therefore made explicit in the **body footer** instead of the From line (§7.2), which also
discharges the ad-identity requirement (constraints §5 row 6) in the same block.

### 2.4 Reply-To, and the bounced-owner precondition

```
Reply-To: <businesses.owner_email>
```

**`businesses.owner_email_bounced = TRUE` is a batch-build precondition failure.**

Pointing a customer's reply at a known-dead mailbox means a customer who replies "please
remove me" gets a bounce and we never hear it — a §7704(a)(4) opt-out request that fails
silently. If the owner cannot receive replies, we do not send asks on their behalf.

Reuses state the platform already maintains (`worker/ingress/resend.ts` sets this flag on
hard bounces to owner-directed templates). Same enforcement class as the missing postal
address (§6.3).

---

## 3. Warm-up (D3)

### 3.1 What is actually cold

**We are on Resend's shared IP pool.** IP reputation belongs to Resend and is already
warm. What is cold is **domain reputation** on the DKIM `d=` domain — a materially easier
warm-up: no 30-day IP ramp, mostly "send consistently, keep complaints near zero, do not
spike."

A dedicated IP was rejected: it requires a genuine 4–6 week ramp at volumes we do not
have, and **a low-volume dedicated IP deliverability-performs worse than a warm shared
pool** (providers read sporadic volume from a dedicated IP as suspicious).

Volume reality check: `BATCH_CAP = 25`, `MIN_GAP_DAYS = 30`, beta-sized account list ⇒
**tens of emails per day.** Gmail's bulk-sender rules do not engage below 5,000/day to
Gmail. The natural send rate *is* the ramp. A stage-machine warm-up scheduler would be
anticipatory abstraction (repworth.md: no abstraction ahead of the second concrete use).

### 3.2 In code — load-bearing, cannot be a human

**A. Platform-wide daily ceiling.** `SOLICITATION_PLATFORM_DAILY_CAP`, across all
accounts. **Fail-closed: unset or unparseable ⇒ 0 ⇒ no sends.** This is the blast-radius
bound for a bug or a runaway fan-out, and it is the dial the ramp turns.

**B. Reputation circuit breaker.** Halts **all** solicitation sending when the rolling
health window breaches:

| Metric | Threshold | Source |
|---|---|---|
| Hard-bounce rate | **> 2%** | `email.bounced` with `bounce.type = 'Permanent'` |
| Complaint rate | **> 0.3%** | `email.complained` — Gmail's stated bar; industry target is < 0.1% |

- Window: **rolling 7 days, minimum 100 sends** — small-N noise must not trip it.
- Scope: **platform-wide halt**, not per-account. The asset being protected is the shared
  domain.
- **Requires explicit admin reset.** Never self-clears — a breach is a fact someone must
  look at.
- Pages through the existing `HealthAlertPoller` sink (`docs/runbooks/beta-launch-alerting.md`).

This is the piece a runbook genuinely cannot do: it has to fire at 3am.

**Per production.md:** the breaker is a governor on expensive/damaging behavior, and a
Redis/DB outage in the breaker's own read path must degrade to **halt**, not to
"unmeasured therefore send" — fail-closed, matching the replica-cardinality precedent's
inverse (that one fails *open* because a worker that won't start is worse; here a send
that shouldn't happen is worse).

### 3.3 In a runbook — not code

The ramp table itself lives in `docs/runbooks/` (new: solicitation send-mode rollout).
The operator raises `SOLICITATION_PLATFORM_DAILY_CAP` per stage, checking health before
each step:

| Stage | Ceiling | Dwell | Advance only if |
|---|---|---|---|
| 1 | 50/day | 3–4 days | hard bounce < 2% **and** complaints < 0.3% |
| 2 | 200/day | 3–4 days | same |
| 3 | 500/day | 3–4 days | same |
| 4 | 1,500/day | 3–4 days | same |
| 5 | 5,000/day | — | same |

Never advance on a breached window; roll back a stage on any breach. **Same table, run
independently for each of the two domains** (§1.1).

Rationale for cap-as-env rather than a state machine: one authoritative owner for the
ceiling, reversible without a deploy, and it doubles as the emergency brake.

### 3.4 Seed-inbox gate — before any real recipient

On a freshly verified domain, the **first sends go to owner-controlled and seed inboxes
only**: Gmail, Outlook, Yahoo, and `reviews@` itself.

Proves, before a single customer sees anything:
- SPF / DKIM / DMARC alignment actually passes (check `Authentication-Results`)
- inbox vs. spam placement per provider
- footer renders — postal address, unsubscribe link, identification line
- the RFC 8058 header is present and the one-click POST executes (§7.3)

This is the only way to catch an auth misconfiguration before it costs reputation.
Evidence from this gate is an input to #633's staging flip doc.

---

## 4. Per-account daily cap (D4)

### 4.1 Value and shape

**`DEFAULT_SOLICITATION_ACCOUNT_DAILY_CAP = 10`.**

Deliberately the same number as the existing `DEFAULT_DAILY_AUTO_POST_CAP = 10`
(`src/lib/auto-approval/policy.ts`) — one platform-wide notion of "daily autonomy budget
per account." **Separately owned constants that may diverge; coinciding by design today,
not derived from one another.**

### 4.2 Why 10 and not 25

The cap must be **binding on a single batch**, not merely on a second one.

If the cap were 25 (= `BATCH_CAP`), a full approved batch could dispatch entirely within
one calendar day. The cap would only bite on a *second* batch, which makes the "drip"
purely a function of the dispatch worker's pacing — and a bug in that pacing sends 25 asks
in a burst. That is exactly the blast constraints §5 row 5 warns about.

At 10, a 25-ask batch is **structurally forced across ≥3 calendar days**. The velocity
story becomes true by construction rather than by the drip worker behaving, and a pacing
bug is bounded to 10. *A bound a single legitimate operation cannot reach is not bounding
anything.*

### 4.3 Mechanics

- **Account-level only.** Matches map decision 6's wording; `businesses` rows within an
  account share the account's reputation exposure anyway. The per-location dimension is
  deferred (the auto-approval policy's `set_location_cap` shape is the template if it is
  ever needed).
- **UTC day boundary**, mirroring `worker/jobs/response-generation/auto-approval.ts`:
  `created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`.
- **Counted on dispatch attempts, not successes.** A bounce still consumed reputation.
- **Nullable per-account override** resolved through a `resolveSolicitationDailyCap()`
  twin of the existing `resolveDailyCap()`, so an admin can raise it without a deploy.
- Enforced in the dispatch worker (#630), *after* the platform ceiling (§3.2A) and the
  circuit breaker (§3.2B). Order: breaker → platform ceiling → account cap → per-child
  gates.

---

## 5. Webhook ingest (D5)

### 5.1 Routing — tag-discriminated

`notification_deliveries` is **exclusively an owner/admin-notification table.** Every
writer is an owner-notice worker (`OwnerEmailWorker`, `escalation-notice`,
`auto-post-notice`, `pending-post-notice`, `notification/dispatch`), and it carries
claim-before-send partial-unique indexes built for owner-directed dedup. **Customer-contact
asks must not be written into it.** They live on the `solicitation_asks` row (#624's spine).

`worker/ingress/resend.ts` therefore gains a second resolution path, selected **before any
DB lookup** by the echoed Resend tag:

```
data.tags.lane === 'solicitation'  → solicitation_asks path        (new)
otherwise                          → notification_deliveries path  (existing, untouched)
unmatched email_id in either        → structured warn, ack 200
```

Chosen over a "try table A, fall back to table B" chain, which couples the two lanes in
one code path and makes a genuinely-unknown `email_id` indistinguishable from a lane
mismatch. The existing owner-notification path stays **byte-for-byte unchanged**
(orthogonality, design.md).

**Existing safety that we lean on rather than duplicate:** `isOwnerDirectedTemplate()` is
an **allowlist**, so even if an ask somehow reached the notification path, it could never
flip `businesses.owner_email_bounced`. No new guard is added — adding one would be a
second owner of the same fact.

Signature verification, `claimInboundEvent` idempotency, the 503-on-failure retry
contract, and the stale-`svix-timestamp` replay window are all **unchanged and reused**.

### 5.2 Tags emitted at send time

```ts
tags: [
  { name: 'lane',        value: 'solicitation' },  // the routing discriminant
  { name: 'account_id',  value: accountId },
  { name: 'business_id', value: businessId },
  { name: 'batch_id',    value: batchId },
]
```

`category: 'solicitation'` is emitted too, via the existing `getEmailTags()` shape.

> Resend tag values are constrained to ASCII letters, digits, `_`, `-`. UUIDs are fine.

### 5.3 Event set — subscribe to 7, refuse 2

| Event | Sub | Effect on the ask row / ledger |
|---|---|---|
| `email.sent` | ✅ | `sent_at` — handed to Resend |
| `email.delivered` | ✅ | `delivered_at` |
| `email.bounced` | ✅ | `bounce.type = 'Permanent'` → **permanent suppression** (§6). `'Temporary'` → soft: record, no suppression, counts toward the health window |
| `email.complained` | ✅ | **permanent suppression** + the numerator of the 0.3% breaker |
| `email.delivery_delayed` | ✅ | observability only — **never** suppression |
| `email.failed` | ✅ | send-side failure; record `failed.reason` (e.g. `reached_daily_quota`) → retry classification. No suppression |
| `email.suppressed` | ✅ | Resend suppressed it independently → mirror into our ledger **and** log loudly: it means Resend's team-wide list is diverging from ours (§6.2) |
| `email.opened` | ❌ | needs a tracking pixel: privacy cost, mild spam signal, buys nothing we consume |
| `email.clicked` | ❌ | **hard refusal** — see §1.4. Would rewrite the Google review link |
| `email.scheduled` | ❌ | we do not use Resend scheduling; the drip is ours (#630) |
| `email.received` | ❌ | inbound, not this lane |

**Bounce classification reuse:** the existing `extractBounceType()` /
`isHardBounceType()` / `classifyBounce()` helpers in `worker/ingress/resend.ts` already
normalize to `bounced:hard:<raw>` / `bounced:soft:<raw>` and defensively handle three
payload shapes. **Reuse them verbatim** — a second classifier would be a second owner of
"what counts as permanent." (Note: `'unknown'` classifies as *soft*, which is the correct
fail-safe direction here too — an ambiguous bounce must not permanently suppress a real
customer.)

---

## 6. Suppression (D6)

> The ledger itself is **#621's spec and #626's build.** This section states the
> deliverability constraints that ledger must satisfy, which #622 owns.

### 6.1 Global scope, keyed on normalized email address

**Permanent bounce, complaint, and unsubscribe all suppress platform-wide.** The
originating `account_id` is recorded for audit but is **not part of the key.** Soft /
temporary bounces never suppress.

This falls directly out of D2. We chose one shared sender identity — every ask from every
account arrives from `reviews@feedback.repworth.net`. **From the recipient's inbox there
is exactly one sender.** A person who reports Joe's Diner's ask as spam has reported *that
address*; if Sally's Salon then mails them from the same address, the recipient cannot
tell it is a different business, and Gmail scores the second complaint against the same
domain. Account-scoped suppression would let us mail someone who already told that
identity to stop — a reputation own-goal and indefensible on the merits.

**Normalization:** lowercase, trim. Do **not** strip Gmail dots or `+tags` — over-
normalizing merges distinct real mailboxes and would suppress people who never asked.

### 6.2 Never push to Resend's suppression API

Resend's suppression list is **team-wide across every domain and API key — including
transactional.**

If a customer contact happens to be an owner's address (an owner who is also someone's
customer; two accounts sharing a shared mailbox), pushing that suppression would silently
stop **approval emails** from reaching them. That is an **invariant #3 hazard reached
sideways**: a response never gets approved because the approval link was never delivered,
and nothing errors.

Our ledger stays authoritative. We only **ingest** `email.suppressed` as a divergence
signal (§5.3) — and if Resend has independently suppressed an address we believe is
sendable, that is a log-loud condition worth an admin's attention.

### 6.3 Global unsubscribe is over-compliant, deliberately — and must be said out loud

CAN-SPAM's opt-out attaches **per-sender**, and arguably Sally's Salon is a different
sender from Joe's Diner. Applying an unsubscribe globally suppresses more than the statute
strictly requires.

That is the safe direction and the one consistent with the shared identity. **But it is a
product consequence the owner must be told honestly:** an unsubscribe permanently removes
that contact from *every* RepWorth account's reach. The owner-facing UI must say so
plainly — not show the contact as merely "skipped." Handed to #626 as a copy requirement.

---

## 7. Envelope, headers, and body (D7, D8, D9)

### 7.1 Full envelope

```
From:                     "Joe's Diner" <reviews@feedback.repworth.net>
Reply-To:                 <owner_email>
To:                       <one recipient, always exactly one>
Subject:                  <LLM-generated, lint-passed — §7.4>
List-Unsubscribe:         <https://worker.repworth.net/ingress/unsubscribe/TOKEN>,
                          <mailto:unsubscribe@feedback.repworth.net>
List-Unsubscribe-Post:    List-Unsubscribe=One-Click
Return-Path:              <envelope: bounce.feedback.repworth.net>
```

Locked details, each with its reason:

- **Multipart: HTML + plain-text alternative, always.** HTML-only is a meaningful spam
  signal. Resend takes `html` and `text` together.
- **Exactly one recipient per message.** Never multiple `to:` — each ask carries its own
  unsubscribe token, its own consent re-check, and its own ask row.
- **Single sends, never `resend.batch.send`.** Batch is **atomic** — one bad address
  rejects all 100 — and it contradicts the drip, which requires per-child consent and
  suppression re-validation *at each child's own dispatch time* (map decision 4). At ≤10
  asks/account/day against a 10 req/s team limit, batching buys nothing.
- **Idempotency key `solicitation-ask/<ask_id>`** on every send, via the existing
  `sendEmail(payload, { idempotencyKey })`. A timeout-retry double-sending an ask is both
  a trust failure and a reputation failure. (The `sendEmail` chokepoint's 10s
  `Promise.race` timeout makes retry-after-timeout a *routine* path, not an edge case —
  this key is load-bearing, not defensive.)
- **No `Precedence: bulk`.** `List-Unsubscribe` is the modern bulk signal; `Precedence`
  buys auto-reply suppression at the cost of a bulk-classification hint.
- **No `Auto-Submitted`.** That header is for automatic *responses*; wrong semantics here.
- **Dispatch yields to transactional** on the shared 10 req/s team limit. The drip worker
  is the low-priority consumer — an approval email must never be rate-limited behind a
  batch of asks. (If `SOLICITATION_RESEND_API_KEY` is a separate key per §1.6, note the
  limit is still **per team**, not per key — the yield is a scheduling obligation, not
  something the key split solves.)

### 7.2 Body footer — three required blocks

Rendered into both the HTML and plain-text parts, immediately adjacent:

1. **Identification** — `Sent by RepWorth on behalf of Joe's Diner.`
   Discharges sender identification (§7704(a)(1)) and ad identity (constraints §5 row 6)
   without touching the From line (§2.3).
2. **Postal address** — the owner-attested `businesses.solicitation_postal_address`,
   verbatim (§6 of this doc's §7.5 / see §7.5). CAN-SPAM §7704(a)(5).
3. **Unsubscribe link** — `https://repworth.net/u/<token>`, human-facing, conspicuous, no
   login wall (§7704(a)(3)).

### 7.3 Unsubscribe — two URLs, two consumers

The existing `getEmailHeaders(category)` cannot serve this lane. Three problems:

1. **It reads a *global* `LIST_UNSUBSCRIBE_URL` env var.** Every ask needs its own
   tokenized URL.
2. **Its fallback is fail-dangerous here.** With no URL and no mailbox it emits
   `unsubscribe@repworth.example.com` — an intentionally non-functional RFC 2606 address —
   behind a `console.warn`. For a marketing digest that is a degraded header. For a
   solicitation ask it ships a **legally-required opt-out mechanism that cannot work**, at
   up to **$53,088 per email**.
3. **Vercel BotID/WAF would eat the one-click POST.** RFC 8058 means *Gmail's servers*
   POST unattended — no browser, no cookies, no JS. Precisely the shape BotID exists to
   block, and a blocked unsubscribe is a CAN-SPAM violation that fails silently.

**Resolution — split the URLs:**

| Consumer | URL | Why |
|---|---|---|
| Mail provider (machine `POST`) | `https://${WORKER_PUBLIC_URL}/ingress/unsubscribe/<token>` — **Railway** | Invariant #6: third-party ingress terminates on Railway. Sidesteps BotID/WAF entirely. `POST` executes; `GET` 302s to the landing page for clients that treat the header as a link. |
| Human (footer link) | `https://repworth.net/u/<token>` — **Vercel** | It is UI (invariant #1). Confirms the action, explains its global scope (§6.3), no login wall. |

Both accept the same token.

**Signature change:** `getEmailHeaders(category, opts?: { unsubscribeUrl?: string })`, plus
a new `'solicitation'` category. Narrow and backward-compatible — keeps **one authoritative
owner** of List-Unsubscribe construction rather than forking a second builder
(engineering.md). The `'solicitation'` branch **throws** on a missing URL. It never falls
back to the global env var and never to the `example.com` mailbox.

**Token follows the approval-token precedent (invariant #5): SHA-256 hash stored, raw
token exists only in memory and in the sent message.** Never in Postgres, outbox payloads,
or logs.

**Endpoint contract** (built by #626, constrained here):
- Idempotent — a provider may POST more than once.
- Unauthenticated beyond the token; **no confirmation step** (RFC 8058 §3.2 forbids it for
  the one-click path).
- Operable **≥30 days** after send (§7704(a)(3)) — token TTL ≥ 30 days, and realistically
  longer; recommend no expiry, since an expired unsubscribe link is a violation.
- Honors within **10 business days** (§7704(a)(4)) — we honor synchronously, which is
  trivially inside the bar.
- Never charges a fee, never requires a login.

### 7.4 Subject constraints

Subjects are LLM-generated (map decision 3). The **deterministic, fail-closed lint** is
shared with #623's content linter; these are the deliverability- and header-compliance
rules #622 contributes:

| Rule | Source |
|---|---|
| No `Re:` / `Fwd:` prefix | §7704(a)(2) — deceptive subject line |
| No incentive terms (discount, free, gift, entry, credit, points…) | Constraints §5 row 2 — Google bans incentives for **any** review, stricter than FTC |
| No sentiment conditioning ("if you loved us…", "had a great visit?") | Constraints §5 row 1 — gating funnel |
| No review-content steering (star counts, keywords to mention) | Constraints §5 row 3 — ghostwriting |
| No ALL-CAPS words; ≤1 emoji; no `!!!` | Spam heuristics |
| ≤60 chars target, 100 hard max | Mobile truncation |
| No PII beyond the contact's first name | Constraints §5 row 8 |

**Fail-closed:** a subject that does not pass is a generation failure. It is never sent
with a fallback subject, and never sent with the subject stripped.

### 7.5 Postal address (D7)

**`google_place_address` is the wrong source.** It exists (migration 014) but cannot carry
CAN-SPAM's "valid physical postal address of the sender":

- It is Google's `formattedAddress`. **Service-area businesses hide their street address on
  Google** — for a mobile locksmith it can be just `"Austin, TX, USA"`. Not a valid postal
  address, and nothing in the value tells us it isn't one.
- It is **not owner-attested**. Liability attaches to the promoted business *and* to us as
  initiator. Auto-populating a legally-required field from third-party data the owner never
  confirmed is the wrong default.
- It **cannot express a USPS-registered PO box**, which the statute permits and which many
  owners strongly prefer over publishing a home address.
- `worker/jobs/account-offboarding/purge-stages.ts:600` **NULLs it during purge** — it is
  not even a stable field.

**New column: `businesses.solicitation_postal_address`** (per-location — the "sender" being
promoted is the location; a franchise's Phoenix branch footering a Dallas HQ address is
arguably misleading body content). Prefilled from `google_place_address` as an **editable
suggestion**, never as a silent default. Requires an explicit owner attestation checkbox:
*"This is a valid physical postal address or USPS-registered PO box for this business."*

Light lint only — non-empty, ≥2 lines, contains a postal code. **Do not attempt structured
international address validation**; it is a trap and we are US-first.

Migration owned by **#627** (obeys the ONE-migration-in-flight rule from map #617).

### 7.6 Three enforcement points, doing three different jobs

The address is **an input to rendering**, not merely a send-time check — it is baked into
the footer, and map decision 4 locks "what was approved is byte-for-byte what sends."

| # | Point | Behavior |
|---|---|---|
| 1 | **Batch build** | No attested address ⇒ **no batch produced**, with a location-level reason. The owner sees "add your business address" rather than an empty batch. |
| 2 | **Render** (#628) | **Fail-closed.** Missing address is a hard generation failure — never a blank, partial, or placeholder footer. |
| 3 | **Dispatch** (#630) | Re-assert the address still exists **and still byte-matches the one baked into the approved message.** If it changed: **withhold and surface — do not re-render.** Re-rendering would silently break the approved-bytes contract. |

Point 3 is not paranoia: approval and send are separated by hours-to-days of drip, during
which the owner can edit the address or an offboarding purge can clear it.

**Deliberately NOT added to `WITHHOLD_REASONS`.** That enum in
`src/lib/solicitation/restraint-policy.ts` is closed, precedence-ordered, and versioned by
`RESTRAINT_POLICY_VERSION` with an explicit reproducibility contract ("a decision made
under `.1` is not reproducible under `.2`"). Adding a member bumps the version and
invalidates comparability with existing watch-mode evidence. Worse, **every member is a
per-candidate reason**, while a missing address is a **per-location fact** — it would mark
all 25 candidates individually withheld for one location-level cause. It stays a
batch-build precondition, outside the enum.

Same class, same treatment: **`owner_email_bounced = TRUE`** (§2.4).

---

## 8. DMARC (D10)

### 8.1 Current state (verified 2026-07-28)

```
_dmarc.repworth.net  →  v=DMARC1; p=quarantine; adkim=r; aspf=r;
                        rua=mailto:dmarc_rua@onsecureserver.net;
```

**No `sp=` tag**, so per RFC 7489 subdomains inherit `p=quarantine`. The `rua` goes to a
third party — **we do not currently see our own aggregate reports.** There is also a stray
`brevo-code:` TXT on the apex: a second email vendor verified on the domain (FU-3, §10).

### 8.2 Locked record

```
_dmarc.feedback.repworth.net  →  v=DMARC1; p=reject; adkim=s; aspf=r;
                                 rua=mailto:<a mailbox we control>; pct=100
```

- **`p=reject` from day one — no `p=none` ramp.** The only reason to start permissive is
  to discover unknown legitimate senders. This subdomain is brand new with exactly one
  authorized sender; there are none to discover. A permissive window on the domain we are
  about to use for unsolicited commercial mail is the worst possible place to leave
  spoofable.
- **`adkim=s`** — Resend signs with `d=feedback.repworth.net`, exactly matching the From
  domain. Strict costs nothing.
- **`aspf=r` — must stay relaxed.** The custom return-path makes the envelope sender
  `bounce.feedback.repworth.net`, which is **not** an exact match for the From domain.
  **`aspf=s` would fail SPF alignment on every single message.** This is the one place
  where reflexive strictness silently breaks sending.
- **`rua` to a mailbox we control**, so aggregate reports for the sending domain actually
  reach us — unlike the apex today.

Explicit record on the subdomain **overrides** the apex's inherited policy, and insulates
the solicitation domain from any future apex change.

### 8.3 Verification, before the seed gate

From a seed inbox, confirm the raw headers show all three:

```
Authentication-Results: ... spf=pass ... dkim=pass header.d=feedback.repworth.net ... dmarc=pass
```

An `spf=pass` with `dmarc=fail` is the signature of the `aspf` trap above.

---

## 9. Configuration surface

New env vars. **Every one fails closed.** All server-only — no `NEXT_PUBLIC_*` companion
(invariant #13), and `ci:static-policy` will enforce that.

| Var | Where | Default | Behavior |
|---|---|---|---|
| `SOLICITATION_RESEND_API_KEY` | Railway | unset | Domain-scoped Resend key (§1.6). **Unset ⇒ no solicitation sends.** |
| `SOLICITATION_SEND_FROM_ADDRESS` | Railway | unset | e.g. `reviews@feedback.repworth.net`. Address only — the display name is per-business. **Unset ⇒ no sends.** |
| `SOLICITATION_PLATFORM_DAILY_CAP` | Railway | **0** | Platform-wide daily ceiling (§3.2A). **Unset or unparseable ⇒ 0 ⇒ no sends.** The warm-up dial and the emergency brake. |
| `SOLICITATION_UNSUBSCRIBE_MAILTO` | Railway | unset | `mailto:` fallback in `List-Unsubscribe`. **Unset ⇒ no sends** (never the `example.com` fallback — §7.3). |

Reused, unchanged: `WORKER_PUBLIC_URL` (unsubscribe ingress base), `NEXT_PUBLIC_APP_URL`
(human landing base), `RESEND_WEBHOOK_SECRET` (same svix secret; one endpoint serves both
lanes), `EMAIL_SEND_TIMEOUT_MS`.

Flag stack unchanged from map decision 7: `SOLICITATION_SEND_ENABLED` masters the surface;
the separate auto-approval flag gates the Autopilot lane. Both read through
`src/lib/solicitation/flags.ts`'s `readFlag` accessor pattern, matching
`SOLICITATION_WATCH_ENABLED`. **Boot assertion:** when `SOLICITATION_SEND_ENABLED` is on,
`worker/config/startup-assert.ts` must require all four vars above — a worker that boots
with sending enabled and no From address is a worker that fails at dispatch time instead
of boot time.

Flipping any of these follows the **`flag-flip` skill**.

---

## 10. Flagged follow-ups — out of scope for #622

| ID | Item | Why deferred |
|---|---|---|
| **FU-1** | Move transactional off the apex to `notify.repworth.net`, making the two lanes siblings rather than parent/child (§1.2) | Changes the approval-email lane — invariant #3 blast radius. Needs its own ticket and its own staging ride. |
| **FU-2** | Add `sp=reject` to `_dmarc.repworth.net`; repoint the apex `rua` to a mailbox we control (§8.1) | Touches the DMARC policy governing transactional/approval mail. Same reasoning as FU-1. |
| **FU-3** | Investigate the stray `brevo-code:` TXT on the apex — a second email vendor verified on our domain (§8.1) | Unknown provenance; possibly stale, possibly an active third-party sender. Audit, don't guess. |
| **FU-4** | Automate reply-based opt-out capture from `reviews@` (§2.2) | v1 handles it manually inside the 10-business-day bar. Automating needs Resend inbound parsing + an intent classifier — its own effort. |
| **FU-5** | Per-location daily send cap (§4.3) | Account-level is the bound decision 6 asked for. Add only on a concrete multi-location need. |
| **FU-6** | Dedicated sending IP (§3.1) | Only worth it well above current volume; a low-volume dedicated IP performs worse than a warm shared pool. |
| **FU-7** | Custom per-business sending domains | Explicitly out of scope on map #617. |

---

## 11. Constraint hand-offs to sibling tickets

What #622 binds on tickets it does not own:

| Ticket | Binding constraint from this spec |
|---|---|
| **#627** (email adapter + sending domain) | Everything in §1, §2, §7.1, §9. Owns the `businesses.solicitation_postal_address` migration (§7.5) and the `getEmailHeaders` signature change (§7.3). |
| **#626** (suppression + unsubscribe ingress) | Global suppression scope (§6.1); never push to Resend's list (§6.2); the two-URL split and the ≥30-day/no-expiry token contract (§7.3); the honest "this is global" owner copy (§6.3). |
| **#621** (suppression ledger spec) | The ledger must be keyed on **normalized email address, globally** — not `(account_id, email)` (§6.1). Normalization rule: lowercase + trim only (§6.1). |
| **#630** (dispatch/drip worker) | Gate order breaker → platform ceiling → account cap → per-child (§4.3); single sends not batch, idempotency key, yield to transactional (§7.1); dispatch-time address byte-match (§7.6). |
| **#628** (ask generation) | Subject lint rules (§7.4); render fails closed without a postal address (§7.6); the `feedback.` domain / private-funnel copy interaction (§1.3). |
| **#624** (spine primitives) | `solicitation_asks` carries `external_message_id`, `sent_at`, `delivered_at`, and the rendered-message bytes including the baked-in postal address (§5.1, §7.6). |
| **#633** (staging flip + evidence) | Seed-inbox gate output — SPF/DKIM/DMARC `Authentication-Results`, per-provider placement, one-click POST execution (§3.4, §8.3). |

---

## 12. Open questions this spec does NOT answer

Deliberately, so no one mistakes silence for a decision:

- **Who owns the `reviews@` mailbox operationally** and what the SLA is on reply-based
  opt-outs. Product/ops call, not engineering (§2.2, FU-4).
- **The exact `rua` mailbox** for `_dmarc.feedback.repworth.net` (§8.2) — needs a real
  address or a DMARC reporting vendor decision.
- **Whether the health-window breaker's 2% / 0.3% thresholds should be env-tunable.** Spec
  says constants; if operational reality wants a dial, that is a small delta in #630.
- **Ask-copy content beyond subject constraints** — #623's territory in full.
- **Consent basis and its provenance** — #620's territory in full. This spec assumes a
  contact is already consent-cleared before it becomes a candidate.
