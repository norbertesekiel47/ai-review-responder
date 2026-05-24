# Spec 28 — Customer Communications & Brand

> **Goal:** DKIM/SPF/DMARC enforced, branded transactional + lifecycle emails, in-app changelog widget, maintenance comms 48h advance, breach notification template ready before needed.

---

## 1. Why this matters

Email deliverability is invisible until your domain reputation collapses. Customer-facing comms are brand surfaces — generic transactional emails feel like spam. Breach notification under GDPR Art. 33 has a 72-hour clock; you cannot write that template under pressure.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Email via **Resend** (`src/lib/notifications/email/client.ts`). Templates are **HTML-string TS functions** (`build*Html`) in `src/lib/notifications/email/templates/` (10 files) — **not** React Email `.tsx`.
- Lifecycle vs transactional today = **one Resend account with `category` tags** (transactional/marketing) + RFC-8058 `List-Unsubscribe` headers (`src/lib/notifications/email/headers.ts`) — **not** a separate tool/domain. The 4 schedulers send lifecycle via Resend.
- `email-deliverability.md` is in `docs/runbooks/completed_runbooks/`. DKIM/SPF/DMARC are external (DNS + Resend dashboard).
- **No** changelog widget, breach-notification runbook, maintenance-comms template, or `docs/brand/voice.md`.
- Footer: `List-Unsubscribe` header on `marketing` category only; address/privacy not yet in template bodies.

## 3. Target state

### Email deliverability
- **DKIM, SPF, DMARC all set to enforce** on the sending domain (`mail.repworth.com` or `repworth.com`).
- DMARC policy: `p=reject` after monitoring period.
- Domain warmed over 2 weeks before launch.
- Monitor reputation:
  - **Google Postmaster Tools** for Gmail recipients.
  - **Microsoft SNDS** for Outlook recipients.
- **Bounce rate < 2%**, spam complaint rate < 0.1%.
- Continue maintaining `docs/runbooks/email-deliverability.md`.

### Branded transactional emails
- Every transactional email matches product brand: logo, color palette, voice.
- Use **React Email** for templating (TypeScript-friendly, JSX-based, React components).
- Alternative: **Maizzle** (Tailwind-based, more designer-friendly).
- Test rendering in Gmail, Outlook (web + native), Apple Mail, mobile clients via **Litmus** or **Email on Acid** ($ but worth it pre-launch).
- Categories:
  - Welcome / email confirmation (with `{{ .Token }}` OTP per CLAUDE.md gotcha).
  - Approval requests (review draft + signed approval link).
  - Notifications (new low-rating review, draft awaits review).
  - Billing (invoice, payment failed, subscription change).
  - Dunning (days 1, 7, 14, 21 — see [Spec 05](./05-billing-subscription.md)).
  - Account: password reset, MFA recovery, invite, role change.
  - Lifecycle: welcome series, milestone, win-back ([Spec 14](./14-customer-success-retention.md)).

### Lifecycle vs. transactional separation
- **Today:** one Resend account separates them by `category` tag (transactional/marketing) + `List-Unsubscribe` on marketing only. This is a reasonable v1.
- **Decided (Step 0): lifecycle stays on Resend + schedulers** (ESP decision shared with [Spec 14](./14-customer-success-retention.md)/[Spec 16](./16-marketing-growth.md) — no Loops/Customer.io). Still split lifecycle vs. transactional onto a **separate sending domain/subdomain** (`team@repworth.com` vs `noreply@mail.repworth.com`) so a marketing spam complaint can't tank transactional reputation — that's a domain/DKIM split inside Resend, not a second vendor.

### In-app announcements / changelog widget
- **Bell icon** in dashboard top-right.
- Popover shows last 5 changelog entries (from `docs/changelog/*.md`).
- Tools: **Headway** (cheap, easy) or **Canny Changelog** (if Canny is already in use for feature requests, see [Spec 14](./14-customer-success-retention.md)).
- Alternative: hand-rolled component reading MDX from `docs/changelog/`.

### Maintenance comms
- **48-hour advance notice** for planned maintenance.
- Channels: in-product banner + email to all active users + status page.
- Template at `docs/runbooks/maintenance-comms-template.md`.
- Emergency maintenance: real-time status page update + email within 5 min.
- **Practice the comms template before you need it** — write it now.

### Breach notification (the template you hope to never use)
**`docs/runbooks/breach-notification.md`** with:
- **Assessment checklist**:
  - What data was exposed?
  - How many customers / users affected?
  - When did the breach occur / when discovered?
  - Is there ongoing risk?
- **GDPR 72-hour timer** starts at discovery — DPO (founder) notifies supervisory authority within 72h. EU customers within "reasonable" time (typically same window).
- **CCPA notice template**: California AG + affected customers if > 500 affected.
- **Customer email template**: what happened, what was exposed, what you've done, what they should do, your contact for questions.
- **Regulator contact list**: relevant state AGs (CA, NY, IL, TX, FL minimum), EU DPAs.
- **Insurance notification**: Cyber liability carrier within 24h ([Spec 17](./17-legal-compliance-docs.md)).
- **Forensics contact**: who you call (e.g., a IR firm — Mandiant, CrowdStrike, or smaller regional).

### Public incident comms
- **For P0/P1 incidents** (per [Spec 08](./08-reliability-sre.md)):
  - Status page update within 15 min.
  - Customer email within 30 min if customer-impacting.
  - Postmortem published within 5 business days; public-facing summary on blog.

