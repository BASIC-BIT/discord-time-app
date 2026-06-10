/**
 * API client for backend time parsing service
 */
import { invoke } from '@tauri-apps/api/core';

export interface ParseResponse {
  generationId: string;
  kind?: 'instant' | 'time_range';
  epoch: number;
  suggestedFormatIndex: number;
  range?: ParseRangeResult;
  confidence: number;
  method: string;
  canonical?: ParseCanonical;
}

export interface ParseCanonical {
  isoInstant: string;
  zonedDateTime: string;
  timeZone: string;
  precision: 'date' | 'time' | 'datetime' | 'relative';
  weekday?: string;
}

export interface ParseAlternative {
  label: string;
  kind?: 'instant' | 'time_range';
  epoch: number;
  suggestedFormatIndex: number;
  range?: ParseRangeResult;
  confidence: number;
  method: string;
}

export interface ParseRangeEndpoint {
  epoch: number;
  suggestedFormatIndex: number;
  canonical: ParseCanonical;
}

export interface ParseRangeResult {
  start: ParseRangeEndpoint;
  end: ParseRangeEndpoint;
  discord: string;
}

export interface ParseError {
  error: string;
  message?: string;
  generationId?: string;
  alternatives?: ParseAlternative[];
}

export interface ParseOptions {
  deterministicPreflight?: boolean;
  ordinalWeekdayGrammar?: boolean;
  semanticConsistencyGate?: boolean;
}

export interface ParseOutcome {
  generationId: string;
  action: 'copied' | 'inserted' | 'dismissed' | 'edited_before_copy' | 'timeout' | 'feedback_submitted';
  selectedFormatIndex?: number;
  feedbackCategory?: 'wrong_date' | 'wrong_time' | 'should_have_clarified' | 'should_have_parsed' | 'other';
}

export interface ParseVerificationRequest extends ParseResponse {
  text: string;
  tz: string;
}

export interface ParseVerificationResponse {
  generationId: string;
  decision: 'accept' | 'reject' | 'uncertain';
  confidence: number;
  reasonCodes: string[];
  explanation: string;
}

export class TimeParserAPIError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly alternatives?: ParseAlternative[],
    public readonly generationId?: string,
  ) {
    super(message);
    this.name = 'TimeParserAPIError';
  }
}

export class TimeParserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeParserUnavailableError';
  }
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8857';
const DEFAULT_UNAVAILABLE_MESSAGE = 'The local time parser service is not running yet. HammerOverlay will keep using local fallback parsing until it is available.';
const STARTUP_RETRY_DELAYS_MS = [250, 750, 1500];

interface TimeParserRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  available: boolean;
  supervised: boolean;
  message: string;
}

interface NativeTimeParserResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export class TimeParserAPIClient {
  private baseUrl: string;
  private apiKey: string;
  private apiVersion: string = '1';
  private unavailableMessage: string;
  private useNativeBridge: boolean;

