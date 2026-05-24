# Spec 25 — Documentation

> **Goal:** ADRs for every load-bearing decision, public Mintlify docs site for customers, CI-tested docs (no broken links or stale code), `CONTEXT.md` at repo root for new contributors, versioned per major API release.

---

## 1. Why this matters

Documentation is leverage. Strong internal docs cut onboarding from weeks to days. Strong external docs cut support tickets and unlock prospects who self-evaluate without a demo.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Strong runbook coverage (`docs/runbooks/*`); architecture docs `CLAUDE.md`, `docs/currents.md` (large), `docs/directory.md`.
- ✅ **`docs/adr/` already exists — with one ADR**: `0001-nextjs-oauth-handshake-carveout.md` (referenced in CLAUDE.md). The spec's "no docs/adr/" is wrong, and its proposed **ADR 0001 = outbox collides** — the bootstrap ADRs must start at **0002** (§3).
- No public docs site (`docs.repworth.com`); no Mintlify/lychee/cspell.
- No `CONTEXT.md` at repo root (`docs/agents/domain.md` expects it but degrades gracefully).
- No `docs/changelog/`.
- ✅ **Base CI now exists** — the first secret-free GitHub Actions gate runs `lint`, `typecheck`, `test`, and `build`. Docs CI (lychee/cspell/snippet exec and docs previews) remains a pending specialized workflow ([Spec 24](./24-devops-deployment.md)).

## 3. Target state

### Internal documentation

**Architecture Decision Records (ADRs):**
- Location: `docs/adr/NNNN-<title>.md`.
- Template: context → decision → consequences → alternatives considered.
- **ADRs are immutable**: deprecate via new ADR, don't edit old.
- Numbered sequentially. Pin filename even if title changes.

**Bootstrap ADRs (load-bearing decisions to capture now).** ⚠️ **`0001` is already taken** (`0001-nextjs-oauth-handshake-carveout.md`) — number these **0002 onward**:
- 0002 — Transactional outbox pattern for state + downstream work.
- 0003 — Approval token hashing (SHA-256, raw only in memory + email).
- 0004 — Stripe-first tier change pattern; base-item fallback removed.
- 0005 — Multi-location: businesses (location) vs. accounts (billing parent) split.
- 0006 — Two Postgres clients (Postgres.js for writes, Supabase JS for reads/auth).
- 0007 — Two Redis instances (Upstash cache + Upstash BullMQ queue).
- 0008 — LLM model strategy: GPT-4o-mini primary + Claude Haiku fallback (⚠️ pin the OpenAI ID — currently unversioned, see [Spec 22](./22-ai-llm-ops.md)).
- 0009 — UUIDv7 for all primary keys.
- 0010 — JSONB via Postgres.js `jsonb()` helper (avoids double-encoding gotcha).
- 0011 — ReviewSource → NormalizedReview DTO contract.
- 0012 — Tenant isolation: app-enforced + RLS defense in depth (service-role writes bypass RLS — [Spec 03](./03-multitenancy-isolation.md)).
- 0013 — Entry-points orchestrate; modules own failure behavior.

**Runbooks** (already strong — maintain pattern):
- `docs/runbooks/*` for every operational scenario.
- New runbook required when a new alert is created (per [Spec 07](./07-observability.md)).

**`CONTEXT.md` at repo root** (referenced by domain skill):
- Single-context overview: what RepWorth is, how to set up, key invariants, who to ask for what.
- Bootstrap with sections: Product, Architecture, Setup, Key Files, Key Patterns, Key Gotchas, Who to Ask.

**Onboarding doc** (per [Spec 27](./27-team-knowledge.md)):
- `docs/onboarding/new-hire.md`: local dev setup, runbook tour, week-1 task, access checklist.

### External documentation

**Mintlify at `docs.repworth.com`:**
- Customer-facing.
- Combines API docs ([Spec 20](./20-api-integrations.md)), integration guides, knowledge base articles, video embeds.
- SEO-indexed.
- Top 5 KB articles (highest traffic, drives self-serve resolution):
  1. How to connect Google Business Profile
  2. Why is my response pending?
  3. How to set brand voice
  4. Pricing & billing FAQ
  5. Multi-location setup
- Versioned per major API release.

**Public-facing pages on app domain:**
- `/changelog` — markdown-rendered changelog (from `docs/changelog/*.md`).
- `/security` — security posture summary.
- `/legal/*` — legal docs ([Spec 17](./17-legal-compliance-docs.md)).
- `/trust` — trust center ([Spec 29](./29-repworth-specific-gaps.md)).

### Documentation CI

- **`lychee`** or **`markdown-link-check`** in CI — fails on broken internal/external links.
- **Code-snippet executor**: snippets marked with language hint run in CI; break the build if out of date. Use **mdsh** or hand-rolled extractor.
- **Spell-check**: `cspell` with project-specific dictionary.
- Renders preview on PR for docs-only changes.

### Documentation versioning

- API docs versioned per major (`v1`, `v2`...). Sunset policy: 12-month notice for breaking changes.
- KB articles undated; major revisions logged in article footer.
- ADRs immutable; superseded ADRs explicit.

### Cross-references

