# Spec 22 — AI/LLM Operations

> **Goal:** 50-review eval set in CI, prompt versioning, per-customer cost tracking, hallucination guardrails enforced both at prompt and output, brand voice tuned per-customer + per-language, audit log of every LLM call.

---

## 1. Why this matters

LLMs are non-deterministic dependencies on third-party APIs. Without eval, regressions ship silently. Without cost tracking, a single heavy customer can break unit economics. Without audit logs, disputes about "what AI said" are unwinnable.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- LLM client is `src/lib/responses/generator.ts` (`callLLMWithFallback`: OpenAI → Anthropic) — **not** `src/lib/llm/client.ts`/`models.ts` (those don't exist).
- ⚠️ **OpenAI model is UNVERSIONED** (`OPENAI_MODEL = 'gpt-4o-mini'`); Anthropic is pinned (`claude-haiku-4-5-20251001`). The spec's "pin model IDs" concern is **real and currently unmet** for OpenAI.
- **Cost tracking exists** as `api_costs` (`src/lib/costs/audit.ts` `recordApiCost`: provider/endpoint/input+output tokens/cost_usd/response_id/business_id) — no prompt hash, latency, or moderation score yet. ✅ **Decided (Step 0, 2026-05-23): extend `api_costs`** with `system_prompt_hash` / `latency_ms` / `moderation_score` rather than add a separate `llm_calls` table — avoids double-recording cost data. Shared home with [Spec 10](./10-trust-safety.md) moderation metadata.
- Cost-guard skill + designs exist (`.claude/skills/cost-guard.md`, `docs/plans/2026-05-0{3,9}-*`).
- **No eval set, no output moderation, no `brand_voices`, no cross-tenant injection test** — all greenfield. (`llm_calls` is intentionally not created — per-call audit metadata lives on `api_costs`, Step-0 decision.) Tenant-scoping invariant holds.

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
- ⚠️ Prompts are currently **inline** in `src/lib/responses/prompt-builder.ts` (no `src/lib/prompts/` dir). Extracting to version-controlled files (`system-base.md`, `per-vertical/*.md`) is net-new (shared with [Spec 10](./10-trust-safety.md) / [Spec 18](./18-i18n-localization.md)).
- Hash recorded per generation in `api_costs.system_prompt_hash` (Step-0 decision; same home as moderation metadata, [Spec 10](./10-trust-safety.md)).
- A/B testing via **PostHog feature flags** (Step-0 decision; GrowthBook rejected).
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
✅ **Decided (Step 0): extend `api_costs`, not a new `llm_calls` table.** `api_costs` already carries `id`, `account_id`, `business_id`, `response_id`, `provider`/`endpoint`, `input_tokens`/`output_tokens`, `cost_usd`, `created_at`. Add the audit/safety columns (next free migration after 042):
```sql
ALTER TABLE api_costs
  ADD COLUMN system_prompt_hash varchar,
  ADD COLUMN prompt_version     varchar,
  ADD COLUMN latency_ms         int,
  ADD COLUMN moderation_score   numeric,
  ADD COLUMN flagged            boolean DEFAULT false,
  ADD COLUMN output_excerpt     text;     -- first 200 chars only; full output reconstructable from `responses`
-- review_id / request_id already reachable via response_id → responses join
```
Retain ≥ 90 days (cost analysis + quality regression hunt). The existing `api_costs_daily_rollups` continues to aggregate cost; the new columns feed moderation ([Spec 10](./10-trust-safety.md)) and the gross-margin guard ([Spec 29 Gap 4](./29-repworth-specific-gaps.md)).

### Fallback model behavior
- **Eval set runs on both models weekly.**
- Side-by-side comparison report (`tests/llm-eval/reports/YYYY-Wxx.md`).
- If Claude Haiku quality drops > 10% below GPT-4o-mini, escalate fallback to **Claude Sonnet 4.6** instead.
- Track fallback rate. **> 5% indicates OpenAI reliability issue** — page P1.

### Cross-tenant leakage test
- Paranoid test: feed a prompt with deliberately injected cross-tenant data → assert generation **fails** (returns error or empty, not the leaked content).
- Runs nightly in CI.

## 4. Implementation tasks

1. Extend `api_costs` per §3 (next free migration number; head 042 — coordinate): add `system_prompt_hash`, `prompt_version`, `latency_ms`, `moderation_score`, `flagged`, `output_excerpt`. Step-0 decision — no separate `llm_calls`, no double-recording. Ensure an index on `(account_id, created_at)` exists.
2. Wrap the LLM client (`src/lib/responses/generator.ts`, **not** `src/lib/llm/client.ts`) to write the audit row on every call.
3. **Pin the OpenAI model** in `src/lib/responses/generator.ts` (currently `'gpt-4o-mini'` → `'gpt-4o-mini-2024-07-18'`); add a lint rule disallowing un-versioned aliases (enforcement needs CI — [Spec 24](./24-devops-deployment.md)).
4. Author 50-review eval set in `tests/llm-eval/eval-set.jsonl`.
5. Build eval runner `tests/llm-eval/run.ts`: iterates set, calls primary + fallback, scores per rubric, writes report.
6. Weekly CI job (`.github/workflows/llm-eval.yml`) runs eval set; fails on > 5% regression. **Requires GitHub Actions CI to exist first** ([Spec 24](./24-devops-deployment.md)).
7. Build OpenAI Moderation + regex output classifier (`src/lib/moderation/output-filter.ts`) — shared with [Spec 10](./10-trust-safety.md).
8. Implement per-customer monthly cost rollup → margin alert (the per-call `api_costs` data already exists; the rollup is the gap). Daily worker writes `account_llm_cost` (next free migration number; coordinate with [Spec 29 Gap 4](./29-repworth-specific-gaps.md)).
9. Implement cross-tenant injection test as `src/__tests__/llm-cross-tenant.test.ts` (Vitest collocated convention, per [Spec 03](./03-multitenancy-isolation.md)).
10. Document AI-disclosure approach for ToS / PP / in-product banner (cross-link to [Spec 17](./17-legal-compliance-docs.md)).
11. Build admin dashboard panel: top 10 customers by LLM cost, fallback rate, weekly eval score trend.

## 5. Acceptance criteria

- [ ] Every LLM call writes a full audit row on the extended `api_costs` (Step-0 decision) with all required fields (`api_costs` already captures tokens/cost/model per call).
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
- Code anchors: `src/lib/responses/generator.ts` (LLM client + fallback), `src/lib/responses/prompt-builder.ts` (inline prompt), `src/lib/costs/{audit,tracker}.ts` (`api_costs`)

## 9. Implementation in the current repo

- **The generator + fallback + cost capture already exist** (`generator.ts`, `api_costs`). The net-new AI-ops layer is: pin the OpenAI model, the eval set + runner, the full per-call audit (extend `api_costs` — Step-0 decision), output moderation, and the cross-tenant test.
- **Pinning the OpenAI model is a one-line, high-value fix** — it directly addresses the silent-regression risk the spec is built around.
- **Audit/moderation metadata home decided (Step 0): `api_costs`** (shared across Specs 10/22) — prompt hash + moderation score + cost live together on one table.
- **Eval runner + its weekly CI** are the bulk of the work and gated on CI ([Spec 24](./24-devops-deployment.md)); the runner reuses the existing `generator.ts` client against both providers.
- **Brand-voice + per-language** ride the `brand_voices` decision in [Spec 18](./18-i18n-localization.md); keep examples strictly `account_id`-scoped.

---
_Verified 2026-05-23 against migration head 042. Corrected the LLM-client path, the unpinned OpenAI model (real gap), the existing `api_costs` cost layer vs. the proposed `llm_calls`, the inline prompt location, migration numbering, and CI-gated eval._
