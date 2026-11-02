import { randomUUID } from 'node:crypto';
import { planIrEndpointUrl } from './graph';
import type { TemporalPlanIrEndpointConfig } from './types';

const SUCCESS_THROTTLE_MS = 10_000;
const FAILURE_THROTTLE_MS = 15_000;

export interface PlanIrEndpointWarmthStatus {
  configured: boolean;
  warmupEnabled: boolean;
  state: 'disabled' | 'ready' | 'warming' | 'cold';
  lastReadyAt: string | null;
  lastError: string | null;
  inFlight: boolean;
}

/**
 * Tracks whether a scale-to-zero Plan-IR endpoint is known to be warm, and wakes it with a
 * one-token request so parses can skip it (deterministic path) instead of waiting out a cold start.
 */
export class PlanIrEndpointWarmth {
  private lastReadyAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastError: string | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly endpoint: TemporalPlanIrEndpointConfig | undefined,
    private readonly options: { enabled: boolean; readyTtlMs: number; timeoutMs: number; now?: () => number; fetchImpl?: typeof fetch },
  ) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  status(): PlanIrEndpointWarmthStatus {
    const configured = this.endpoint !== undefined;
    let state: PlanIrEndpointWarmthStatus['state'];
    if (!this.options.enabled || !configured) {
      state = 'disabled';
    } else if (this.lastReadyAt !== null && this.now() - this.lastReadyAt < this.options.readyTtlMs) {
      state = 'ready';
    } else if (this.inFlight !== null) {
      state = 'warming';
    } else {
      state = 'cold';
    }
    return {
      configured,
      warmupEnabled: this.options.enabled,
      state,
      lastReadyAt: this.lastReadyAt === null ? null : new Date(this.lastReadyAt).toISOString(),
      lastError: this.lastError,
      inFlight: this.inFlight !== null,
    };
  }

  markReady(): void {
    this.lastReadyAt = this.now();
    this.lastFailureAt = null;
    this.lastError = null;
  }

  markCold(error: string): void {
    this.lastReadyAt = null;
    this.lastFailureAt = this.now();
    this.lastError = error;
  }

  shouldShortCircuit(): boolean {
    const state = this.status().state;
    return state !== 'disabled' && state !== 'ready';
  }

  observer(): { onSuccess: () => void; onFailure: (error: string) => void } {
    return {
      onSuccess: () => this.markReady(),
      onFailure: (error) => this.markCold(error),
    };
  }

  /** Never rejects; the outcome lands in status(). */
  warm(): Promise<void> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const endpoint = this.endpoint;
    if (!this.options.enabled || endpoint === undefined) {
      return Promise.resolve();
    }
    // Throttle on the latest outcome (warm-up or real request): the last ready/failure mark wins.
    const now = this.now();
    if (this.lastReadyAt !== null && now - this.lastReadyAt < SUCCESS_THROTTLE_MS) {
      return Promise.resolve();
    }
    if (this.lastFailureAt !== null && now - this.lastFailureAt < FAILURE_THROTTLE_MS) {
      return Promise.resolve();
    }
    this.inFlight = this.sendWarmRequest(endpoint).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async sendWarmRequest(endpoint: TemporalPlanIrEndpointConfig): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-request-id': `warmup-${randomUUID()}`,
      };
      if (endpoint.apiKey !== undefined) {
        headers['Authorization'] = `Bearer ${endpoint.apiKey}`;
      }
      const payload: Record<string, unknown> = { model: endpoint.model, max_tokens: 1, temperature: 0 };
      if (endpoint.api === 'chat') {
        payload['messages'] = [{ role: 'user', content: 'warm' }];
      } else {
        payload['prompt'] = 'warm';
      }
      const response = await this.fetchImpl(planIrEndpointUrl(endpoint), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (response.ok) {
        this.markReady();
      } else {
        this.markCold(`Warm-up returned HTTP ${response.status}: ${bodyText.slice(0, 200)}`);
      }
    } catch (error) {
      this.markCold(controller.signal.aborted
        ? `Warm-up timed out after ${this.options.timeoutMs}ms.`
        : error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}
