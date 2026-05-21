# Spec 22 — AI/LLM Operations

> **Goal:** 50-review eval set in CI, prompt versioning, per-customer cost tracking, hallucination guardrails enforced both at prompt and output, brand voice tuned per-customer + per-language, audit log of every LLM call.

---

## 1. Why this matters

LLMs are non-deterministic dependencies on third-party APIs. Without eval, regressions ship silently. Without cost tracking, a single heavy customer can break unit economics. Without audit logs, disputes about "what AI said" are unwinnable.

## 2. Current state (RepWorth)

- GPT-4o-mini primary; `claude-haiku-4-5-20251001` fallback (CLAUDE.md invariant — exact ID required).
- Cost guard skill: `.claude/skills/cost-guard.md`.
- Cost-guard LLM classifier design exists (`docs/plans/2026-05-03-cost-guard-llm-classifier-design.md`).
- Review generation engine design exists (`docs/plans/2026-05-09-review-generation-engine-design.md`).
- Architecture invariant: tenant scoping prevents cross-account context leaks.
- No documented eval set in repo.
- No `llm_calls` audit table mentioned.

## 3. Target state

### Model strategy
| Tier | Model | Why |
|---|---|---|
| Primary | `gpt-4o-mini-2024-07-18` (pinned) | Cheap, fast, multilingual |
| Fallback | `claude-haiku-4-5-20251001` (pinned) | Independent provider; comparable quality |
| Escalation (if fallback quality drops > 10%) | `claude-sonnet-4-6` | Higher cost, better quality |

**Pin model IDs explicitly.** Never use `gpt-4o-mini` (un-versioned alias) — silent regressions.

### Eval set
- **50-review eval set** checked into repo at `tests/llm-eval/eval-set.jsonl`.
- Diverse: star spectrum 1–5, sentiment positive/neutral/negative, lengths short/medium/long, languages (at least English; add language-specific sets when those launch).
- Each review has:
  - The raw review text + star + reviewer name.
  - A reference response written by a human (gold standard).
  - A rubric per row (expected tone, length range, must-include phrases, must-not-include phrases).

### Scoring rubric (per response)
| Dimension | Score | Method |
|---|---|---|
| Tone match (warm, professional, apologetic per context) | 0–5 | LLM-as-judge with spot-check |
| Length (within target 80–250 chars) | 0–5 | Programmatic |
| Brand voice match | 0–5 | LLM-as-judge |
| No forbidden patterns (price quotes, refund offers, competitors) | 0–5 | Regex + LLM |
| Accuracy (no invented facts) | 0–5 | Human-graded sample weekly |

**Aggregate ≥ 4.0/5 to pass.** Block model upgrade if any single dimension drops > 5% vs. prior baseline.

### Prompt versioning
- Prompts in version-controlled files: `src/lib/prompts/system-base.md`, `src/lib/prompts/per-vertical/*.md`.
- Hash recorded per generation in `llm_calls.system_prompt_hash`.
- A/B testing via PostHog feature flags or **GrowthBook**.
- Rollback = `git revert` + redeploy.

### Cost per response
- Track per generation: `prompt_tokens`, `completion_tokens`, `model`, `cost_usd_calculated`, `latency_ms`.
- **Target: < $0.05 per response on GPT-4o-mini.**
- Aggregate per customer monthly: if customer's LLM cost > 25% of MRR contribution → margin alert. Action: rate-limit, upsell, or improve prompt efficiency.

### Hallucination guardrails
**System prompt explicitly forbids:**
- Inventing details about the business.
- Promising refunds, discounts, compensation.
- Admitting legal fault.
- Referencing competitors negatively (or by name).
- Giving medical / legal / financial advice.
- Using profanity.

**Output classifier (Layer 2 — see [Spec 10](./10-trust-safety.md)):**
- OpenAI Moderation API.
- Regex for forbidden patterns.
- Block + flag for human review on high-confidence violations.

### Brand voice tuning
- **Prompt-engineered with example-shot from customer's past responses.**
- 5–10 owner-written responses stored per customer (per `brand_voices` table).
- Cheaper + faster + more controllable than fine-tuning.
- Per-language voice (see [Spec 18](./18-i18n-localization.md)).
- Optional RAG over customer's website / menu / services list for accuracy (year-2 feature).

### Audit log of every LLM call
**Table `llm_calls`** (migration **056**):
```sql
llm_calls(
  id uuidv7 PK,
  account_id uuid NOT NULL,
  business_id uuid,
  review_id uuid,
  response_id uuid,
  model varchar NOT NULL,
  system_prompt_hash varchar NOT NULL,
  prompt_version varchar,
  prompt_tokens int,
  completion_tokens int,
  cost_usd_calculated numeric(10,5),
  latency_ms int,
  moderation_score numeric,
  flagged boolean DEFAULT false,
  output_excerpt text, -- first 200 chars only, full output reconstructable from response
  request_id varchar,
  created_at timestamptz DEFAULT now()
);
```
Retain 90 days minimum (cost analysis + quality regression hunt).

