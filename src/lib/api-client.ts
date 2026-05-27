/**
 * API client for backend time parsing service
 */
import { invoke } from '@tauri-apps/api/core';

export interface ParseResponse {
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
  method: string;
}

export interface ParseAlternative {
  label: string;
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
  method: string;
}

export interface ParseError {
  error: string;
  message?: string;
  alternatives?: ParseAlternative[];
}

export class TimeParserAPIError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly alternatives?: ParseAlternative[],
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

interface TimeParserRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  available: boolean;
  supervised: boolean;
  message: string;
}

export class TimeParserAPIClient {
  private baseUrl: string;
  private apiKey: string;
  private apiVersion: string = '1';
  private unavailableMessage: string;

  constructor(baseUrl: string, apiKey: string, unavailableMessage = DEFAULT_UNAVAILABLE_MESSAGE) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
    this.unavailableMessage = unavailableMessage;
  }

  /**
   * Parse time text using the backend API
   */
  async parseTime(
    text: string,
    timezone: string,
    abortSignal?: AbortSignal
  ): Promise<ParseResponse> {
    const url = `${this.baseUrl}/parse`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'x-api-version': this.apiVersion,
        },
        body: JSON.stringify({
          text,
          tz: timezone,
        }),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorData = await response.json() as ParseError;
        throw new TimeParserAPIError(errorData.message || `API error: ${response.status}`, response.status, errorData.error, errorData.alternatives);
      }

      const data = await response.json() as ParseResponse;
      
      // Validate response
      if (
        typeof data.epoch !== 'number' ||
        typeof data.suggestedFormatIndex !== 'number' ||
        typeof data.confidence !== 'number' ||
        typeof data.method !== 'string'
      ) {
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

  /**
   * Health check endpoint
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
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
    return new TimeParserAPIClient(baseUrl, apiKey);
  }

  const runtimeConfig = await getTauriTimeParserConfig();
  if (runtimeConfig?.apiKey) {
    return new TimeParserAPIClient(runtimeConfig.baseUrl || baseUrl, runtimeConfig.apiKey, runtimeConfig.message);
  }

  console.log('API client disabled because VITE_API_KEY is not configured and no Tauri runtime config is available.');
  return null;
}
