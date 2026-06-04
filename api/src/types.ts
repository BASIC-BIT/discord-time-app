/**
 * TypeScript DTOs for Time-Parse API
 * Keep these synchronized with the frontend overlay types
 */

// Request/Response DTOs
export interface ParseRequest {
  text: string;
  tz: string;
  now?: string;
  features?: ParseFeatureOverrides;
}

export interface ParseFeatureOverrides {
  deterministicPreflight?: boolean;
  ordinalWeekdayGrammar?: boolean;
  semanticConsistencyGate?: boolean;
}

export interface ParseResponse {
  generationId: string;
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
  method: string;
  canonical?: ParseCanonical;
}

export interface ParseCanonical {
  isoInstant: string;
  zonedDateTime: string;
  timeZone: string;
  precision: 'date' | 'time' | 'datetime' | 'relative';
  weekday?: string;
}

export interface ParseAlternative {
  label: string;
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
  method: string;
}

// Error response interface
export interface ErrorResponse {
  error: string;
  message?: string;
  generationId?: string;
  alternatives?: ParseAlternative[];
}

export interface ParseOutcomeRequest {
  generationId: string;
  action: 'copied' | 'inserted' | 'dismissed' | 'edited_before_copy' | 'timeout' | 'feedback_submitted';
  selectedFormatIndex?: number;
  feedbackCategory?: 'wrong_date' | 'wrong_time' | 'should_have_clarified' | 'should_have_parsed' | 'other';
}

export interface ParseOutcomeResponse {
  ok: true;
}

export interface ParseVerificationRequest {
  text: string;
  tz: string;
  now?: string;
  generationId: string;
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
  method: string;
  canonical?: ParseCanonical;
}

export interface ParseVerificationResponse {
  generationId: string;
  decision: 'accept' | 'reject' | 'uncertain';
  confidence: number;
  reasonCodes: string[];
  explanation: string;
}

// Database interface
export interface UsageRecord {
  id?: number;
  text: string;
  tz: string;
  epoch: number;
  format: number;
  conf: number;
  ip: string;
  ts: string;
}

export interface GenerationRecord {
  generationId: string;
  surface: 'desktop' | 'api' | 'eval' | 'smoke' | 'internal';
  flowVersion: string;
  requestTimeZone: string;
  referenceInstant: string;
  inputTextHash: string;
  inputTextRetained: boolean;
  inputText?: string;
  finalStatus: string;
  finalMethod: string;
  finalEpoch?: number;
  candidateCount?: number;
  clarificationAlternativeCount?: number;
  totalDurationMs?: number;
  errorClass?: string;
}

export interface GenerationOutcomeRecord {
  generationId: string;
  action: ParseOutcomeRequest['action'];
  selectedFormatIndex?: number;
  feedbackCategory?: ParseOutcomeRequest['feedbackCategory'];
}

// Environment variables interface
export interface EnvConfig {
  OPENAI_API_KEY: string | undefined;
  OPENAI_MODEL: string;
  OPENAI_REASONING_EFFORT: string;
  LANGFUSE_ENABLED: boolean;
  LANGFUSE_PUBLIC_KEY: string | undefined;
  LANGFUSE_SECRET_KEY: string | undefined;
  LANGFUSE_BASE_URL: string | undefined;
  STATIC_API_KEY: string;
  TEMPORAL_FEATURE_DETERMINISTIC_PREFLIGHT: boolean;
  TEMPORAL_FEATURE_ORDINAL_WEEKDAY_GRAMMAR: boolean;
  TEMPORAL_FEATURE_PLAN_IR: boolean;
  TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE: boolean;
  TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL: string | undefined;
  TEMPORAL_PLAN_IR_ENDPOINT_MODEL: string;
  TEMPORAL_PLAN_IR_ENDPOINT_API_KEY: string | undefined;
  TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET: string;
  TEMPORAL_PLAN_IR_ENDPOINT_API: string;
  TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT: string;
  TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS: number;
  TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS: number;
  PORT: number;
  DB_PATH: string;
}

// Discord format definitions (mirrored from frontend)
export interface DiscordFormat {
  code: string;
  label: string;
  description: string;
}

export const DISCORD_FORMATS: DiscordFormat[] = [
  { code: ':d', label: 'Short Date', description: '07/05/2025' },
  { code: ':D', label: 'Long Date', description: 'July 5, 2025' },
  { code: ':t', label: 'Short Time', description: '9:30 AM' },
  { code: ':T', label: 'Long Time', description: '9:30:00 AM' },
  { code: ':f', label: 'Short Date/Time', description: 'July 5, 2025 9:30 AM' },
  { code: ':F', label: 'Long Date/Time', description: 'Saturday, July 5, 2025 9:30 AM' },
  { code: ':R', label: 'Relative Time', description: 'in 2 hours' }
];

// Rate limiting configuration
export interface RateLimitConfig {
  max: number;
  timeWindow: string;
}

// API versioning
export const API_VERSION = '1';
export const REQUIRED_HEADERS = {
  API_KEY: 'x-api-key',
  API_VERSION: 'x-api-version'
} as const; 
