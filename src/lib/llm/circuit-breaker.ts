import * as Sentry from '@sentry/node';
import { createWorkerLogger } from '../shared/logger';
import { isTransientLLMError } from './error-classifier';
import { llmCircuitBreakerEnabled } from './flags';
import type { LLMProviderId } from './types';

// The LLM provider circuit breaker: an in-process, per-provider breaker in the
// src/lib/llm seam. It trips after FAILURE_THRESHOLD consecutive transient
// failures, stays open for OPEN_DURATION_MS, then admits exactly one half-open
// probe. Single-threaded Node makes probe admission race-free WITHIN a tick,
// but up to ~9 LLM jobs interleave across awaits against this shared singleton,
// so an outcome can arrive after the breaker has already transitioned. Every
// attempt therefore carries an Admission token stamped with the provider's
// epoch AT ADMISSION; recordAttempt applies an outcome only when that epoch is
// still current (stale outcomes are ignored — see Admission). State is
// process-local (effectively global only under single-replica, per ADR 0005).

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 30_000;

type BreakerState = 'closed' | 'open' | 'half_open';

interface ProviderState {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  probeInFlight: boolean;
  /** Monotonic per-provider counter; bumped on every REAL state change. It
   *  correlates an outcome with the state its attempt was admitted under. */
  epoch: number;
}

/**
 * The token shouldAttempt hands back when (and only when) the caller may call
 * the provider. It records the provider's epoch at admission time so
 * recordAttempt can tell whether the outcome still applies to the state the
 * attempt was admitted under: an outcome whose epoch no longer matches the
 * provider's current epoch is stale (the breaker has since transitioned) and
 * must never mutate state — otherwise a slow pre-trip success could close the
 * breaker DURING its cooldown and re-flood a just-tripped provider. While the
 * breaker is disabled shouldAttempt still returns a token (so the caller calls
 * the provider), but recordAttempt short-circuits on the disabled check before
 * it ever reads the token.
 */
export interface Admission {
  provider: LLMProviderId;
  epoch: number;
}

function freshProviderState(): ProviderState {
  return { state: 'closed', consecutiveFailures: 0, openedAt: 0, probeInFlight: false, epoch: 0 };
}

const logger = createWorkerLogger('[llm:circuit-breaker]');

export class LlmCircuitBreaker {
  private readonly now: () => number;
  private readonly enabledOverride?: boolean;
  private readonly providers = new Map<LLMProviderId, ProviderState>();

  constructor(opts?: { now?: () => number; enabled?: boolean }) {
    this.now = opts?.now ?? Date.now;
    this.enabledOverride = opts?.enabled;
  }

  /** Live per-call read: a test override wins, otherwise the flag accessor.
   *  Read on EVERY shouldAttempt/recordAttempt — never cached at construction —
   *  so a mid-process toggle of LLM_CIRCUIT_BREAKER_ENABLED takes effect at once
   *  (invariant #13 / ci:process-env; the flag is server-authoritative). */
  private isEnabled(): boolean {
    return this.enabledOverride ?? llmCircuitBreakerEnabled();
  }

  private get(provider: LLMProviderId): ProviderState {
    let current = this.providers.get(provider);
    if (!current) {
      current = freshProviderState();
      this.providers.set(provider, current);
    }
    return current;
  }

  shouldAttempt(provider: LLMProviderId): Admission | null {
    if (!this.isEnabled()) {
      // Disabled: drop any tracked state so a disable→enable toggle within one
      // process cannot resurrect a stuck half_open + probeInFlight. A non-null
      // token is returned so the caller still calls the provider; recordAttempt
      // ignores its outcome (the disabled check short-circuits before the epoch
      // is read, so the sentinel epoch is never compared).
      this.providers.delete(provider);
      return { provider, epoch: -1 };
    }

    const entry = this.get(provider);
    if (entry.state === 'closed') return { provider, epoch: entry.epoch };

    if (entry.state === 'open') {
      if (this.now() - entry.openedAt >= OPEN_DURATION_MS) {
        // Cooldown elapsed: move to half-open (bumps epoch) and claim the single
        // probe. The token carries the NEW post-transition epoch.
        this.transition(provider, entry, 'half_open');
        entry.probeInFlight = true;
        return { provider, epoch: entry.epoch };
      }
      return null;
    }

    // half_open: admit only the caller that can claim the (single) probe.
    if (!entry.probeInFlight) {
      entry.probeInFlight = true;
      return { provider, epoch: entry.epoch };
    }
    return null;
  }

