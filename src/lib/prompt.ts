export interface FormatStats {
  [key: string]: number;
}

export interface LLMResponse {
  normalizedText: string;
  suggestedFormatIndex: number;
  confidence: number;
  reasoning: string;
}

/**
 * Get the user's timezone
 */
export function getUserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (error) {
    console.error('Error getting timezone:', error);
    return 'UTC';
  }
} 