### Brand voice (internal style guide)
- Documented in `docs/brand/voice.md`:
  - Tone: warm, direct, owner-to-owner.
  - "We say X, not Y" table (e.g., "use the product" not "leverage the platform").
  - Examples of good + bad copy.
- Cross-link to `repworth-brand-design` skill for visual brand.

### Customer-facing footer
On every public + transactional email:
- Address (required by CAN-SPAM).
- Unsubscribe link for non-transactional.
- Privacy policy link.
- Reply-to that lands in Help Scout.

## 4. Implementation tasks

1. Verify + enforce DKIM/SPF/DMARC. Tighten DMARC to `p=reject` after 2-week monitor.
2. Wire Google Postmaster + Microsoft SNDS.
3. ⚠️ Decide before migrating: current templates are **HTML-string functions** in `src/lib/notifications/email/templates/*.ts` (not `src/lib/email/templates/*.tsx`) and they work. React Email is a quality/maintainability upgrade, not a fix — migrate in place at the real path if pursued.
4. ESP decided (Step 0, shared with [Spec 14](./14-customer-success-retention.md)/[Spec 16](./16-marketing-growth.md)): stay on Resend + schedulers. Keep the category-tag split as v1; add a separate lifecycle sending domain/subdomain when volume justifies it. No Loops/Customer.io.
5. Build in-app changelog widget. Subscribe Headway or hand-roll MDX renderer.
6. Author `docs/runbooks/maintenance-comms-template.md`.
7. Author `docs/runbooks/breach-notification.md` with all sections per §3.
8. Author `docs/brand/voice.md` style guide.
9. Bind Cyber liability insurance ([Spec 17](./17-legal-compliance-docs.md)) — also a `breach-notification.md` dependency.
10. Test render: every transactional template across 5+ email clients via Litmus once.

## 5. Acceptance criteria

- [ ] DMARC at `p=reject` for 30 days without legit-mail bounces.
- [ ] Bounce rate < 2%; spam complaint rate < 0.1%.
- [ ] Every transactional email matches brand template; rendered correctly in Gmail, Outlook, Apple Mail.
- [ ] Lifecycle email on separate domain + tool.
- [ ] In-app changelog widget live; shows last 5 entries.
- [ ] `docs/runbooks/maintenance-comms-template.md` exists.
- [ ] `docs/runbooks/breach-notification.md` exists with all sections.
- [ ] `docs/brand/voice.md` exists.
- [ ] Email testing done in 5 clients pre-launch.

## 6. Metrics

| Metric | Target |
|---|---|
| Bounce rate | < 2% |
| Spam complaint rate | < 0.1% |
| Open rate (transactional) | ≥ 60% |
| Open rate (lifecycle) | ≥ 35% |
| Status page update lag on P0 | < 15 min |
| Breach notification timer (GDPR) | < 72h |

## 7. Risks & mitigations

- **Risk:** Marketing reputation damages transactional deliverability. **Mitigation:** separate domain + tool.
- **Risk:** Breach notification template stale. **Mitigation:** annual review; tabletop exercise.
- **Risk:** Generic transactional emails feel spammy. **Mitigation:** React Email templates + brand voice guide.

## 8. Dependencies & cross-links

- [Spec 05 — Billing](./05-billing-subscription.md) (dunning emails)
- [Spec 08 — Reliability](./08-reliability-sre.md) (status page, incident comms)
- [Spec 09 — Security & Compliance](./09-security-compliance.md) (breach response)
- [Spec 14 — Customer Success](./14-customer-success-retention.md) (lifecycle emails)
- [Spec 17 — Legal & Compliance Docs](./17-legal-compliance-docs.md) (insurance, sub-processors)
- Code anchors: `docs/runbooks/email-deliverability.md`, Resend integration in worker
- Gotcha: confirmation email uses `{{ .Token }}` (6-digit OTP), reset links need `&amp;` not `&` in href (CLAUDE.md) — note that template is **Supabase-managed**, not in `src/lib/notifications/email/templates/`
- Code anchors: `src/lib/notifications/email/{client,headers}.ts`, `src/lib/notifications/email/templates/*.ts`, `docs/runbooks/completed_runbooks/email-deliverability.md`

## 9. Implementation in the current repo

- **Email plumbing exists** (Resend client, 10 HTML templates, category tags, List-Unsubscribe headers, deliverability runbook). The net-new work is mostly **documents** (breach-notification, maintenance-comms, brand voice) + **brand polish** of templates + the **changelog widget**.
- **Changelog widget** reads the same `docs/changelog/*.md` built once for [Spec 01](./01-product-market-fit.md)/[Spec 16](./16-marketing-growth.md); the bell lives in the dashboard `TopBar`.
- **React Email migration is optional** — current HTML-string templates render fine; treat it as a maintainability upgrade at the real path, not a prerequisite.
- **Breach-notification + maintenance-comms** are write-now-use-later runbooks; pair the breach doc with the Cyber insurance binding ([Spec 17](./17-legal-compliance-docs.md)).
- **Footer compliance** (CAN-SPAM address, privacy link) should move into the shared template wrapper (`templates/shared.ts`), not per-template.

---
_Verified 2026-05-23 against migration head 042. Corrected the email-template format (HTML strings, not React Email) + path, the single-Resend category-tag lifecycle split, the runbook location, and confirmed changelog/breach/maintenance/voice docs absent._
