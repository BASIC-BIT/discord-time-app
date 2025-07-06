import * as chrono from 'chrono-node';

/**
 * Fallback parser using chrono-node when LLM fails
 */
export function parseFallback(text: string): number | null {
  try {
    // Use chrono to parse the text with forward date preference
    const results = chrono.parseDate(text, new Date(), { forwardDate: true });
    
    if (results) {
      // Convert to Unix timestamp (seconds)
      return Math.floor(results.getTime() / 1000);
    }
    
    return null;
  } catch (error) {
    console.error('Fallback parsing error:', error);
    return null;
  }
}

/**
 * Parse multiple formats and return the most confident result
 */
export function parseMultiple(text: string): number | null {
  try {
    // Try different parsing strategies
    const strategies = [
      () => chrono.parseDate(text, new Date(), { forwardDate: true }),
      () => chrono.parseDate(text, new Date(), { forwardDate: false }),
      () => chrono.parseDate(text.trim(), new Date(), { forwardDate: true }),
    ];
    
    for (const strategy of strategies) {
      const result = strategy();
      if (result) {
        return Math.floor(result.getTime() / 1000);
      }
    }
    
    return null;
  } catch (error) {
    console.error('Multiple parsing error:', error);
    return null;
  }
} 