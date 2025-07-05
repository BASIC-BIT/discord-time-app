import OpenAI from 'openai';

export interface FormatStats {
  [key: string]: number;
}

export interface LLMResponse {
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
}

/**
 * Build the system prompt for the LLM
 */
function buildSystemPrompt(): string {
  return `You are a timestamp assistant that converts natural language time expressions into Unix timestamps and suggests the most appropriate Discord timestamp format.

Your job is to:
1. Parse the given text into a Unix timestamp (seconds since epoch)
2. Suggest the most appropriate Discord timestamp format index (0-6)
3. Provide a confidence score (0-1)

Discord timestamp formats:
- Index 0 (:d): Short Date (07/05/2025)
- Index 1 (:D): Long Date (July 5, 2025)
- Index 2 (:t): Short Time (9:30 AM)
- Index 3 (:T): Long Time (9:30:00 AM)
- Index 4 (:f): Short Date/Time (July 5, 2025 9:30 AM)
- Index 5 (:F): Long Date/Time (Saturday, July 5, 2025 9:30 AM)
- Index 6 (:R): Relative Time (in 2 hours)

Consider the user's format usage statistics when suggesting formats.

Return ONLY a valid JSON object with this structure:
{
  "epoch": number,
  "suggestedFormatIndex": number,
  "confidence": number
}`;
}

/**
 * Build the user prompt with context
 */
function buildUserPrompt(text: string, timezone: string, formatStats: FormatStats): string {
  return `TEXT: "${text}"
TIMEZONE: "${timezone}"
FORMAT_STATS_JSON: ${JSON.stringify(formatStats)}

Please parse this text and return the JSON response.`;
}

/**
 * Call OpenAI API to parse the timestamp
 */
export async function parseWithLLM(
  text: string,
  timezone: string,
  formatStats: FormatStats,
  apiKey: string
): Promise<LLMResponse | null> {
  try {
    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: apiKey,
      dangerouslyAllowBrowser: true // Required for browser usage
    });

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(text, timezone, formatStats);

    // Make API call with timeout
    const response = await Promise.race([
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 150,
        temperature: 0.1,
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('API timeout')), 1000)
      )
    ]) as OpenAI.Chat.Completions.ChatCompletion;

    // Parse the response
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No content in API response');
    }

    // Clean up the response and parse JSON
    const cleanContent = content.trim();
    const parsed = JSON.parse(cleanContent) as LLMResponse;

    // Validate the response
    if (
      typeof parsed.epoch !== 'number' ||
      typeof parsed.suggestedFormatIndex !== 'number' ||
      typeof parsed.confidence !== 'number' ||
      parsed.suggestedFormatIndex < 0 ||
      parsed.suggestedFormatIndex > 6 ||
      parsed.confidence < 0 ||
      parsed.confidence > 1
    ) {
      throw new Error('Invalid response format');
    }

    return parsed;
  } catch (error) {
    console.error('LLM parsing error:', error);
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