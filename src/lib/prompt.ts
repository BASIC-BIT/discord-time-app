import OpenAI from 'openai';

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
 * Build the system prompt for the LLM
 */
function buildSystemPrompt(): string {
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

Consider the user's format usage statistics when suggesting formats.

Return ONLY a valid JSON object with this structure:
{
  "normalizedText": "clear, parseable text",
  "suggestedFormatIndex": number,
  "confidence": number,
  "reasoning": "brief explanation of normalization choices"
}`;
}

/**
 * Build the user prompt with context
 */
function buildUserPrompt(text: string, timezone: string, formatStats: FormatStats): string {
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
FORMAT_STATS: ${JSON.stringify(formatStats)}

Please normalize the user input into clear, unambiguous text that a date parser can understand, and suggest the most appropriate Discord format.`;
}

/**
 * Call OpenAI API to parse the timestamp
 */
export async function parseWithLLM(
  text: string,
  timezone: string,
  formatStats: FormatStats,
  apiKey: string,
  abortSignal?: AbortSignal
): Promise<LLMResponse | null> {
  try {
    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: apiKey,
      dangerouslyAllowBrowser: true // Required for browser usage
    });

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(text, timezone, formatStats);

    console.log('Making OpenAI API call...');
    console.log('System prompt length:', systemPrompt.length);
    console.log('User prompt:', userPrompt);

    // Make API call with timeout and abort signal
    const response = await Promise.race([
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 200,
        temperature: 0.1,
      }, {
        signal: abortSignal // Pass abort signal to OpenAI
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('API timeout after 5 seconds')), 5000)
      )
    ]) as OpenAI.Chat.Completions.ChatCompletion;

    console.log('OpenAI API call completed successfully');
    console.log('Response:', response);

    // Parse the response
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No content in API response');
    }

    console.log('Raw content:', content);

    // Clean up the response and parse JSON
    const cleanContent = content.trim();
    const parsed = JSON.parse(cleanContent) as LLMResponse;

    // Validate the response
    if (
      typeof parsed.normalizedText !== 'string' ||
      typeof parsed.suggestedFormatIndex !== 'number' ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.reasoning !== 'string' ||
      parsed.suggestedFormatIndex < 0 ||
      parsed.suggestedFormatIndex > 6 ||
      parsed.confidence < 0 ||
      parsed.confidence > 1 ||
      parsed.normalizedText.trim().length === 0
    ) {
      throw new Error('Invalid response format');
    }

    console.log('Parsed LLM response successfully:', parsed);
    return parsed;
  } catch (error) {
    // Handle abort errors gracefully
    if (error instanceof Error && error.name === 'AbortError') {
      console.log('LLM request aborted');
      return null;
    }
    
    console.error('LLM parsing error:', error);
    if (error instanceof Error) {
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    return null;
  }
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