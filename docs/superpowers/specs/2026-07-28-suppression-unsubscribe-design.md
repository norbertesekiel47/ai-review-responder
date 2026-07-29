# Suppression Ledger + Unsubscribe Flow — LOCKED SPEC (#621)

> **AMENDED 2026-07-28 — read `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` first.** Amended
> here: D8/§2.2/§11 — the unsubscribe token is minted at **dispatch by #630**
> (not at render by #628), token rows key on `outreach_id`, stored bodies carry
> a placeholder (B4). §4.1's "no `RESTRAINT_POLICY_VERSION` bump" was already
> superseded by #620 §6.2.

> **Status:** Locked 2026-07-28 via grilling session. Resolves wayfinder ticket **#621**
> (part of map **#617**, Solicitation SEND-MODE Phase 2b, design doc §9.3).
> Binding compliance reference: `docs/research/2026-07-23-solicitation-policy-constraints.md`
> (#531) — this spec cites its **§2** (CAN-SPAM) and **§5 row 6** rather than re-deriving them.
> Handle semantics inherited from **#535** (`docs/superpowers/specs/2026-07-23-contacts-csv-contract-design.md` §1.1/§6).
> Withhold enum inherited from **#533/#542** (`docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md`).
>
> **Consumes:** `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` (§5.3 webhook event set, §6 suppression
> constraints, §7.1 envelope, §7.3 the two-URL split and token contract, §2.2 the manual
> servicing obligation). **Feeds:** #626 (suppression ledger + unsubscribe landing + RFC 8058
> ingress — the primary implementation ticket), #630 (dispatch/drip worker — the dispatch
> gate), #628 (ask generation — token minting at render), #629 (owner approval surface —
> read-time join and copy), #633 (staging flip evidence).
>
> This is engineering research and product spec, **not legal advice.** Counsel gates the
> PROD flip only (map decision 5), never the staging destination.

---

## 0. Decision register

Nine decisions, each locked in the #621 grilling session, plus two rules derived from them.
Everything below is derivation.

| # | Decision | Locked value |
|---|---|---|
| D1 | Scope | **Global** key `(channel, normalized_handle)` for recipient- and provider-authored suppression; `account_id` + `source` as provenance |
| D2 | Restraint interplay | Build time: **populate** `candidate.suppression`, `evaluateAsk` owns the withhold. Dispatch time: **narrow consent+suppression precondition, never a policy re-run**; distinct terminal status |
| D3 | Human landing page | **GET reads only; a button POSTs.** POST lands on a **Vercel** route handler. Idempotent; unknown and used tokens indistinguishable |
| D4 | Honor latency | **Immediate.** Dispatch gate is authoritative; **no eager cancel** of pending asks. Owner UI joins the ledger **at read time** for display |
| D5 | Manual suppression | **Admin manual** (global, `admin_manual`) and **owner manual** (account-scoped, `owner_manual`) via a `scope ∈ {global, account}` discriminator |
| D6 | Re-subscribe | **None, ever, self-serve. No expiry.** Attestation never overrides suppression. **Admin-only audited correction path** for demonstrable errors |
| D7 | Retention | Global rows **`retain_compliance_limited_pii` / `allowed_limited_retention`**; account rows `hard_delete`. **Raw handle, not a peppered hash** |
| D8 | Token durability | **Dedicated token table**, decoupled from `solicitation_asks`, retained and scrubbed through purge. No expiry. Redemption works after the sender is gone |
| D9 | Manual servicing + ingress semantics | Keep the mailto; **daily business-day servicing**, audited. Ingress: **commit-then-2xx**, 5xx + loud Sentry on failure, idempotent, **no rate limiting** |

**Derived rule DR1 — the kill switch must not disable the opt-out.**
`SOLICITATION_SEND_ENABLED` masters *sending*. Flipping it **off** leaves the unsubscribe
ingress, the landing page, and every ledger write **fully live**. Asks already delivered
carry links that must operate ≥30 days (§7704(a)(3)), and a flag flip is precisely the
moment someone would break them. No suppression-path code reads that flag.

**Derived rule DR2 — the ledger is solicitation-only.**
Transactional and notification email must **never** consult it. This is the mirror of #622
§6.2's "never push to Resend's team-wide list": an owner who opted out as somebody else's
customer must still receive approval emails. Consulting the ledger from the notification
lane reaches **invariant #3 sideways** — a response never gets approved because the
approval link was never delivered, and nothing errors.

---

## 1. Scope model (D1, D5)

### 1.1 Global, keyed on the normalized handle

The ledger key is `(channel, normalized_handle)`. `account_id` is recorded for audit and
is **not part of the key** for recipient- or provider-authored rows.

This is #622 §6.1, adopted unamended. Its argument is deliverability, and it falls out of
#622's D2 (one shared mailbox `reviews@feedback.repworth.net` for every account): from the
recipient's inbox there is exactly one sender. A person who reports Joe's Diner's ask as
spam has reported *that address*; if Sally's Salon then mails them from it, the recipient
cannot tell it is a different business, and Gmail scores the second complaint against the
same domain.

