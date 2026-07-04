// Explicit LLM client construction options (deep-scan §5.1/§5.2). Without them
// the SDKs default to a 10-minute timeout and 2 internal retries: a provider
// stall could pin a GENERATE_RESPONSE worker for ~20 min/attempt, and the SDK's
// 2 retries stacked under BullMQ attempts:3 bill up to 6 real LLM attempts per
// logical generation (×2 providers). The 30s timeout bounds the wait; maxRetries:0
// makes the BullMQ + outbox-watchdog ladder the single source of retry truth —
// the transient/terminal classification in generate-draft.ts is unchanged
// (maxRetries:0 only stops the SDK's internal re-tries; the thrown error types
// isTransientLLMError keys on are identical). Guarded by client-options.test.ts.
export const LLM_CLIENT_OPTIONS = { timeout: 30_000, maxRetries: 0 } as const;