  constructor(baseUrl: string, apiKey: string, unavailableMessage = DEFAULT_UNAVAILABLE_MESSAGE, useNativeBridge = true) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
    this.unavailableMessage = unavailableMessage;
    this.useNativeBridge = useNativeBridge;
  }

  /**
   * Parse time text using the backend API
   */
  async parseTime(
    text: string,
    timezone: string,
    abortSignal?: AbortSignal,
    options?: ParseOptions,
  ): Promise<ParseResponse> {
    const url = `${this.baseUrl}/parse`;
    const featureOverrides = {
      ...(options?.deterministicPreflight === undefined ? {} : { deterministicPreflight: options.deterministicPreflight }),
      ...(options?.ordinalWeekdayGrammar === undefined ? {} : { ordinalWeekdayGrammar: options.ordinalWeekdayGrammar }),
      ...(options?.semanticConsistencyGate === undefined ? {} : { semanticConsistencyGate: options.semanticConsistencyGate }),
    };

    const nativeResult = this.useNativeBridge
      ? await this.parseTimeWithNativeBridge(text, timezone, featureOverrides, abortSignal)
      : null;
    if (nativeResult !== null) {
      return nativeResult;
    }
    
    try {
      const response = await fetchWithStartupRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'x-api-version': this.apiVersion,
        },
        body: JSON.stringify({
          text,
          tz: timezone,
          ...(Object.keys(featureOverrides).length === 0 ? {} : { features: featureOverrides }),
        }),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorData = await response.json() as ParseError;
        throw new TimeParserAPIError(errorData.message || `API error: ${response.status}`, response.status, errorData.error, errorData.alternatives, errorData.generationId);
      }

      const data = await response.json() as ParseResponse;
      if (!isValidParseResponse(data)) {
        throw new Error('Invalid API response format');
      }

      return data;
    } catch (error) {
      // Handle abort errors
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      if (error instanceof TimeParserAPIError) {
        throw error;
      }
      if (error instanceof TypeError) {
        throw new TimeParserUnavailableError(this.unavailableMessage);
      }
      
      // Re-throw with more context
      throw new TimeParserAPIError(`Failed to parse time: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async parseTimeWithNativeBridge(
    text: string,
    timezone: string,
    featureOverrides: Record<string, boolean>,
    abortSignal?: AbortSignal,
  ): Promise<ParseResponse | null> {
    if (abortSignal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    let nativeResponse: NativeTimeParserResponse;
    try {
      nativeResponse = await invoke<NativeTimeParserResponse>('parse_time_with_local_service', {
        request: {
          text,
          tz: timezone,
          ...(Object.keys(featureOverrides).length === 0 ? {} : { features: featureOverrides }),
        },
      });
    } catch (error) {
      console.log('Native parser bridge unavailable, falling back to fetch:', error);
      return null;
    }

    if (abortSignal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    if (!nativeResponse.ok) {
      const errorData = nativeResponse.body as ParseError;
      throw new TimeParserAPIError(
        errorData.message || `API error: ${nativeResponse.status}`,
        nativeResponse.status,
        errorData.error,
        errorData.alternatives,
        errorData.generationId,
      );
    }

    const data = nativeResponse.body as ParseResponse;
    if (!isValidParseResponse(data)) {
      throw new Error('Invalid native API response format');
    }

    return data;
  }

  /**
   * Health check endpoint
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetchWithStartupRetry(`${this.baseUrl}/health`, {
        headers: {
          'x-api-key': this.apiKey,
          'x-api-version': this.apiVersion,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async recordOutcome(outcome: ParseOutcome, abortSignal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.baseUrl}/parse/outcome`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'x-api-version': this.apiVersion,
      },
      body: JSON.stringify(outcome),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorData = await response.json() as ParseError;
      throw new TimeParserAPIError(errorData.message || `API error: ${response.status}`, response.status, errorData.error, errorData.alternatives, errorData.generationId);
    }
  }

  async verifyParse(candidate: ParseVerificationRequest, abortSignal?: AbortSignal): Promise<ParseVerificationResponse> {
    const response = await fetch(`${this.baseUrl}/parse/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'x-api-version': this.apiVersion,
      },
      body: JSON.stringify(candidate),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorData = await response.json() as ParseError;
      throw new TimeParserAPIError(errorData.message || `API error: ${response.status}`, response.status, errorData.error, errorData.alternatives, errorData.generationId);
    }

    const data = await response.json() as ParseVerificationResponse;
    if (
      typeof data.generationId !== 'string' ||
      (data.decision !== 'accept' && data.decision !== 'reject' && data.decision !== 'uncertain') ||
      typeof data.confidence !== 'number' ||
      !Array.isArray(data.reasonCodes) ||
      typeof data.explanation !== 'string'
    ) {
      throw new Error('Invalid API verification response format');
    }

    return data;
  }
}

function isValidParseResponse(data: ParseResponse): boolean {
  return typeof data.generationId === 'string' &&
    typeof data.epoch === 'number' &&
    typeof data.suggestedFormatIndex === 'number' &&
    typeof data.confidence === 'number' &&
    typeof data.method === 'string' &&
    (data.kind !== 'time_range' || isValidParseRange(data.range));
}

async function fetchWithStartupRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= STARTUP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      if (!(error instanceof TypeError)) {
        throw error;
      }
      lastError = error;
      const delayMs = STARTUP_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        break;
      }
      await waitForRetry(delayMs, init.signal);
    }
  }
  throw lastError;
}

function waitForRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function isValidParseRange(range: ParseRangeResult | undefined): range is ParseRangeResult {
  return range !== undefined &&
    typeof range.discord === 'string' &&
    isValidParseRangeEndpoint(range.start) &&
    isValidParseRangeEndpoint(range.end);
}

function isValidParseRangeEndpoint(endpoint: ParseRangeEndpoint | undefined): endpoint is ParseRangeEndpoint {
  return endpoint !== undefined &&
    typeof endpoint.epoch === 'number' &&
    typeof endpoint.suggestedFormatIndex === 'number' &&
    endpoint.canonical !== undefined &&
    typeof endpoint.canonical.isoInstant === 'string' &&
    typeof endpoint.canonical.zonedDateTime === 'string' &&
    typeof endpoint.canonical.timeZone === 'string' &&
    typeof endpoint.canonical.precision === 'string';
}

async function getTauriTimeParserConfig(): Promise<TimeParserRuntimeConfig | null> {
  try {
    return await invoke<TimeParserRuntimeConfig>('get_time_parser_config');
  } catch (error) {
    console.log('Tauri parser runtime config is unavailable:', error);
    return null;
  }
}

// Create singleton instance with environment variables or Tauri runtime config.
export async function createAPIClient(): Promise<TimeParserAPIClient | null> {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL;
  const apiKey = import.meta.env.VITE_API_KEY;

  if (apiKey) {
    return new TimeParserAPIClient(baseUrl, apiKey, DEFAULT_UNAVAILABLE_MESSAGE, false);
  }

  const runtimeConfig = await getTauriTimeParserConfig();
  if (runtimeConfig && !runtimeConfig.available) {
    console.log(runtimeConfig.message);
    return null;
  }
  if (runtimeConfig?.apiKey) {
    return new TimeParserAPIClient(runtimeConfig.baseUrl || baseUrl, runtimeConfig.apiKey, runtimeConfig.message);
  }

  console.log('API client disabled because VITE_API_KEY is not configured and no Tauri runtime config is available.');
  return null;
}
