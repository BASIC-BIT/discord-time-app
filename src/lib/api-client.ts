/**
 * API client for backend time parsing service
 */

export interface ParseResponse {
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
  method: string;
}

export interface ParseError {
  error: string;
  message?: string;
}

export class TimeParserAPIClient {
  private baseUrl: string;
  private apiKey: string;
  private apiVersion: string = '1';

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
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
        throw new Error(errorData.message || `API error: ${response.status}`);
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
      
      // Re-throw with more context
      throw new Error(`Failed to parse time: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

// Create singleton instance with environment variables
export function createAPIClient(): TimeParserAPIClient | null {
  const baseUrl = import.meta.env.VITE_API_BASE_URL;
  const apiKey = import.meta.env.VITE_API_KEY;

  console.log('API Client Configuration:', {
    baseUrl,
    apiKey: apiKey ? `${apiKey.substring(0, 8)}...` : 'missing',
    env: import.meta.env
  });

  if (!baseUrl || !apiKey) {
    console.warn('API configuration missing, backend parsing will be disabled');
    return null;
  }

  console.log('Creating API client with base URL:', baseUrl);
  return new TimeParserAPIClient(baseUrl, apiKey);
}