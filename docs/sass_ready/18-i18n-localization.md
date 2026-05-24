# Spec 18 — Internationalization & Localization

> **Goal:** Architect for i18n now (string extraction), ship English-only for 12 months, multi-language **AI response generation** (the bigger lever than UI translation), USD-only billing.

---

## 1. Why this matters

i18n migrations are 10× harder after launch. Architecting for extraction costs little now and unblocks language expansion when the customer-evidence supports it. For RepWorth specifically, the larger lever is **multi-language response generation**, not UI translation — owners are usually fluent in business English but their reviewers may be Spanish, French, or Portuguese speakers.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- UI strings hard-coded in JSX; `next-intl` not installed; no `messages/en.json`.
- LLM prompts in English, built inline in `src/lib/responses/prompt-builder.ts` (there is **no** `src/lib/prompts/` dir).
- ✅ **`reviews.detected_language` already exists** (migration 001) — but the ingest path (`worker/jobs/zernio/zernio-ingest-shared.ts`) writes it as **NULL**. The gap is *populating* it, not adding the column.
- Brand voice stored on `businesses` (`tone`, `sample_responses TEXT[]`) — **no `brand_voices` table, no per-language support**.
- `Intl.DateTimeFormat`/`Intl.NumberFormat` partially used (~35 sites); no centralized layer.
- Billing in USD. No documented language eval set.

## 3. Target state

### UI i18n (architecture now, translation later)
- Adopt **`next-intl`** as the string-extraction layer.
- All user-facing strings in `messages/en.json` (or per-namespace files).
- Ship **English-only** for 12 months.
- Cost of waiting: zero (no translation contract). Cost of not architecting: huge (manual extraction of hundreds of strings later).

### Language priority order (when triggered)
- **Trigger**: 50+ paying customers requesting same language, OR enterprise deal requiring localization.
- Order:
  1. Spanish (US Hispanic market + LATAM expansion)
  2. French (Canada)
  3. Portuguese (Brazil)
  4. German
  5. Italian
- Use **Crowdin** or **Lokalise** for translation management.

### AI response generation in multiple languages
- **Both GPT-4o-mini and Claude Haiku handle Spanish, French, German, Italian, Portuguese, Japanese natively.**
- Detect review language with cheap language-detection (`@vscode/vscode-languagedetection` or LLM classifier on first 100 chars).
- Inject language into prompt: "Respond in {{detected_language}} unless the owner's brand voice settings say otherwise."
- **Brand voice tuning must be language-aware.** Don't apply English brand voice examples to a Spanish response. Store brand voice examples per language in `brand_voices(account_id, language, examples)`.

### Per-language eval
- 20-review eval set per language (Spanish + French + Portuguese + German + Italian launch set).
- Run weekly in CI when language support active.
- Human-graded once per quarter (or use LLM-as-judge with spot-check).
- Block model upgrade if any language quality drops > 5%.

### Currency
- **USD only for the first 12 months.** Stripe presents in customer's local currency at checkout (which is sufficient for SMB international).
- Multi-currency billing (charging in EUR/GBP) when EU revenue > 20%.

### Tax
- Stripe Tax handles 50+ jurisdictions automatically.
- Quarterly nexus review (see [Spec 05](./05-billing-subscription.md)).

### Customer support
- **English-only, US business hours (9–6 ET), 24h SLA for non-urgent.**
- Add Spanish at 100 Hispanic-market customers.
- Avoid 24/7 commitments until 10+ support agents.

### Date / number / time formatting
- Use `Intl.DateTimeFormat` and `Intl.NumberFormat` from day 1.
- Respect user's browser locale for display, even when content is in English.
- Server-side: log timestamps in UTC, display in user's TZ (configurable per user).

### Accessibility implication
- RTL support deferred until Arabic/Hebrew language considered (year 2+).
- `next-intl` supports RTL when needed.

## 4. Implementation tasks

