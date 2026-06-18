// Single authoritative source for the "minutes saved per handled response"
// heuristic. Both the lifetime value summary (service-mappers.ts /
// aggregate-service.ts) and the windowed reputation metrics (reputation-metrics.ts)
// derive from this constant, so the lifetime and windowed time-saved figures
// can never drift apart.
export const MINUTES_SAVED_PER_RESPONSE = 7;
