import * as chrono from 'chrono-node';

const TEMPORAL_SIGNAL_PATTERN = /\b(?:today|tomorrow|yesterday|tonight|noon|midnight|morning|afternoon|evening|day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|after|before|from|next|last|this|coming|upcoming|at|around|about|by|time|clock)\b|\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i;
const MONTH_DAY_AT_END_PATTERN = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\s*$/i;
const DATE_SIGNAL_PATTERN = /\b(?:today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|last|this|coming|upcoming)\b/i;
const EXPLICIT_TIME_PATTERN = /\b(?:noon|midnight)\b|\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i;

/**
 * Fallback parser using chrono-node when LLM fails
 */
export function parseFallback(text: string): number | null {
  try {
    // Use chrono to parse the text with forward date preference
    const results = chrono.parse(text, new Date(), { forwardDate: true });
    const first = results[0];
    
    if (first && !isPartialChronoParse(text, first.text, first.start)) {
      // Convert to Unix timestamp (seconds)
      return Math.floor(normalizeChronoDate(first.start, text).getTime() / 1000);
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
  if (!first || isPartialChronoParse(originalText, first.text, first.start)) {
    return null;
  }

  return normalizeChronoDate(first.start, originalText);
}

function normalizeChronoDate(start: chrono.ParsedComponents, originalText: string): Date {
  const date = start.date();
  if (start.isCertain('hour') || EXPLICIT_TIME_PATTERN.test(originalText)) {
    return date;
  }

  date.setHours(12, 0, 0, 0);
  return date;
}

function isPartialChronoParse(text: string, parsedText: string, start: chrono.ParsedComponents): boolean {
  if (isOnlyTimeWithExtraWords(text, parsedText, start)) {
    return true;
  }

  if (hasTrailingBareNumericTimeSignal(text)) {
    return true;
  }

  const remainder = removeParsedText(text, parsedText)
    .replace(/\b(?:please|pls|for|me|us|remind|reminder|meeting|event|schedule|set)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return TEMPORAL_SIGNAL_PATTERN.test(remainder);
}

function hasTrailingBareNumericTimeSignal(text: string): boolean {
  const trimmed = text.trim();
  if (!/\b\d{1,2}\s*$/.test(trimmed)) {
    return false;
  }
  if (MONTH_DAY_AT_END_PATTERN.test(trimmed) || /\b\d{1,2}\/\d{1,2}\s*$/.test(trimmed)) {
    return false;
  }
  return DATE_SIGNAL_PATTERN.test(trimmed);
}

function isOnlyTimeWithExtraWords(text: string, parsedText: string, start: chrono.ParsedComponents): boolean {
  const hasDateComponent = start.isCertain('day') || start.isCertain('weekday') || start.isCertain('month') || start.isCertain('year');
  if (hasDateComponent) {
    return false;
  }

  const remainder = removeParsedText(text, parsedText).replace(/\b(?:at|on|the|a|an)\b/gi, ' ').trim();
  return /[a-z]/i.test(remainder);
}

function removeParsedText(text: string, parsedText: string): string {
  const index = text.toLowerCase().indexOf(parsedText.toLowerCase());
  if (index < 0) {
    return text;
  }
  return `${text.slice(0, index)} ${text.slice(index + parsedText.length)}`;
}