  recordAttempt(admission: Admission, error?: unknown): void {
    if (!this.isEnabled()) return;

    // Non-materializing lookup: a missing entry means the state was cleared
    // (reset / disable) after the attempt was admitted, so the outcome is stale
    // by definition — do not re-create the entry for an outcome we will ignore.
    const entry = this.providers.get(admission.provider);
    // Stale outcome: the attempt was admitted under a prior state and the
    // breaker has since transitioned. Applying it would let e.g. a slow
    // pre-trip success close the breaker mid-cooldown, or a superseded probe
    // outcome resolve the wrong open cycle. Ignore it silently — no transition,
    // no counter mutation.
    if (entry === undefined || admission.epoch !== entry.epoch) return;

    const provider = admission.provider;
    const success = error === undefined;
    const transientFailure = !success && isTransientLLMError(error);
    const nonTransientFailure = !success && !transientFailure;

    if (success || (nonTransientFailure && entry.state === 'half_open')) {
      // A reachable provider ends the outage.
      entry.consecutiveFailures = 0;
      entry.probeInFlight = false;
      this.transition(provider, entry, 'closed');
      return;
    }

    if (transientFailure) {
      if (entry.state === 'half_open') {
        // Probe confirmed the outage: re-open for another cooldown.
        entry.openedAt = this.now();
        entry.probeInFlight = false;
        this.transition(provider, entry, 'open');
        return;
      }
      // closed: count toward the trip threshold.
      entry.consecutiveFailures++;
      if (entry.consecutiveFailures >= FAILURE_THRESHOLD && entry.state !== 'open') {
        entry.openedAt = this.now();
        this.transition(provider, entry, 'open');
      }
      return;
    }

    // nonTransientFailure while closed: not the breaker's concern — ignore.
  }

  /** Clear all per-provider state. The enabled flag is read live per-call, so
   * there is nothing to re-read here. */
  reset(): void {
    this.providers.clear();
  }

  /** Read-only snapshot for observability and tests. `undefined` ⇒ no state is
   *  tracked for the provider yet (fresh / just-cleared). Does not mutate. */
  inspect(provider: LLMProviderId): Readonly<ProviderState> | undefined {
    const entry = this.providers.get(provider);
    return entry ? { ...entry } : undefined;
  }

  /** Set the new state and, ONLY on a real change, bump the epoch and emit one
   *  alert. The epoch bump is what makes a prior-state outcome detectably stale. */
  private transition(provider: LLMProviderId, entry: ProviderState, toState: BreakerState): void {
    const fromState = entry.state;
    entry.state = toState;
    if (fromState === toState) return;
    entry.epoch++;
    this.emitTransition(provider, fromState, toState);
  }

  /** Observability must never poison the LLM path — wrapped, never throws. */
  private emitTransition(provider: LLMProviderId, fromState: BreakerState, toState: BreakerState): void {
    try {
      Sentry.captureMessage(`LLM circuit breaker ${fromState}→${toState} (${provider})`, {
        level: 'warning',
        tags: { subsystem: 'llm_circuit_breaker', provider },
        extra: { fromState, toState },
      });
      logger.warn('circuit breaker transition', { provider, fromState, toState });
    } catch {
      // Alerting failure must not affect breaker state or the caller.
    }
  }
}

export const llmCircuitBreaker = new LlmCircuitBreaker();
