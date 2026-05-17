import * as chrono from 'chrono-node';

const EASTER_PATTERN = /\beaster(?:\s+sunday)?\b/i;
const TWELVE_HOUR_TIME_PATTERN = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i;
const TWENTY_FOUR_HOUR_TIME_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

/**
 * Fallback parser using chrono-node when LLM fails
 */
export function parseFallback(text: string): number | null {
  try {
    const holidayEpoch = parseHolidayFallback(text);
    if (holidayEpoch !== null) {
      return holidayEpoch;
    }

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
    const holidayEpoch = parseHolidayFallback(text);
    if (holidayEpoch !== null) {
      return holidayEpoch;
    }

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

function parseHolidayFallback(text: string): number | null {
  if (!EASTER_PATTERN.test(text)) {
    return null;
  }

  const reference = new Date();
  const time = extractTimeOfDay(text);
  let date = easterDate(reference.getFullYear(), time.hour, time.minute);
  if (date.getTime() <= reference.getTime()) {
    date = easterDate(reference.getFullYear() + 1, time.hour, time.minute);
  }

  return Math.floor(date.getTime() / 1000);
}

function easterDate(year: number, hour: number, minute: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function extractTimeOfDay(text: string): { hour: number; minute: number } {
  if (/\bmidnight\b/i.test(text)) {
    return { hour: 0, minute: 0 };
  }
  if (/\bnoon\b/i.test(text)) {
    return { hour: 12, minute: 0 };
  }

  const twelveHour = TWELVE_HOUR_TIME_PATTERN.exec(text);
  if (twelveHour?.[1] && twelveHour[3]) {
    const suffix = twelveHour[3].toLowerCase();
    let hour = Number(twelveHour[1]) % 12;
    if (suffix === 'pm') {
      hour += 12;
    }
    return { hour, minute: Number(twelveHour[2] ?? 0) };
  }

  const twentyFourHour = TWENTY_FOUR_HOUR_TIME_PATTERN.exec(text);
  if (twentyFourHour?.[1] && twentyFourHour[2]) {
    return { hour: Number(twentyFourHour[1]), minute: Number(twentyFourHour[2]) };
  }

  return { hour: 12, minute: 0 };
}
