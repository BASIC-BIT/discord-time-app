import * as chrono from 'chrono-node';

/**
 * Fallback parser using chrono-node when LLM fails
 */
export function parseFallback(text: string): number | null {
  try {
    // Use chrono to parse the text with forward date preference
    const results = chrono.parse(text, new Date(), { forwardDate: true });
    const first = results[0];
    
    if (first && !isOnlyTimeWithExtraWords(text, first.text, first.start)) {
      // Convert to Unix timestamp (seconds)
      return Math.floor(first.start.date().getTime() / 1000);
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
      () => parseChronoDate(text, text, { forwardDate: true }),
      () => parseChronoDate(text, text, { forwardDate: false }),
      () => parseChronoDate(text.trim(), text.trim(), { forwardDate: true }),
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

function parseChronoDate(text: string, originalText: string, options: chrono.ParsingOption): Date | null {
  const first = chrono.parse(text, new Date(), options)[0];
  if (!first || isOnlyTimeWithExtraWords(originalText, first.text, first.start)) {
    return null;
  }

  return first.start.date();
}

function isOnlyTimeWithExtraWords(text: string, parsedText: string, start: chrono.ParsedComponents): boolean {
  const hasDateComponent = start.isCertain('day') || start.isCertain('weekday') || start.isCertain('month') || start.isCertain('year');
  if (hasDateComponent) {
    return false;
  }

  const remainder = text.replace(parsedText, ' ').replace(/\b(?:at|on|the|a|an)\b/gi, ' ').trim();
  return /[a-z]/i.test(remainder);
}