### Fallback model behavior
- **Eval set runs on both models weekly.**
- Side-by-side comparison report (`tests/llm-eval/reports/YYYY-Wxx.md`).
- If Claude Haiku quality drops > 10% below GPT-4o-mini, escalate fallback to **Claude Sonnet 4.6** instead.
- Track fallback rate. **> 5% indicates OpenAI reliability issue** — page P1.

### Cross-tenant leakage test
- Paranoid test: feed a prompt with deliberately injected cross-tenant data → assert generation **fails** (returns error or empty, not the leaked content).
- Runs nightly in CI.

## 4. Implementation tasks

1. Migration **056**: `llm_calls` table per §3. Index `(account_id, created_at)`.
2. Wrap LLM client (`src/lib/llm/client.ts`) to write to `llm_calls` on every call. Use outbox if the response would be the durable side-effect.
3. Pin model IDs in `src/lib/llm/models.ts` constants. Lint rule disallowing un-versioned aliases.
4. Author 50-review eval set in `tests/llm-eval/eval-set.jsonl`.
5. Build eval runner `tests/llm-eval/run.ts`: iterates set, calls primary + fallback, scores per rubric, writes report.
6. Weekly CI job (`.github/workflows/llm-eval.yml`) runs eval set; fails on > 5% regression.
7. Build OpenAI Moderation + regex output classifier (`src/lib/moderation/output-filter.ts`).
8. Implement per-customer monthly cost rollup → margin alert. Daily worker writes to `account_llm_cost` (table + migration owned by [Spec 29 Gap 4](./29-repworth-specific-gaps.md), migration **059**).
9. Implement cross-tenant injection test in `tests/integration/llm-cross-tenant.spec.ts`.
10. Document AI-disclosure approach for ToS / PP / in-product banner (cross-link to [Spec 17](./17-legal-compliance-docs.md)).
11. Build admin dashboard panel: top 10 customers by LLM cost, fallback rate, weekly eval score trend.

## 5. Acceptance criteria

- [ ] Every LLM call writes a row to `llm_calls` with all required fields.
- [ ] 50-review eval set runs weekly in CI; current pass rate ≥ 4.0/5 aggregate.
- [ ] Model IDs pinned; lint blocks un-versioned aliases.
- [ ] Cross-tenant injection test passes.
- [ ] Output classifier blocks forbidden patterns; manual test of "I'll give you $50 off" is rejected.
- [ ] Per-customer monthly cost rollup runs; admin dashboard surfaces top spenders.
- [ ] Fallback rate alert wired in Sentry / BetterStack.
- [ ] AI-disclosure banner present at point-of-approval.

## 6. Metrics

| Metric | Target |
|---|---|
| Eval set aggregate score | ≥ 4.0/5 |
| Cost per response (median) | < $0.05 |
| Fallback rate | < 5% |
| Customers with LLM cost > 25% of MRR | Track + intervene |
| Moderation block accuracy (sample-graded) | > 95% true positives |
| LLM call latency p95 | < 8s |

## 7. Risks & mitigations

- **Risk:** OpenAI silently changes model behavior despite pinned ID. **Mitigation:** weekly eval catches regression; fallback to Anthropic ready.
- **Risk:** Cost spike from a single heavy customer. **Mitigation:** per-customer cost monitor → tier upsell or prompt-shrink.
- **Risk:** Output classifier blocks legitimate response. **Mitigation:** flagged ≠ blocked-from-owner-view; owner can override; weekly false-positive review.
- **Risk:** Brand-voice examples accidentally cross-leak. **Mitigation:** `brand_voices` strictly scoped by `account_id`; integration test asserts.

## 8. Dependencies & cross-links

- [Spec 03 — Multi-tenancy](./03-multitenancy-isolation.md) (cross-tenant invariant)
- [Spec 07 — Observability](./07-observability.md) (fallback rate alert)
- [Spec 10 — Trust & Safety](./10-trust-safety.md) (output classifier)
- [Spec 11 — Data, Analytics & BI](./11-data-analytics-bi.md) (cost rollup)
- [Spec 17 — Legal](./17-legal-compliance-docs.md) (AI disclosure)
- [Spec 18 — i18n](./18-i18n-localization.md) (per-language eval)
- Code anchors: `.claude/skills/cost-guard.md`, `docs/plans/2026-05-09-review-generation-engine-design.md`, `docs/plans/2026-05-03-cost-guard-llm-classifier-design.md`
- Invariant: model IDs (`gpt-4o-mini`, `claude-haiku-4-5-20251001`) per CLAUDE.md
