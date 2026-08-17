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
| DKIM ×3 | `<selector>._domainkey.feedback` | CNAME | `<selector>.dkim.amazonses.com.` |
| DMARC | `_dmarc.feedback` | TXT | see §3 |
| Tracking | — | — | **deliberately absent** (§1) |

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
                                 rua=mailto:<a mailbox we control>; pct=100
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
- **`rua` to a mailbox we control**, so aggregate reports for the sending domain
  actually reach us. The apex `_dmarc.repworth.net` currently sends its `rua` to a
  third party, which is why we do not see our own reports today; do not copy that
  address. **This value is an open input, not a decision this runbook makes** —
  spec §12 records it as unresolved (a real address or a DMARC reporting vendor).
  Resolve it before creating the record; a `rua` nobody reads is the apex's
  problem repeated.

The explicit record on the subdomain **overrides** the apex's inherited policy and
insulates the solicitation domain from any future apex change. Leave the apex
alone — retuning it is spec follow-up FU-2 and touches the approval-email lane.

---

## 4. The `reviews@` mailbox — real, routed, not `no-reply@`

`reviews@feedback.<env>.repworth.net` **must accept and route mail.** A Cloudflare
Email Routing forward to a monitored destination is sufficient — this needs a
destination, not a staffed desk.

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