1. Add `next-intl` to project. Wrap root layout in `<NextIntlClientProvider>`.
2. Extract all hard-coded user-facing strings into `messages/en.json`. Start with top-traffic pages (landing, login, signup, dashboard home, settings).
3. Add ESLint rule banning user-facing string literals in JSX (custom rule or `eslint-plugin-i18n-text`) — enforcement needs CI ([Spec 24](./24-devops-deployment.md)).
4. **Populate the existing `reviews.detected_language` column** (no migration needed — it exists but `zernio-ingest-shared.ts` writes NULL). Add cheap language detection in the ingest path and write ISO-639-1.
5. Update the inline prompt builder `src/lib/responses/prompt-builder.ts` (not `src/lib/prompts/`) to accept a `language` variable and instruct the response in that language.
6. Add per-language brand voice. Current voice lives on `businesses` (`tone`, `sample_responses`); either add a `brand_voices(account_id, language, examples)` table or language-keyed columns (next free migration number; head 042 — coordinate). Plus Settings → Brand Voice UI.
7. Author 20-review eval set in `tests/llm-eval/sets/{es,fr,pt,de,it}.jsonl`. Run weekly in CI behind feature flag.
8. Confirm Stripe presents local-currency checkout. Test in 3 EU countries.
9. Adopt `Intl.DateTimeFormat` + `Intl.NumberFormat` across all date/number rendering.
10. Document language-launch playbook in `docs/runbooks/language-launch.md`.

## 5. Acceptance criteria

- [ ] `next-intl` integrated; all hard-coded strings on top-5 pages extracted.
- [ ] ESLint blocks new string literals in JSX.
- [ ] `reviews.detected_language` populated on every ingested review (column exists; ingest currently writes NULL).
- [ ] Brand-voice settings support per-language examples.
- [ ] Eval set files exist for 5 languages; CI runs them when feature flag on.
- [ ] Stripe checkout shows local currency for EU test cards.
- [ ] `Intl.*` formatters used consistently (lint-checked).

## 6. Metrics

| Metric | Target |
|---|---|
| String-extraction coverage | 100% on top-5 pages within 60 days |
| Per-language response quality (vs. English baseline) | Within 5% on eval rubric |
| Per-language adoption (when launched) | ≥ 30% of non-English reviews receive language-matched response |

## 7. Risks & mitigations

- **Risk:** Language-detection misclassifies short reviews. **Mitigation:** confidence threshold (< 0.7 → default to brand-voice language); spot-check weekly.
- **Risk:** Brand voice in Language A leaks tone from Language B examples. **Mitigation:** per-language examples required; explicit fallback rule documented.
- **Risk:** Currency mismatch creates accounting headache. **Mitigation:** keep USD-only billing until EU 20% threshold; if you cross it, multi-currency is one Stripe project change.

## 8. Dependencies & cross-links

- [Spec 02 — Pricing](./02-pricing-packaging.md) (currency policy)
- [Spec 05 — Billing](./05-billing-subscription.md) (Stripe Tax, currency)
- [Spec 19 — Accessibility](./19-accessibility.md) (RTL future)
- [Spec 22 — AI/LLM Operations](./22-ai-llm-ops.md) (per-language eval)
- Code anchors: `src/lib/responses/prompt-builder.ts` (inline prompt), `worker/jobs/zernio/zernio-ingest-shared.ts` (writes `detected_language` NULL), `reviews` schema (migration 001), `businesses.{tone,sample_responses}`

## 9. Implementation in the current repo

- **The detected-language column already exists** — the only ingest change is to detect + write it (the `NormalizedReview` DTO flows through `zernio-ingest-shared.ts`). No migration.
- **Multi-language generation** is the high-value lever and rides the existing pipeline: pass `detected_language` into `prompt-builder.ts`; the LLM client (`generator.ts`, gpt-4o-mini/claude-haiku) already handles these languages.
- **Per-language brand voice** is the one schema change — extend `businesses` or add `brand_voices`; keep the `ReviewSource → NormalizedReview` contract intact (no source-specific fields in the prompt builder).
- **`next-intl` + the ESLint string-literal rule** are net-new; the rule's enforcement is CI-gated ([Spec 24](./24-devops-deployment.md)).

---
_Verified 2026-05-23 against migration head 042. Corrected the already-existing `detected_language` column (populate, don't add), the inline prompt path (`prompt-builder.ts`, not `src/lib/prompts/`), brand-voice storage reality, and migration numbering._
