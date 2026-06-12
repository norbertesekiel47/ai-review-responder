/**
 * Readiness probes (deep-scan §2.5). `/api/health` (web) and `/api/health`
 * (worker) are liveness-only by contract; the readiness endpoints verify the
 * process can actually serve — Postgres reachable, Redis answering PING —
 * and return 503 when a critical dependency is down.
 *
 * Per production.md: every probe has an explicit timeout so the readiness
 * route itself can never hang, and a probe failure (including "client not
 * configured") marks the dependency failed instead of throwing.
 */

const READINESS_PROBE_TIMEOUT_MS = 2_000;

export interface DependencyProbe {
  name: string;
  /** Resolves when the dependency answered; any rejection marks it failed. */
  probe: () => Promise<unknown>;
}

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, 'ok' | 'failed'>;
}

async function withTimeout(work: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runReadinessProbes(
  probes: DependencyProbe[],
  timeoutMs: number = READINESS_PROBE_TIMEOUT_MS,
): Promise<ReadinessResult> {
  const entries = await Promise.all(
    probes.map(async ({ name, probe }): Promise<[string, 'ok' | 'failed']> => {
      try {
        // probe() is called inside the try so a synchronous throw (e.g. an
        // unconfigured client factory) also counts as a failed dependency.
        await withTimeout(probe(), timeoutMs);
        return [name, 'ok'];
      } catch {
        return [name, 'failed'];
      }
    }),
  );

  const checks = Object.fromEntries(entries);
  return { ready: entries.every(([, status]) => status === 'ok'), checks };
}
