# Support Bot — Design Spec

**Date:** 2026-05-30
**Status:** Draft (awaiting review)
**Decision:** Option C — *buy now, build later* (doc-grounded AI chat widget via a third-party vendor, with an explicit build-it-later checkpoint)

---

## 1. Problem & scope

RepWorth needs a customer-facing **support bot** serving two audiences with one
surface:

- **Pre-sales** visitors on the marketing site ("what is RepWorth / pricing / does it do X").
- **Logged-in customers** asking general + how-to questions ("how do I connect Google", "why hasn't my review posted" → generic steps).

When the bot can't resolve, it **hands off to a human**.

**Deliberately out of scope (the deferred line):**

- **No account data.** The bot answers from docs only; it does not read a user's
  reviews, connection status, subscription, or jobs.
- **No actions.** The bot cannot resend approval emails, retry posts, regenerate
  drafts, or touch any account state.
- **No new code in RepWorth's stack.** No worker endpoints, no LLM calls, no
  embeddings/RAG pipeline. The vendor hosts all of that.

Keeping these out is what preserves the architecture invariants (§7) and keeps
the whole thing reversible.

## 2. Why buy, not build (decision record)

An answers-only, docs-grounded chat bot with human escalation is a **solved
problem**. Building it in-stack is *feasible but not cheap*, because invariant #1
forbids LLM calls in Next.js routes — a build would require a Railway worker chat
endpoint, browser→worker streaming (CORS), a RAG/embeddings pipeline with
re-indexing, chat history storage, moderation, and a branded widget. That is
weeks of work plus ongoing maintenance, to rebuild a wheel, for a feature whose
ROI is still unproven.

Buying ships in days, sidesteps invariant #1 entirely (no LLM in our stack), and
is trivially reversible. The point where building genuinely *wins* is the
account-aware / action layer we deferred in §1 — and that's exactly the
checkpoint in §6. Build *then*, with evidence.

This aligns with the project engineering rules: delay irreversible commitment,
prefer tracer bullets, YAGNI, prove demand before building infra.

## 3. Vendor

**Primary: Crisp.** One tool covers everything this needs:

- AI bot trained on a help center / doc set.
- Native human inbox (web + mobile) for escalation — no custom wiring.
- Hostable Help Center to publish articles into.
- Free tier to start; ~€25/mo Pro tier; EU-hosted option (fits our
  privacy posture).

**Documented alternative: Chatbase.** The most polished *pure* AI doc-bot,
trivially trained on URLs/files (~$40/mo), but with a weaker human handoff
(escalates to email/Slack/forms, not a full agent inbox). Swap in if we decide
the bot quality matters more than having a real agent inbox.

**Not now: Intercom Fin.** Best-in-class resolution, but per-resolution billing
(~$0.99) + Intercom seats make it expensive and overkill pre-scale. Revisit as
the upgrade path once volume justifies it.

> Final vendor call is made at signup. Exact pricing/tiers must be confirmed then
> (they shift). The rest of this spec is written vendor-agnostic where possible;
> Crisp-specific steps are called out.

## 4. Knowledge base (the only real work item)

This is content curation, not engineering. The bot is only as good as what it's
pointed at, and a seed set already exists.

**Bot knowledge (publish into the vendor Help Center + let the bot crawl public pages):**

- `docs/help/connect-google-business.md`
- `docs/help/csv-import.md`
- `docs/help/response-pending.md`
- `docs/help/billing-past-due.md`
- `docs/help/brand-voice.md`
- Public marketing pages: `features`, `how-it-works`, `pricing`, `security`, `privacy`.

**Human-agent canned replies (not bot KB) — from `docs/support/macros/`:**

- `brand-voice.md`, `connect-google-business.md`, `csv-import.md`,
  `past-due-extension.md`, `response-pending.md`, `security-report.md`.

**Tasks:** review each article for customer-facing tone/accuracy, publish to the
vendor Help Center, configure the bot to also index the listed public URLs, and
load the macros as agent canned responses.

## 5. Surfaces & identity

- **One script tag**, loaded on public marketing pages **and** authenticated app
  pages.
- **For logged-in users, pass identity labels only:** name, email, plan /
  `account_id`, so conversations are attributable in the agent inbox.
- **Never pass to the vendor:** review text, response/draft text, approval
  tokens, MFA codes, or any secret. (Enforced by simply not wiring account data
  into the widget — see §1 non-goals.)

## 6. Escalation & the build-later checkpoint

**Escalation:** use the vendor's **native** human inbox + notifications (email +
mobile push). Do *not* rebuild notification plumbing. The existing
`notifyContactSubmission` / Telegram path stays as-is for the `/help/contact`
form. *Optional later:* forward escalations into the existing Telegram ops
channel via the vendor's webhook — only if wanted.

**Instrument from day one** (vendor analytics + a light open/escalate event):

- conversations per week,
- bot-resolved vs escalated rate,
- top question clusters,
- **share of escalations that are account-specific** ("why hasn't *my* review
  posted", "is *my* Google connected").

**Build trigger (discard-the-shortcut criteria) — build Option B only when ALL hold:**

1. Sustained volume (e.g. > N conversations/week for several weeks), **and**
2. A material share of escalations are account-specific questions the docs bot
   structurally cannot answer, **and**
3. We actively want account-aware answers and/or actions.

Until all three hold, stay bought.

## 7. Architecture invariants (preserved, not bent)

- **#1 (Vercel = UI only / LLM on Railway):** preserved — no LLM runs in our
  stack at all; the vendor hosts it. The widget is a client-side script tag.
- **#3 (No auto-posting):** untouched — the bot has zero access to the
  approval/posting path.
- **#6 (Third-party ingress on Railway):** not implicated — there is no inbound
  webhook from the vendor into our stack (escalation is vendor-native). If we
  later add the optional Telegram forward, it terminates on the worker, not
  Next.js.
- **Data privacy / logging rules:** only identity labels leave our system; no
  review/response text, tokens, or MFA codes.

## 8. Compliance (easy to miss)

A support vendor that ingests customer conversations is a **sub-processor**.
Before launch:

- add the vendor to `docs/legal/sub-processors` and the `/legal/sub-processors`
  page,
- confirm the privacy policy covers support-chat data and identity labels shared
  with the vendor.

Small task, real obligation for a data-conscious SaaS.

## 9. Non-goals

- No account-data integration.
- No access to the posting / approval path.
- No new Railway worker endpoints or Next.js LLM routes.
- No embeddings / RAG pipeline in our stack.
- No rebuilt notification/inbox plumbing.

## 10. Rollout sketch (high level — detailed plan comes next)

1. Sign up for the vendor; confirm tier + EU data residency.
2. Curate + publish the seed KB (§4); load agent macros.
3. Configure the bot (indexed URLs, tone, escalation rules, business hours).
4. Add the script tag to public + app layouts; pass identity labels for
   logged-in users.
5. Wire instrumentation (§6) and define the numeric build-trigger thresholds.
6. Update sub-processors + privacy policy (§8).
7. Soft-launch on the marketing site, then enable in-app.

## Success criteria

- Bot answers the seed-KB topics correctly on both surfaces.
- Unresolved chats reliably reach a human inbox with notification.
- Only identity labels (never review/response/secret data) reach the vendor.
- Instrumentation captures the four signals in §6 so the build-later checkpoint
  is a data decision, not a guess.
- Sub-processors + privacy policy updated before public launch.
