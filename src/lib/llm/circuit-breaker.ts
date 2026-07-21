import * as Sentry from '@sentry/node';
import { createWorkerLogger } from '../shared/logger';
import { isTransientLLMError } from './error-classifier';
import type { LLMProviderId } from './types';

// The LLM provider circuit breaker: an in-process, per-provider breaker in the
// src/lib/llm seam. It trips after FAILURE_THRESHOLD consecutive transient
// failures, stays open for OPEN_DURATION_MS, then admits exactly one half-open
// probe. Single-threaded Node makes probe admission race-free. State is
// process-local (effectively global only under single-replica, per ADR 0005).

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 30_000;

type BreakerState = 'closed' | 'open' | 'half_open';

interface ProviderState {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  probeInFlight: boolean;
}

function freshProviderState(): ProviderState {
  return { state: 'closed', consecutiveFailures: 0, openedAt: 0, probeInFlight: false };
}

const logger = createWorkerLogger('[llm:circuit-breaker]');

function readEnabledFromEnv(): boolean {
  return process.env.LLM_CIRCUIT_BREAKER_ENABLED !== 'false';
}

export class LlmCircuitBreaker {
  private readonly now: () => number;
  private enabled: boolean;
  private readonly providers = new Map<LLMProviderId, ProviderState>();

  constructor(opts?: { now?: () => number; enabled?: boolean }) {
    this.now = opts?.now ?? Date.now;
    this.enabled = opts?.enabled ?? readEnabledFromEnv();
  }

  private get(provider: LLMProviderId): ProviderState {
    let current = this.providers.get(provider);
    if (!current) {
      current = freshProviderState();
      this.providers.set(provider, current);
    }
    return current;
  }

  shouldAttempt(provider: LLMProviderId): boolean {
    if (!this.enabled) return true;

    const entry = this.get(provider);
    if (entry.state === 'closed') return true;

    if (entry.state === 'open') {
      if (this.now() - entry.openedAt >= OPEN_DURATION_MS) {
        // Cooldown elapsed: move to half-open and claim the single probe.
        this.transition(provider, entry, 'half_open');
        entry.probeInFlight = true;
        return true;
      }
      return false;
    }

    // half_open: admit only the caller that can claim the (single) probe.
    if (!entry.probeInFlight) {
      entry.probeInFlight = true;
      return true;
    }
    return false;
  }

  recordOutcome(provider: LLMProviderId, error?: unknown): void {
    if (!this.enabled) return;

    const entry = this.get(provider);
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

  reset(): void {
    this.providers.clear();
    this.enabled = readEnabledFromEnv();
  }

  /** Set the new state and emit one alert per real transition. */
  private transition(provider: LLMProviderId, entry: ProviderState, toState: BreakerState): void {
    const fromState = entry.state;
    entry.state = toState;
    if (fromState === toState) return;
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
