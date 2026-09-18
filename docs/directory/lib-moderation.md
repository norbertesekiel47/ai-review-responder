## `src/lib/`

_A sibling page, on the `lib-owner-operator.md` precedent: `lib-reviews-responses.md` and `lib-platform.md` were both at the 3,000-word cap when the Safety review added two files to `moderation/`, so the whole folder moved here rather than any page being trimmed to fit. `moderation/` now has room to grow._

### `moderation/`

Output moderation for generated drafts — the always-on local regex filter, the optional OpenAI Moderation call, and the held-draft gate that makes a high-severity flag binding (invariant #4).

| File | What it does |
|------|--------------|
| `flags.ts` | `openaiModerationEnabled()` — `OPENAI_MODERATION_ENABLED` accessor over `readFlag` for the inline moderation path. Auto-approval's `providerModerationEnabled()` reads the same flag for a different gate; two named accessors over one flag is intentional. |
| `held-draft.ts` | The held-draft gate: `openFlagExistsSql(db, ref)` — the one composable spelling of "response has an OPEN `flagged_responses` row" (`'open'` is a literal, matching migration 051's partial index byte-for-byte) — `hasOpenFlag(tx, responseId)` (in-tx, post-lock), and `HeldForReviewError`. Every owner-facing release path must call it; admin, health-alert, purge and producer consumers stay deliberately separate (#725). |
| `moderate.ts` | Worker-only `moderateResponse(text)` — always runs the local filter; when `OPENAI_MODERATION_ENABLED` also calls `omni-moderation-latest` (10s timeout) and merges (provider flag → `high`). Never throws: a provider outage falls back to the local decision with `providerStatus: 'error'`. |
| `safety-review-schema.ts` | The Safety review's output contract: `SAFETY_CONCERNS`, `SafetyReviewOutputSchema` and the `SafetyVerdict` DTO (`cleared`, `concern`, `source`, `provider`). Split from `safety-review.ts` so `llm/tasks.ts` registers the schema without importing the worker-only module. Its `.refine` rejecting `cleared: true` **with** a named concern is the gate: `runLlmTask` validates shape only, and the auto-approval gate reads only `cleared`. The refine cannot survive JSON-Schema conversion, so it binds on `safeParse`, never in the provider grammar. |
| `safety-review.ts` | Worker-only `reviewSafety(sql, input, deps?, logger?)` — the LLM pass deciding whether a draft may enter the **Auto-approval lane**, catching implied unsafe content the provider classifier misses (G4-F1). Fails **CLOSED** and never throws: the draft is already paid for, so a retry would buy a second one. Deliberately NOT merged with `moderate.ts`, which fails OPEN and serves every draft. Three inversions of the triage cost shape, each closing a silent-clearance path — the file header names them. The literal `runLlmTask(` call lives in `defaultRunTask` because the caller tripwire greps that exact text. |
| `output-filter.ts` | `runOutputFilter(text)` — the local regex filter: word-boundaried rule table (refund/discount, legal fault, injection compliance, profanity → `high`; competitor, advice → `medium`) producing a `ModerationDecision` (`flagged`, `severity`, `reason`, `categories`, `score`, `source`, `providerStatus`). Also owns `SEVERITY_RANK`. |