**#621's issue body and the map's framing said "per-account scope." That is superseded
here.** The two specs could not both be true, and the deliverability argument wins on the
merits — with one asymmetry that settles it independently: **complaints and permanent
bounces are properties of the mailbox and the sending identity, not of the business.** A
per-account key for those is indefensible under a shared sender no matter what one decides
about unsubscribes.

Global unsubscribe is **over-compliant** and #622 §6.3 says so out loud — CAN-SPAM's opt-out
attaches per-sender, so per-account is what the statute strictly requires. That
over-compliance is deliberate, and it converts into a **copy obligation**, not a key
change (§7.4, §9.3).

**Normalization is `normalizeEmail` from `src/lib/solicitation/handles.ts`, unchanged:
lowercase and trim.** Do **not** strip Gmail dots or `+tags` (#622 §6.1) — over-normalizing
merges distinct real mailboxes and suppresses people who never asked. There is one
authoritative normalizer, already shipped, already the CSV ingest's; the ledger reuses it
rather than re-implementing it.

### 1.2 The account-scoped class, and why it exists

An owner marking "don't contact this person" cannot be global. Under D1 that would let
Owner A silently degrade Owner B's reach with no recipient having said anything — a
cross-tenant write dressed as a product feature. The unsubscribe case is legitimately
global because **the recipient authored it**; an owner's do-not-contact is only legitimate
within the owner's own account.

So ledger rows carry `scope ∈ {'global','account'}`:

| scope | Authored by | Sources | Key |
|---|---|---|---|
| `global` | The recipient, or the mail ecosystem on their behalf | `unsubscribe_link`, `unsubscribe_one_click`, `bounce_permanent`, `complaint`, `provider_suppressed`, `admin_manual` | `(channel, normalized_handle)` |
| `account` | The owner | `owner_manual` | `(channel, normalized_handle, account_id)` |

**Lookup contract (both evaluation points):** a handle is suppressed for a given account iff
a `global` row exists for `(channel, handle)` **OR** an `account` row exists for
`(channel, handle, account_id)`.

**Rejected: a `do_not_contact` flag on `solicitation_contacts`.** It is keyed on the contact
row, and #535 §6 exists precisely because delete-and-re-upload mints a new row. The owner's
POS exports a fresh CSV, the flag evaporates, and we mail someone the owner told us not to
mail — the exact failure the handle-keyed design was built to prevent. That failure mode
does not care who authored the suppression.

**`account_id` on an `account` row is the scope, not a denormalization.** Migration 086's
comment warns against a denormalized `account_id` on `solicitation_contacts` because it
could drift from `businesses.account_id`. That warning does not apply here: the ledger row
does not hang off a business, so `account_id` is the fact itself and has nothing to drift
from.

### 1.3 Channel

`channel` is a column from day one with a closed enum. **v1 ships `'email'` only** — the map
locks email-only as a *destination constraint*, not a sequencing choice.

The column exists because #535 §6 locked "per channel" as the semantics, and because
suppression **must not** cross channels when SMS arrives: email and SMS sit under different
consent regimes (constraints §5 rows 6 vs 7), and an email opt-out is not a TCPA opt-out.
Adding the column now costs one `CHECK`; retrofitting it later means a migration over a
compliance record.

---

## 2. Ledger shape

> The migration is **#626's** to write, under the one-migration-in-flight rule and the
> `new-migration` skill. Migrations head at spec time is **090**. This section is the
> contract that migration must satisfy, not the DDL.

### 2.1 `solicitation_suppressions`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | UUIDv7, worker-supplied (repo convention) |
| `channel` | `TEXT NOT NULL` | `CHECK (channel IN ('email'))` — widened per channel, never by default |
| `normalized_handle` | `TEXT NOT NULL` | Output of `normalizeEmail`; raw, not hashed (§6.2) |
| `scope` | `TEXT NOT NULL` | `CHECK (scope IN ('global','account'))` |
| `account_id` | `UUID` | **NOT NULL when `scope='account'`**, nullable otherwise; `CHECK` enforces the pairing. `ON DELETE SET NULL` is wrong here — see §6.3 |
| `source` | `TEXT NOT NULL` | Closed enum, §3.1 |
| `suppressed_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Surfaced verbatim in restraint evidence |
| `created_by_user_id` | `UUID` | Set for `admin_manual` / `owner_manual` only |
| `note` | `TEXT` | Free text for manual entries; the originating message reference for §7.5 |

**Two partial unique indexes** (the migration 086 pattern):

- `UNIQUE (channel, normalized_handle) WHERE scope = 'global'`
- `UNIQUE (channel, normalized_handle, account_id) WHERE scope = 'account'`

**`ON CONFLICT` against either index must re-spell its predicate byte-for-byte** or Postgres
will not infer the constraint (CLAUDE.md gotcha). Writers use `ON CONFLICT … DO NOTHING`:
**first write wins.** A complaint arriving after an unsubscribe does not overwrite the
earlier row — the state is already correct, and the *history* lives where it belongs (the
provider webhook records #622 §5 already stores, and the audit trail for manual entries).
A second ledger row would add nothing and would break the uniqueness that makes the lookup
a plain equality.

**RLS: enabled, deny-all to the browser.** The ledger is server-owned in the same posture
as `auto_approval_policies` (invariant #14) — owner-facing reads flow through server routes
that apply the §7.4 copy rules, never a direct client query. This is not decorative: a
direct client read of a global row would expose `account_id` provenance, which §7.4
forbids surfacing.

**No time-window comparison is ever made against `suppressed_at`.** Both gates are existence
checks. This deliberately sidesteps the postgres.js microsecond-truncation class (CLAUDE.md
gotcha) — there is no anchor derived from the row and compared back against it.

### 2.2 `solicitation_unsubscribe_tokens`

See §5.2 for why this is a separate table and not a column on `solicitation_asks`.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | UUIDv7 |
| `token_hash` | `TEXT NOT NULL UNIQUE` | SHA-256 of the raw token, `node:crypto` (invariant #10) |
| `normalized_handle` | `TEXT NOT NULL` | The redemption target |
| `channel` | `TEXT NOT NULL` | `CHECK (channel IN ('email'))` |
| `account_id` | `UUID` | Provenance; **scrubbed to NULL on purge** (§6.3) |
| `business_id` | `UUID` | Provenance; scrubbed on purge |
| `ask_id` | `UUID` | Provenance; scrubbed on purge. **No FK** — the referent is hard-deleted |
| `sent_at` | `TIMESTAMPTZ NOT NULL` | |
| `redeemed_at` | `TIMESTAMPTZ` | Set on first redemption; a second redemption is a no-op success |

**Raw tokens exist only in memory and in the sent message** — never in Postgres, outbox
payloads, or logs. This is invariant #5 applied verbatim, as #622 §7.3 requires.

**No expiry.** #622 §7.3 said "≥30 days, recommend no expiry"; this spec closes it at **no
expiry**. A row is roughly 100 bytes and an expired unsubscribe link is a violation. There
is no expiry value better than none.

---

## 3. Sources

### 3.1 Closed enum

One authoritative TS file — `src/lib/solicitation/suppression.ts` — exports
`SUPPRESSION_SOURCES`, `SUPPRESSION_SCOPES`, and `SUPPRESSION_CHANNELS` as `as const`
arrays with derived types. No string literals at call sites (repworth.md).

| `source` | scope | Origin | Owner |
|---|---|---|---|
| `unsubscribe_one_click` | `global` | RFC 8058 `POST` from a mail provider → Railway ingress | #626 |
| `unsubscribe_link` | `global` | Human clicked the footer link and confirmed → Vercel `POST` | #626 |
| `bounce_permanent` | `global` | `email.bounced` with `bounce.type = 'Permanent'` (#622 §5.3) | #627 webhook → #626 writer |
| `complaint` | `global` | `email.complained` (#622 §5.3) | #627 webhook → #626 writer |
| `provider_suppressed` | `global` | `email.suppressed` mirrored from Resend (#622 §5.3) | #627 webhook → #626 writer |
| `admin_manual` | `global` | Reply-based or mailto opt-out, entered by an admin (§7.5) | #626 |
| `owner_manual` | `account` | Owner marked a contact do-not-contact (§7.6) | #626 |

**The two unsubscribe paths are distinguished deliberately.** They cost one enum member and
tell you which mechanism recipients actually use — which is the input to any later decision
about the mailto (§7.5) or the landing page's copy.

### 3.2 What never suppresses

- **Temporary / soft bounces.** #622 §5.3: record, count toward the health window, never
  suppress. A full mailbox is not an opt-out.
- **`email.delivery_delayed`.** Observability only.
- **`email.failed`.** Send-side failure (e.g. `reached_daily_quota`) — a retry
  classification input, not a recipient signal.
- **An ambiguous bounce classification.** #622 §5.3 already locks the fail-safe direction:
  an ambiguous bounce must not permanently suppress a real customer. Under D1 that ruling
  is *more* load-bearing, not less — a false permanent suppression now removes the person
  from every account.

### 3.3 `provider_suppressed` is the known-dirty source

Resend's suppression list is **team-wide across every domain and API key, including
transactional** (#622 §6.2). So an `email.suppressed` mirror can originate from the
*transactional* side — an owner's bounced approval email — for an address that is a
perfectly good customer mailbox.

We still mirror it (diverging silently from the provider is worse), and #622 §5.3 already
requires it be logged loudly. But it is the most likely source of a factually wrong
suppression, and it is the single strongest argument for the correction path in §8.2.

---

## 4. Restraint-policy interplay (D2)

### 4.1 The enum member already ships

`suppressed` is **already** in `WITHHOLD_REASONS`, already gated at precedence 2 in
`evaluateAsk`, already carries evidence `{ suppression_source, suppressed_at }`, and
`AskCandidate.suppression` already exists. The module header says why:

> `no_consent` (like `suppressed`) cannot fire in v-watch — the #535 consent attestation is
> blocking, so every uploaded candidate is covered by construction. **Both gates ship and
> are contract-tested so the enum is stable when send-mode lands.**

So "add a new withhold reason" was never the question. `RESTRAINT_POLICY_VERSION` does
**not** bump: no constant changes and no gate logic changes. Send-mode decisions stay
comparable to watch-mode decisions.

### 4.2 Build time — populate, do not pre-filter

`toCandidate` in `src/lib/solicitation/batch-builder.ts:300` hardcodes `suppression: null`.
The seam is that one line: the candidate loader performs the §1.2 lookup for the window and
populates `{ source, suppressedAt }` where hit.

Rationale for populate over pre-filter:

- Pre-filtering makes a shipped, contract-tested gate permanently dead code — building the
  gate and then routing around it.
- The withhold produces an ask row with evidence, so the owner sees **why** their list
  shrank. Pre-filtered contacts vanish silently, and "my 40-person list became 22" with no
  accounting is exactly the trust wound the restraint policy's evidence design exists to
  prevent.
- **No cap cost.** `evaluateBatch` counts `eligible` as `decision === 'send'` only, so
  withheld rows never consume `BATCH_CAP`. Pre-filtering buys nothing here.
- One authoritative owner of send/withhold (engineering.md). A pre-filter is a second,
  invisible restraint policy with no `policy_version` stamp and no evidence.

`suppression_source` in the evidence is the ledger's `source` value verbatim, and
`suppressed_at` its timestamp. The evidence field names are snake_case **as a serialization
contract** (spec §4 of the restraint spec) — they are stored in JSONB and rendered by the
batch UI.

### 4.3 Dispatch time — a precondition, emphatically not a policy re-run

Map decision 4 and #622 §7.1 both require per-child re-validation at dispatch (which is why
#622 forbids `resend.batch.send`). **That re-validation must NOT call `evaluateAsk`.**

Re-running the policy at dispatch produces **incorrect withholds**:

- `decided_at` is now hours-to-days later, so `days_since_visit` has grown by the drip
  duration. A legitimately approved ask can cross its `FRESHNESS_WINDOW_DAYS` boundary
  mid-drip and `stale_visit` fires on a message the owner already approved.
- The ask's **own batch** is now the most recent `priorBatch`, so `over_contacted` fires
  against itself (a gap of ~0 days against `MIN_GAP_DAYS = 30`).

Both would be spurious, and both fail in the direction of silently dropping approved work.

The dispatch gate therefore checks exactly the two facts that can legitimately change
between approval and send:

1. **Suppression** — the §1.2 lookup.
2. **Consent** — the #535 attestation coverage (#620's ledger once it lands).

On a hit, the ask transitions to a **terminal not-sent state**, and no restraint decision
is emitted. This is the `ResponsePublisherWorker` posture: approval is not a license, it is
a permission that preconditions can still revoke.

### 4.4 Two records of two moments

Consequence, accepted explicitly: a suppressed-at-dispatch ask stores
`restraint_decision = 'send'` (true as of build time) alongside a terminal state of
suppressed (true as of dispatch time). Those are two different records of two different
moments and both are correct.

**The batch UI must render the terminal state, not the build-time decision.** Handed to
#629 as a display requirement.

**The terminal status is distinct from build-time `withheld`.** Collapsing them destroys
the "how many people opted out *after* we asked the owner to approve" signal — the single
best early warning that the copy or the cadence is wrong. Status vocabulary itself belongs
to #619's per-ask lifecycle; this spec's requirement is only that the two are
distinguishable.

---

## 5. The unsubscribe flow (D3, D8)

### 5.1 Two URLs, two consumers — inherited

#622 §7.3 locked this and it is not reopened:

| Consumer | URL | Surface |
|---|---|---|
| Mail provider (machine `POST`) | `https://${WORKER_PUBLIC_URL}/ingress/unsubscribe/<token>` | **Railway** — invariant #6; sidesteps BotID/WAF, which would otherwise silently eat an unattended RFC 8058 `POST` |
| Human (footer link) | `https://repworth.net/u/<token>` | **Vercel** — it is UI (invariant #1) |

Both accept the same token. `GET` on the worker path 302s to the landing page for clients
that treat the header as a link.

### 5.2 The token outlives the ask — so it cannot live on the ask

#622 §7.1 locks one token per ask; §7.3 locks the token operable ≥30 days after send.
Meanwhile `solicitation_asks` is `hard_delete` and cascades from its batch on offboarding
purge.

**The conflict is live:** an owner sends asks on day 1 and cancels on day 5; the purge
deletes the asks; a recipient clicks the unsubscribe link on day 12 and hits a token that
resolves to nothing. A legally-required opt-out mechanism, broken by our own purge, inside
the statutory window — failing in the direction where we cannot even record the request.

Hence `solicitation_unsubscribe_tokens` (§2.2), minted at render by #628, with its own
retention disposition (§6.3).

Rejected alternatives:

- **A self-describing signed token encoding the address.** It puts a customer's email
  inside a URL that lands in mail logs, referrers, and every proxy in between — an
  invariant #5-class leak, to avoid one small table.
- **Delaying the purge 30 days.** Subordinates a deletion SLA to a problem a table solves.

**Redemption of a token whose account was purged still writes a ledger row,
unconditionally.** The recipient's revocation is global (D1) and stands on its own; it must
not depend on the sender still existing. The resulting row carries `account_id = NULL` and
`source = 'unsubscribe_link'` (or `_one_click`).

### 5.3 The human landing page — GET reads, a button POSTs

**`GET /u/<token>`** — server component, **no writes**, `robots: { index: false, follow: false }`,
no login wall, no fee, no form fields. One prominent button. Renders the originating
business name (the recipient already knows it — they received the mail) and never any other
account.

**`POST /api/u/<token>`** — writes the ledger row. Vercel route handler.

Why not GET-effects-suppression, which is fail-safe toward opt-out: **link prefetchers.**
Outlook SafeLinks and corporate mail scanners *do* fetch URLs in delivered mail. Under D1,
one scanner fetch removes that person from every RepWorth account, permanently, with no
re-subscribe (§8.1) — invisible, irreversible, machine-caused, and undetectable after the
fact.

The codebase already answered this exact threat once: `src/app/(public)/approve/[token]/page.tsx`
reads on GET and renders; every mutation is a separate POST route, precisely so a scanner
cannot approve a response. Same threat model, same answer.

The counter-risk — a human who lands and does not click — is bounded, because that human
retains three working paths: the RFC 8058 header (where Gmail/Yahoo/Apple opt-outs actually
go, unattended, carrying the volume), the `mailto:` fallback in the same header, and
replying to the owner (§7.5). CAN-SPAM requires the mechanism to *operate* without fee or
login; it has never required zero-click, and **RFC 8058 §3.2 forbids a confirmation step
only on the unattended path.**

**Why the POST lands on Vercel, not cross-origin to the worker:** invariant #1 bans LLM
calls, external API calls, and long-running work in Next.js routes — not Postgres writes.
`src/app/api/approve/[token]/approve/route.ts` is the standing precedent for a public-token
mutation on Vercel. Invariant #6 governs **third-party ingress** — a mail provider POSTing
— and that path stays on Railway. A human clicking a button on our own page is not
third-party ingress, and cross-origin POSTing would drag CORS into a compliance-critical
path for no gain.

### 5.4 Error states

- **Unknown, malformed, or already-redeemed token** → the same neutral page. It does
  **not** distinguish "never existed" from "already used" (enumeration), and it surfaces
  the `mailto:` as a working alternative. A legally-required mechanism never dead-ends.
- **Already suppressed** → success copy. Idempotent from the recipient's point of view.

### 5.5 Copy

Recipient-facing, on success:

> **You're unsubscribed.**
> You won't receive review requests from Joe's Diner, or from any other business that uses
> RepWorth.

Truthful about the global effect (#622 §6.3), consumer-legible, and it names **exactly one
business** — the one they already heard from. It never enumerates other accounts, never
implies we know their relationship with any other business, and never attributes the
suppression to a business other than the sender.

---

## 6. Honor latency, in-flight work, and retention (D4, D7)

### 6.1 Immediate — and what that means for four kinds of in-flight work

The 10-business-day ceiling (§7704(a)(4)) is a legal floor of adequacy, not a design
target. #622 §7.3 already asserts synchronous honoring. What that leaves open is work
already in flight:

| In flight | Handling |
|---|---|
| Ask rendered, stored, scheduled for a later drip slot | §4.3 dispatch gate — fail-closed, nothing sends |
| Ask already handed to Resend | **Unrecallable.** Accepted and stated |
| Ask mid-dispatch (suppression commits between recheck and provider call) | Irreducible race, bounded in §6.2 |
| Batch currently building | Build gate covers it; a suppression landing mid-build is caught by the next build |

### 6.2 No eager cancel; the UI joins at read time

The unsubscribe write suppresses **immediately**; it does **not** sweep pending asks.

- Eager cancel would make an **unauthenticated public endpoint perform a cross-account
  fan-out write**. Under D1 one anonymous POST could update pending asks across many
  tenants — an amplification surface on the one route that must never be rate-limited or
  blocked (§9.2), and which #622 §7.3 already routed around BotID for exactly that reason.
- It duplicates the authoritative gate, giving two owners of "will this send," and the
  lazy gate still has to exist because of the race below.

**The owner UI gets display truth by joining pending asks against the ledger at read time**
(#629). Cheap — the ledger is indexed for exactly that equality — and it avoids the write
entirely.

**The race, bounded rather than pretended away:** the dispatch-time suppression check runs
**inside the same transaction that transitions the ask to dispatching**, so the exposure
window is the provider call itself. A suppression committing inside that window yields at
most one additional email, delivered inside a window measured in milliseconds against a
10-business-day statutory bar. Explicitly not a violation; explicitly not worth a
distributed lock.

**Drip length is not a compliance parameter.** Because the dispatch gate is authoritative
and re-checked per child, suppression correctness is **independent of drip duration** —
#630 may choose duration on deliverability grounds alone. Recorded here so nobody later
invents a "the drip must finish within 10 business days" rule that does not exist.

### 6.3 Offboarding purge

Every existing solicitation table is `hard_delete` and cascades. **The ledger cannot be** —
deleting a suppression row un-suppresses an opted-out person, which is the #535 §6 failure
arriving through a different door.

| Rows | Disposition | Purge verification | Scope evidence |
|---|---|---|---|
| `solicitation_suppressions` where `scope='global'` | `retain_compliance_limited_pii` | `allowed_limited_retention` | `compliance_handle_hash` |
| `solicitation_suppressions` where `scope='account'` | `hard_delete` | `must_be_absent` | `direct_account_id` |
| `solicitation_unsubscribe_tokens` | `retain_compliance_limited_pii` | `allowed_limited_retention` | `compliance_handle_hash` |

**Both `retain_compliance_limited_pii` and `compliance_handle_hash` are currently vacant
enum members in `src/lib/account-offboarding/table-disposition.ts` — no table uses either.**
They were minted in anticipation; this ledger is their first caller.

- **Global rows are not the account's data** in any meaningful sense. They are the
  *recipient's* revocation against our shared sending identity, tagged with `account_id`
  only as provenance. The account leaving does not revoke the revocation. Retention basis:
  data necessary to honor an opt-out request — which is what that disposition literally
  names, and standard practice for every ESP.
- **Account rows genuinely are the account's data** — an owner's private preference about
  their own customer. Once the account is purged no path exists to mail that person
  through it, so nothing is protected by keeping them.
- **`account_id` on retained global rows: keep the value, do not scrub.** `accounts` is
  already `retain_deidentified` (tombstoned), so the FK points at a tombstone — provenance
  preserved, owner identity unrecoverable. Note this rules out `ON DELETE SET NULL` on that
  column; the purge is an explicit, verified operation, not a cascade side effect.
- **Token rows: scrub `account_id`, `business_id`, `ask_id`; keep
  `{ token_hash, normalized_handle, channel, sent_at }`.** Redemption still works; the
  resulting suppression row carries null provenance. Honoring the opt-out matters; knowing
  which dead account sent it does not.

`src/lib/account-offboarding/purge-verification.ts` needs the `allowed_limited_retention`
branch wired for both tables, or the verifier flags an incomplete purge. Note the existing
solicitation branches verify **by business**; global suppression rows have no business FK,
so their predicate is different by construction.

**The purge receipt reports retained suppression rows in aggregate** — "N opt-out records
are retained so those opt-outs continue to be honored" — with **no addresses listed**.
Silently retaining PII through a purge you told the owner was complete turns a defensible
retention basis into a credibility problem.

### 6.4 Raw handle, not a hash

`compliance_handle_hash` reads like an invitation to store a digest. **We store the raw
normalized handle.**

- An email hash is **not** meaningfully de-identifying. The domain space is low-entropy and
  dictionary-attackable, so a bare SHA-256 is reversible in practice; real protection needs
  an HMAC pepper.
- **That pepper is a catastrophic single point of failure on a compliance record.** Lose or
  rotate it and every suppression row is orphaned — you have silently un-suppressed
  everyone who ever opted out, with no way to detect it and no way to rebuild. Strictly
  worse than the risk hashing buys down.
- It buys little: the same addresses already sit in `solicitation_contacts` pre-purge, and
  the post-purge retained set is small, write-rarely, and read only by an equality join.
- It costs operability on every path that must work — §7.5 admin entry, the §8.2 correction
  path, the #629 owner-facing join, and incident debugging.

`compliance_handle_hash` is therefore read as **scope evidence** — "this row's association
is by handle, not by `account_id`" — which is what the field means, rather than as a
storage instruction.

---

## 7. Manual paths (D5, D9)

### 7.1 Admin manual is not optional

#622 §2.2 already created the obligation:

> **Reply-based opt-outs are an operational obligation, not an automated path.** Anything
> arriving at this mailbox that reads as an opt-out must be entered into the suppression
> ledger manually within CAN-SPAM's **10 business days.**

A "please remove me" reply sitting unactioned in a mailbox we own is a §7704(a)(4)
violation with our own paper trail as the evidence. `source = 'admin_manual'`, `scope =
'global'` — it is the recipient speaking, arriving by a channel we do not automate.

### 7.2 The servicing contract

#622 §2.2 also says the mailbox "needs a destination, not a staffed desk." Those two
sentences are in tension: a forward nobody watches cannot discharge a 10-business-day
statutory obligation. And this is not only about strays — the #622 §7.1 envelope
**advertises** `<mailto:unsubscribe@feedback.repworth.net>` in `List-Unsubscribe`, so some
clients will opt out by sending mail to it.

**The mailto stays.** RFC 8058 and Gmail's bulk-sender rules both require only the https
one-click; mailto is optional. Dropping it would trim volume but not the obligation —
replies to the From address arrive regardless — and no recipient would lose a path, since
the footer link covers mailto-only clients. Not worth churning a sibling's locked envelope
for a marginal reduction in something that must be staffed anyway.

Locked contract:

- **Daily business-day check** of the forwarded mailbox. The bar is 10 business days; daily
  costs nothing on a low-volume forward and keeps the margin honest.
- **Entry via the §7.3 admin path**, audited: who entered it, when, and the originating
  message reference in `note`.
- **Mailbox liveness is a stated operational assumption, validated not assumed.** A broken
  Cloudflare forward makes opt-outs vanish with zero signal. Verified at the staging flip
  (#633 evidence) and documented in the channels runbook — **a documented probe, not a new
  poller.** Building a monitor for a mailbox checked daily by hand is the wrong altitude.

### 7.3 Admin surface

An admin-only action that takes a raw email address, normalizes it via `normalizeEmail`,
and inserts a `global` row with `source = 'admin_manual'`, `created_by_user_id`, and a
required `note`. Rejects an address that fails normalization rather than minting a wrong
handle (the `handles.ts` posture). Idempotent against the partial unique index.

### 7.4 Owner-facing display rules

Wherever a suppressed contact appears to an owner:

- It is shown as **opted out of RepWorth review requests** — never as merely "skipped."
  #622 §6.3 requires the global effect be stated honestly.
- It is **never attributed to another account**, and the surface never reveals that another
  business mailed that person. A global row's `account_id` provenance is server-side audit
  data; exposing it through the suppression surface is a cross-tenant leak (invariant #8).
- An `account`-scoped row is shown as the owner's own do-not-contact and is distinguishable
  from a global one, because only the former is reversible by the owner (§7.6).

### 7.5 Owner manual suppression

An owner action on a contact: "don't contact this person." Writes `scope = 'account'`,
`source = 'owner_manual'`, `account_id` = the owner's account, `created_by_user_id`.

Rationale for shipping it in v1 rather than deferring: under CAN-SPAM the **owner is the
liable sender** even when a vendor sends on their behalf (constraints §2 item 7). Denying
the liable party a mechanism to stop mail going out under their own name is the wrong
default, and the cost is one button plus a row.

### 7.6 An owner may clear only their own account rows

An owner may remove a row they created (`scope='account'`, their `account_id`). It is their
own preference about their own customer; no recipient ever spoke, so reversing it harms
nobody.

**An owner may never clear a `global` row**, and the UI must not present the two controls as
the same thing. This is emphatically **not** re-subscribe (§8.1).

---

## 8. No re-subscribe (D6)

### 8.1 The rule

- **No self-serve re-subscribe for `global` rows. Ever, in any surface.** CAN-SPAM places
  no expiry on an opt-out; there is no product need (a suppressed person can still leave a
  review of their own accord — nothing about suppression touches the review flow); and a
  re-subscribe control is a liability surface with approximately zero upside.
- **Suppression rows never expire.** A TTL on an opt-out is a violation with a cron job
  attached.
- **A new consent attestation does not override suppression.** Stated verbatim because this
  is the most likely way re-subscribe gets built by accident: an owner re-uploads a CSV,
  re-attests consent, and someone reasons "they attested, so we're covered."

  > **Attestation is the owner asserting a relationship; suppression is the recipient
  > revoking one. The second outranks the first, permanently.**

  `consent.attested` and `suppression` are independent inputs to `evaluateAsk`, and #535 §6
  keyed the ledger on the handle precisely so delete-and-re-upload cannot launder an
  opt-out. The enum's precedence order (`no_consent` before `suppressed`) governs **which
  reason is reported when both apply** — it is not an override relationship, and it will be
  misread as one unless this is written down.

### 8.2 The correction path — error correction, never re-subscribe

"No re-subscribe" without a correction path is itself a defect, because some suppressions
will be factually wrong:

- an admin typo on a §7.2 manual entry,
- an ambiguous bounce that #622 §5.3's fail-safe did not catch,
- a `provider_suppressed` mirror originating from the **transactional** side (§3.3).

**Locked: an admin-only, audited removal path, framed as error correction.** Not exposed to
owners, not exposed to recipients, no self-serve entry point. It writes an audit record
naming who removed the row and why — the same posture as `writeAccountAuditLog`, in the
same transaction as the delete.

Without it, a typo is permanently unfixable, and the answer to "please put me back" is "we
cannot, ever" — a worse story than the one the no-re-subscribe rule was avoiding.

---

## 9. Failure semantics and observability (D9)

### 9.1 The ingress endpoint

`POST /ingress/unsubscribe/<token>` on Railway (`worker/ingress/unsubscribe.ts`, alongside
`{stripe,resend,shared}.ts` — it is a public mechanism, not a provider, so it takes no
per-provider subfolder).

- **Return 2xx only after the ledger write commits.** A 2xx on an uncommitted write is a
  lost opt-out that the provider believes it delivered — the worst failure in this system
  and completely silent.
- **On write failure: 5xx + loud Sentry.** A 5xx leaves the provider free to retry and
  leaves us a signal. Fail-loud beats fail-quiet on the one endpoint whose silent failure
  is a statutory violation. This is a deliberate exception to the "best-effort work gets
  its own log-and-swallow" convention — the ledger write **is** the primary side effect
  here, not secondary work after it.
- **Idempotent** (#622 §7.3): a repeat POST is a 2xx no-op, never a duplicate row and never
  an error. Providers do re-POST.
- **No confirmation step** — RFC 8058 §3.2 forbids it on this path.

### 9.2 No rate limiting on either unsubscribe path

#622 §7.3 already routed the machine path around BotID/WAF because a blocked unsubscribe is
a CAN-SPAM violation that fails silently. **Adding a rate limiter would reintroduce the same
hazard through a different door.** The write is a bounded single-row upsert keyed on a
hashed token, so the abuse ceiling is low: an attacker with no valid token accomplishes
nothing, and an attacker with a valid token can only suppress the address that token
already belongs to.

This is a deliberate, named exception to the platform's default bot-protection posture, and
it applies to the Vercel `POST /api/u/<token>` route as well.

### 9.3 No outbox row

The suppression write has **no asynchronous follow-up work** — D4 rules out eager cancel,
and the analytics event is a durable server-side insert in the same transaction (the
`AnalyticsDispatchPoller` ships it). Invariant #2 governs "state change + follow-up work";
with no follow-up work there is nothing to make transactional with. **Do not add a
`job_outbox` row on spec.**

### 9.4 Analytics

Durable server-side events (never client-postable), idempotent on `event_key`:

| Event | Emitted when | Properties |
|---|---|---|
| `solicitation_suppressed` | Any ledger row is written | `source`, `scope`, `channel` — **never the handle** |
| `solicitation_suppressed_at_dispatch` | The §4.3 dispatch gate fires | `source`, `ask_id` |

The dispatch-gate event is the signal called out in §4.4 — opt-outs arriving *after* owner
approval are the earliest evidence that the copy or cadence is wrong.

### 9.5 Logging

Never log the raw handle, the raw token, or any part of the ask body. `createWorkerLogger`
object args pass through the analytics blocked-key sanitizer; **string args do not**, so a
handle must never be interpolated into a log message. Log the `token_hash` prefix or the
suppression row id when correlation is needed.

---

## 10. Configuration surface

**No new environment variables.** Reused unchanged:

| Variable | Surface | Use |
|---|---|---|
| `WORKER_PUBLIC_URL` | Railway | Base for the RFC 8058 ingress URL (#622 §7.3) |
| `NEXT_PUBLIC_APP_URL` | Vercel | Base for the human landing page |
| `SOLICITATION_UNSUBSCRIBE_MAILTO` | Railway | The `mailto:` member of `List-Unsubscribe` — **owned by #622**, serviced per §7.2 |

**`SOLICITATION_SEND_ENABLED` is deliberately absent from this table.** Per DR1, no
suppression-path code reads it.

---

## 11. Constraint hand-offs to sibling tickets

| Ticket | What #621 binds |
|---|---|
| **#626** (suppression ledger + unsubscribe landing + ingress) | Everything in §2, §5, §7, §9. The migration (head 090 at spec time), both partial unique indexes with byte-for-byte `ON CONFLICT` predicates, RLS deny-all, both route surfaces, the admin + owner actions, the §8.2 correction path |
| **#630** (dispatch/drip worker) | §4.3 — the dispatch gate is a **narrow consent+suppression precondition, never `evaluateAsk`**; §6.2 — recheck inside the dispatching transaction; drip duration is unconstrained by this spec |
| **#628** (ask generation) | §2.2 — mint the token row at render; raw token in memory and the message only (invariant #5) |
| **#629** (owner approval surface) | §4.4 — render the terminal state, not the build-time decision; §6.2 — read-time join for pending-ask display; §7.4 — copy rules and the cross-tenant prohibition |
| **#624** (spine lifecycle) | §4.4 — suppressed-at-dispatch must be distinguishable from build-time `withheld` in the per-ask status vocabulary |
| **#627** (email adapter) | §3.1 — webhook events map to `bounce_permanent` / `complaint` / `provider_suppressed`; §3.2 — soft bounces and `email.failed` never suppress |
| **#633** (staging flip evidence) | §7.2 — mailbox liveness verified as flip evidence; DR1 — prove the opt-out path still works with `SOLICITATION_SEND_ENABLED` off |
| **#620** (consent ledger) | §4.3 — the dispatch gate's second check is consent; §8.1 — attestation never overrides suppression |

**Amendment to #622:** none. §6.1's global scope and §6.3's honesty requirement are adopted
as written; the `scope='account'` class is additive and was never contemplated there.

**Supersedes:** the "per-account scope" framing in #621's issue body and map #617's ticket
line (§1.1).

---

## 12. Flagged follow-ups — out of scope for #621

| # | Item | Why deferred |
|---|---|---|
| FU-1 | Automated parsing of reply-based and mailto opt-outs | #622 FU-4 already deferred it; §7.2's daily human check discharges the obligation at v1 volume |
| FU-2 | SMS channel rows | Email-only is a destination constraint of map #617. The `channel` column exists so this needs no migration over a compliance record |
| FU-3 | Owner-visible suppression *reason* detail (bounce vs complaint vs unsubscribe) | §7.4 shows a single "opted out" state. Distinguishing them leaks recipient behavior to the owner; revisit only with a concrete product need |
| FU-4 | Suppression-rate alerting as a health signal | #622 §4 already breaks the circuit on complaint and bounce **rates** from webhook events. A second alert on ledger writes would double-count the same facts |
| FU-5 | Bulk owner import of a do-not-contact list | Single-contact action ships; bulk needs its own CSV contract and belongs with #535's machinery |

---

## 13. Open questions this spec does NOT answer

- **Per-ask status vocabulary.** §4.4 requires suppressed-at-dispatch be distinguishable
  from build-time `withheld`; the actual enum belongs to **#619 / #624**.
- **Drip duration and pacing.** Explicitly unconstrained here (§6.2). **#619 / #630.**
- **Consent-ledger shape.** The dispatch gate's second check (§4.3) assumes #620's model;
  this spec binds only that suppression and consent are checked together and fail closed.
- **Whether `review_attributed` attribution touches suppressed contacts.** Shadow metric,
  **#632.**
- **Counsel's view of global-scope over-compliance.** #622 §6.3 flagged it; counsel gates
  the **prod** flip only (map decision 5), never the staging destination.