- `CLAUDE.md` (project) → `CONTEXT.md` (general) — keep in sync, divergence triggers update.
- Every spec in `docs/sass_ready/` cross-links related specs.
- ADRs link to relevant code paths.

## 4. Implementation tasks

1. `docs/adr/` already exists (with `0001-nextjs-oauth-handshake-carveout.md`). Add a `docs/adr/_template.md`; the `manage_adr` MCP tool is available.
2. Author the 12 bootstrap ADRs (numbered **0002–0013** per §3, since 0001 is taken). ~30–60 min each; short (context, decision, consequences in 200–400 words).
3. Author `CONTEXT.md` at repo root. Sections: Product, Architecture, Setup, Key Files, Key Patterns, Key Gotchas, Who to Ask. Cross-link CLAUDE.md gotchas (don't duplicate — link).
4. Subscribe Mintlify. Set up `docs.repworth.com`. Initial 5 articles.
5. Wire `lychee` or `markdown-link-check` into a docs-specific CI job. Initial pass; fix broken links. **Requires extending the base CI with docs CI** ([Spec 24](./24-devops-deployment.md)).
6. Add `cspell` to CI. Build project dictionary in `cspell.json`. (Also CI-gated.)
7. Build `/changelog` page rendered from `docs/changelog/*.md`. RSS.
8. Code-snippet CI: pick **mdsh** or simple hand-rolled extractor. Cover top 5 KB articles.
9. Add docs-only preview rendering for Mintlify on PR.
10. Quarterly docs review: every doc author owns the "is this still true?" check on their section.

## 5. Acceptance criteria

- [ ] `docs/adr/` populated with the 12 bootstrap ADRs (numbered 0002–0013; 0001 already exists).
- [ ] `CONTEXT.md` exists at repo root.
- [ ] `docs.repworth.com` live with first 5 KB articles.
- [ ] `lychee` + `cspell` in CI; first pass green.
- [ ] `/changelog` page live with RSS.
- [ ] Code-snippet CI executes snippets on top 5 articles.
- [ ] Docs-review calendar entry exists; first review completed.

## 6. Metrics

| Metric | Target |
|---|---|
| Broken-link count | 0 in CI |
| ADR count (one per load-bearing decision) | 12 + 1 per quarter |
| Mintlify docs site organic traffic | Tracked; goal ≥ 1k/mo within 6 months |
| Self-serve resolution from KB | ≥ 60% of new tickets ([Spec 13](./13-customer-support.md)) |
| Docs page age (avg) | < 6 months |

## 7. Risks & mitigations

- **Risk:** ADRs become a write-only graveyard. **Mitigation:** every architectural decision PR template asks "Does this need an ADR?"; quarterly review.
- **Risk:** `CONTEXT.md` and `CLAUDE.md` drift. **Mitigation:** CONTEXT.md links to CLAUDE.md for invariants/gotchas — single source of truth; CONTEXT.md is the human-readable wrapper.
- **Risk:** Mintlify cost. **Mitigation:** start on free tier; upgrade when traffic justifies.

## 8. Dependencies & cross-links

- [Spec 13 — Customer Support](./13-customer-support.md) (KB articles)
- [Spec 17 — Legal](./17-legal-compliance-docs.md) (legal docs hosting)
- [Spec 20 — API & Integrations](./20-api-integrations.md) (API reference)
- [Spec 27 — Team & Knowledge](./27-team-knowledge.md) (onboarding doc)
- [Spec 29 — RepWorth Gaps](./29-repworth-specific-gaps.md) (Trust center)
- Code anchors: `docs/runbooks/`, `docs/currents.md`, `docs/directory.md`
- Existing skill: `docs/agents/domain.md` (already supports CONTEXT.md when present)
- Code anchors: `docs/adr/0001-nextjs-oauth-handshake-carveout.md` (existing), `docs/{currents,directory}.md`, `.claude/skills/migrations.md`, `manage_adr` MCP tool

## 9. Implementation in the current repo

- **ADRs are partly underway** — the directory + `0001` exist; the work is the 12 bootstrap ADRs at **0002–0013** (use `manage_adr`). Capture decisions already made and verified across this spec set (outbox, token hashing, two-client split, tenant model, etc.).
- **`CONTEXT.md`** is the cheapest high-value doc — `docs/agents/domain.md` already looks for it. Make it a thin human-readable wrapper that *links* CLAUDE.md invariants/gotchas (don't duplicate).
- **`/changelog`** is shared with [Spec 01](./01-product-market-fit.md)/[Spec 16](./16-marketing-growth.md) — build once.
- **Docs CI** (lychee/cspell/snippet) is a specialized follow-up on top of the secret-free base CI ([Spec 24](./24-devops-deployment.md)); Mintlify is third-party signup shared with [Spec 13](./13-customer-support.md)/[Spec 20](./20-api-integrations.md).
- **`docs/currents.md` is very large** — consider whether CONTEXT.md should summarize/point into it rather than readers loading it whole.

---
_Verified 2026-05-23 against migration head 042. Corrected the already-existing `docs/adr/` + `0001` collision (bootstrap ADRs renumbered 0002–0013), confirmed CONTEXT.md/changelog absent, and flagged docs CI as a pending specialized workflow beyond the secret-free base CI._
