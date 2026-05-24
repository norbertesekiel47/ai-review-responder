# Spec 16 — Marketing & Growth

> **Goal:** Programmatic SEO landing pages, weekly long-form blog, referral by month 6, attribution end-to-end, lifecycle email separated from transactional, paid channel CAC tracked from day 1.

---

## 1. Why this matters

Marketing channel mix decides whether RepWorth is bootstrapped-profitable or runway-burning. For SMB SaaS, organic + referral are the gold-standard levers; paid amplifies once unit economics work. Without attribution, every channel claims credit and none earns it.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Landing + auth UI redesigned. No `/changelog`, no `/compare`, no programmatic SEO, no `/blog` (no MDX), no `src/app/lp/[slug]`.
- Resend is transactional-only (auth + contact). No Loops/Customer.io. **No PostHog** (attribution depends on it — [Spec 01 §2a](./01-product-market-fit.md)).
- No referral program / `referrals` table.
- **No structured UTM capture** — `owner_leads` (migration 033) has a single freetext `source`, no `utm_*` columns.
- Lead intake is built (`book-a-demo` → `LeadIntakeForm` → `owner_leads`).
- ⚠️ **No CI** — any UTM/attribution audit or CI gate is blocked on standing up GitHub Actions ([Spec 24](./24-devops-deployment.md)).

## 3. Target state

### SEO foundation — programmatic pages
**Templates** (start with 3, expand to 5+ over time):
- `/respond-to-google-reviews-for-{vertical}` (200+ verticals)
- `/{city}-reputation-management` (top 500 US cities)
- `/alternatives-to-{competitor}` (Birdeye, Podium, NiceJob, GoSite, Reputation.com)

**Quality bar**: each page must have unique, real content (not spun). Vertical or city-specific intro, vertical-specific testimonial (real or anonymized), vertical-specific FAQ. Generate via Next.js dynamic routes + a content store (`content/pages/*.mdx` or DB-backed).

Target: 200–500 pages within 12 months. **One organic signup/month per page within 12 months.**

### Content marketing — blog
- **1 long-form (1500+ words) SEO-targeted post / week.**
- Topics:
  - "How to respond to a 1-star review (templates)"
  - "What AI can and can't do for review management"
  - Vertical playbooks (dental, medspa, salon, etc.)
  - Customer success stories
  - Hot takes / opinion pieces
- Distribution: LinkedIn (highest converter for SMB-owners), Twitter/X, owner-focused newsletters/communities.
- CMS: MDX in repo (`content/blog/*.mdx`) — version-controlled, no CMS subscription needed.

### Changelog
- `/changelog` rendered from `docs/changelog/*.md`.
- "What's new" bell icon in dashboard surfaces last 5.
- RSS feed.

### Referral program (month 6)
- **Mechanic**: give-1-month, get-1-month. Each side gets 1 month free on their current tier when the referee converts to paid (tiers per [Spec 02](./02-pricing-packaging.md): basic/standard/premium/founders).
- In-product share link in dashboard footer + Settings → Refer.
- Attribution via signed referral tokens in URL (`?ref={hash}`).
- Token verified at signup; both accounts credited via Stripe Coupon (one-time discount).
- **Target: 15–20% of new MRR from referrals within 12 months.**

### Affiliate program (month 9, if growth justifies)
- **Rewardful** or **PartnerStack**.
- 20% recurring commission, 12-month attribution window.
- Recruit from SMB-marketing newsletters and YouTubers.
- Separate from referral program (different attribution, different mechanic).

### Paid acquisition (CAC tracked by channel)
- **Google Ads** on intent keywords: "respond to google reviews", "review management software", "google review responder".
- **Meta** retargeting from blog visitors.
- **Vertical newsletter** sponsorships (e.g., DentalTown, MedSpaInsider).
- UTM convention: `utm_source` (channel), `utm_medium` (paid/organic/referral), `utm_campaign` (slug), `utm_content` (creative variant), `utm_term` (keyword).
- **Target CAC payback ≤ 4 months.**

### Attribution
- **PostHog** end-to-end via UTM capture at signup → conversion event → revenue tag.
- Upgrade to **Dreamdata** or **HockeyStack** when paid spend > $10k/mo.

### Email marketing platform
- **Loops** or **Customer.io** for lifecycle + product emails — separate from Resend transactional.
- Marketing list lives in Loops.
- Segment by: lifecycle stage, vertical, tier, last_active.

### Landing page playbook
- Every paid campaign points to a dedicated landing page (no homepage).
- Match: ad creative → headline → form fields.
- One CTA per page.
- 90-day rotation per LP to refresh creative.

## 4. Implementation tasks

