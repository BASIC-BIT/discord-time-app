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
        max_tokens: 150,
        temperature: 0,
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
   * Build system prompt for OpenAI
   */
  private buildSystemPrompt(): string {
    return `You are a timestamp parsing assistant. Your job is to convert natural language time expressions into Unix epoch timestamps.

You must respond with valid JSON containing exactly these fields:
- "epoch": Unix timestamp in seconds (integer)
- "suggestedFormatIndex": Index 0-6 for Discord format (integer) 
- "confidence": Confidence score 0-1 (float)

Discord format indices:
0: :d (Short Date - 07/05/2025)
1: :D (Long Date - July 5, 2025)
2: :t (Short Time - 9:30 AM)
3: :T (Long Time - 9:30:00 AM)
4: :f (Short Date/Time - July 5, 2025 9:30 AM)
5: :F (Long Date/Time - Saturday, July 5, 2025 9:30 AM)
6: :R (Relative Time - in 2 hours)

Guidelines:
- Use the current date/time as reference for relative expressions
- For date-only expressions (no time), default to 12:00 PM
- For time-only expressions (no date), assume today
- Use format 4 (:f) for most expressions with both date and time
- Use format 1 (:D) for date-only expressions  
- Use format 2 (:t) for time-only expressions
- Use format 6 (:R) for relative expressions like "in 2 hours", "tomorrow"
- Set confidence based on how clear the expression is (0.9+ for clear, 0.5-0.8 for ambiguous, <0.5 for unclear)

Always respond with valid JSON only, no additional text.`;
  }

  /**
   * Build user prompt with context
   */
  private buildUserPrompt(text: string, timezone: string): string {
    const currentDate = new Date();
    const currentISOString = currentDate.toISOString();
    const currentEpoch = Math.floor(currentDate.getTime() / 1000);

    return `Parse this time expression into a Unix timestamp:

TEXT: "${text}"
TIMEZONE: "${timezone}"
CURRENT_TIME: "${currentISOString}" (epoch: ${currentEpoch})
CURRENT_DATE: "${currentDate.toLocaleDateString()}"
CURRENT_WEEKDAY: "${currentDate.toLocaleDateString('en-US', { weekday: 'long' })}"

Return JSON with epoch, suggestedFormatIndex, and confidence.`;
  }

  /**
   * Validate OpenAI response structure
   */
  private validateResponse(response: any): response is OpenAIParseResult {
    if (typeof response !== 'object' || response === null) {
      return false;
    }

    // Check required fields
    if (typeof response.epoch !== 'number') {
      return false;
    }

    if (typeof response.suggestedFormatIndex !== 'number') {
      return false;
    }

    if (typeof response.confidence !== 'number') {
      return false;
    }

    // Validate ranges
    if (response.epoch <= 0 || response.epoch > 2147483647) {
      return false;
    }

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