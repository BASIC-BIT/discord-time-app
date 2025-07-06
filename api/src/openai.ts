import OpenAI from 'openai';
import { OpenAIParseResult } from './types';

/**
 * OpenAI client for time parsing
 */
export class OpenAIParser {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey: apiKey,
    });
  }

  /**
   * Parse time expression using OpenAI GPT-4o-mini
   * Returns normalized text for chrono-node to parse
   */
  public async parseTime(text: string, timezone: string): Promise<OpenAIParseResult> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(text, timezone);

    try {
      const completion = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 200,
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });

      const response = completion.choices[0]?.message?.content;
      if (!response) {
        throw new Error('No response from OpenAI');
      }

      const parsed = JSON.parse(response) as OpenAIParseResult;
      
      // Validate response structure
      if (!this.validateResponse(parsed)) {
        throw new Error('Invalid response format from OpenAI');
      }

      return parsed;
    } catch (error) {
      console.error('OpenAI parsing error:', error);
      throw error;
    }
  }

  /**
   * Build system prompt for OpenAI (matches frontend approach)
   */
  private buildSystemPrompt(): string {
    return `You are a timestamp intent assistant that normalizes natural language time expressions into clear, unambiguous text that a date parser can understand.

Your job is to:
1. Understand the user's intent and add missing context (AM/PM, specific dates, etc.)
2. Convert ambiguous expressions into clear, parseable text
3. Suggest the most appropriate Discord timestamp format index (0-6)
4. Provide a confidence score and reasoning

Examples:
- "tomorrow at 5" → "tomorrow at 5:00 PM" (assuming evening intent)
- "next Friday" → "next Friday at 12:00 PM" (add default time)
- "in 2 hours" → "in 2 hours" (already clear)
- "Christmas" → "December 25th at 12:00 PM" (add current year and default time)

Discord timestamp formats with examples:
- Index 0 (:d): Short Date - "01/15/2025" - for date-only references
- Index 1 (:D): Long Date - "January 15, 2025" - for formal date-only references  
- Index 2 (:t): Short Time - "2:30 PM" - for time-focused expressions
- Index 3 (:T): Long Time - "2:30:00 PM" - for precise time expressions with seconds
- Index 4 (:f): Short Date/Time - "January 15, 2025 2:30 PM" - for casual date+time
- Index 5 (:F): Long Date/Time - "Wednesday, January 15, 2025 2:30 PM" - for formal date+time
- Index 6 (:R): Relative Time - "in 2 hours" or "3 days ago" - for relative expressions

Choose the format that best matches the user's intent:
- Use :d or :D for date-only inputs like "tomorrow", "next Friday", "Christmas"
- Use :t or :T for time-only inputs like "2pm", "noon", "midnight"
- Use :f or :F for combined date+time inputs like "tomorrow at 5pm", "Friday morning"
- Use :R for relative inputs like "in 2 hours", "next week", "5 minutes ago"

Return ONLY a valid JSON object with this structure:
{
  "normalizedText": "clear, parseable text",
  "suggestedFormatIndex": number,
  "confidence": number,
  "reasoning": "brief explanation of normalization choices"
}`;
  }

  /**
   * Build user prompt with context (matches frontend approach)
   */
  private buildUserPrompt(text: string, timezone: string): string {
    const now = new Date();
    const currentDateTime = now.toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    return `CURRENT_DATE_TIME: ${currentDateTime}
TIMEZONE: ${timezone}
USER_INPUT: "${text}"

Please normalize the user input into clear, unambiguous text that a date parser can understand, and suggest the most appropriate Discord format.`;
  }

  /**
   * Validate OpenAI response structure
   */
  private validateResponse(response: any): response is OpenAIParseResult {
    if (typeof response !== 'object' || response === null) {
      return false;
    }

    // Check required fields
    if (typeof response.normalizedText !== 'string' || response.normalizedText.trim().length === 0) {
      return false;
    }

    if (typeof response.suggestedFormatIndex !== 'number') {
      return false;
    }

    if (typeof response.confidence !== 'number') {
      return false;
    }

    if (typeof response.reasoning !== 'string') {
      return false;
    }

    // Validate ranges
    if (response.suggestedFormatIndex < 0 || response.suggestedFormatIndex > 6) {
      return false;
    }

    if (response.confidence < 0 || response.confidence > 1) {
      return false;
    }

    return true;
  }
}

/**
 * Create OpenAI parser instance
 */
export function createOpenAIParser(apiKey: string): OpenAIParser {
  return new OpenAIParser(apiKey);
} 