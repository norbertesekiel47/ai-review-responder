// The health-alert finding shape (#910 B3.1). ONE page-worthy fact: a stable
// key Sentry groups on, a level, a human title, and aggregate-only detail.
//
// It lives HERE — a zero-import leaf — because both layers speak it and the
// import direction must stay lib ← worker: the worker poller's checks
// (worker/background/pollers/health-alert/) produce findings, and the domain
// breaker evaluator (src/lib/solicitation/send-breaker.ts) returns one too.
// Before this leaf, send-breaker.ts type-imported it FROM the worker tree —
// a domain module depending on the poller that consumes it.

export interface HealthFinding {
  key: string;
  level: 'warning' | 'error';
  title: string;
  detail: Record<string, unknown>;
}