1. Build programmatic SEO infrastructure:
   - Next.js dynamic routes `src/app/respond-to-google-reviews-for/[vertical]/page.tsx`.
   - Content store in `content/seo/{verticals,cities,competitors}.json` (start with 20 entries each).
   - Page template with hero, vertical-specific intro, FAQ, CTA.
   - Sitemap.xml generation.
2. Author first 20 programmatic pages with real, unique content.
3. Author first 4 blog posts. Set up MDX rendering at `/blog/*`.
4. Build `/changelog` rendered from `docs/changelog/*.md`. RSS feed.
5. Build "What's new" bell + popover in dashboard.
6. Build referral program:
   - Migration (next free number; head 042 — coordinate per README): `referrals(id, referrer_account_id, referee_account_id, token_hash, created_at, converted_at, credited_at)`.
   - In-product Settings → Refer with shareable link.
   - URL-token capture on signup.
   - Stripe Coupon application on both sides at conversion.
7. UTM capture: add `utm_*` columns to `owner_leads` (today it has only a freetext `source`) and capture them at lead/signup.
8. ⚠️ ESP decision shared with [Spec 14](./14-customer-success-retention.md): the existing schedulers + Resend already send some lifecycle email. Either extend that or adopt Loops/Customer.io — decide once, in one place.
9. Set up Google Ads + Meta with conversion tracking back to the analytics tool chosen in [Spec 01 §2a](./01-product-market-fit.md) (PostHog not yet installed).
10. Build LP template `src/app/lp/[slug]/page.tsx` for paid campaigns.
11. Write `docs/marketing/utm-convention.md` and pin it.

## 5. Acceptance criteria

- [ ] 20+ programmatic SEO pages indexed by Google (verified via Search Console).
- [ ] 4+ long-form blog posts published; weekly cadence sustained for 2 months.
- [ ] `/changelog` live with RSS feed.
- [ ] Referral program live; first 5 referrals tracked end-to-end.
- [ ] UTM capture on every signup; PostHog acquisition channel report functional.
- [ ] Loops or Customer.io live with lifecycle sequences ([Spec 14](./14-customer-success-retention.md)).
- [ ] First Google Ads campaign live with conversion tracking.

## 6. Metrics

| Metric | Target |
|---|---|
| Organic signups / month / SEO page | ≥ 1 within 12 months |
| Blog post velocity | 1/week |
| Referral % of new MRR | ≥ 15–20% by month 12 |
| CAC payback (paid) | ≤ 4 months |
| Email lifecycle open rate | ≥ 35% |
| LP conversion rate (paid) | ≥ 5% |

## 7. Risks & mitigations

- **Risk:** Programmatic SEO flagged as spam by Google. **Mitigation:** real unique content per page; manual QA on first 50; throttle generation pace.
- **Risk:** Referral fraud (signups from same person). **Mitigation:** IP + device fingerprint dedup; manual review > $X threshold.
- **Risk:** Paid spend outruns LTV. **Mitigation:** CAC payback gate per channel; pause channel if payback > 6 months for 2 consecutive months.

## 8. Dependencies & cross-links

- [Spec 01 — PMF](./01-product-market-fit.md) (changelog, comparison page)
- [Spec 02 — Pricing](./02-pricing-packaging.md) (Stripe Coupons for referral)
- [Spec 11 — Data, Analytics & BI](./11-data-analytics-bi.md) (UTM events, attribution)
- [Spec 14 — Customer Success & Retention](./14-customer-success-retention.md) (lifecycle emails)
- [Spec 15 — Sales & GTM](./15-sales-gtm.md) (landing pages, demo environment)
- Code anchors: `src/app/(public)/*` (landing/marketing routes), `owner_leads` (migration 033), `src/lib/notifications/email/*` (Resend)

## 9. Implementation in the current repo

- **Programmatic SEO + blog + changelog + LP** are all net-new Next.js routes under `(public)/` — the `/changelog` and `/compare` builds are shared with [Spec 01](./01-product-market-fit.md). Use MDX in `content/` (no CMS).
- **Referral** is a `referrals` table + URL-token capture (reuse the SHA-256 hashed-token pattern from approval links) + Stripe Coupons (the billing path already creates Stripe objects — [Spec 02](./02-pricing-packaging.md)).
- **UTM** extends `owner_leads` (structured columns) rather than a new table; capture at the existing lead-intake/signup routes.
- **Attribution + lifecycle ESP** are the two cross-spec decisions (analytics → §2a; ESP → Spec 14) — don't resolve them locally here.

---
_Verified 2026-05-23 against migration head 042. Confirmed all marketing surfaces greenfield; corrected the Growth-tier referral mechanic, structured-UTM-vs-freetext-source, and routed attribution/ESP through the shared §2a / Spec 14 decisions._
