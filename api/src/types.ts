/**
 * TypeScript DTOs for Time-Parse API
 * Keep these synchronized with the frontend overlay types
 */

// Request/Response DTOs
export interface ParseRequest {
  text: string;
  tz: string;
}

export interface ParseResponse {
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
}

// Error response interface
export interface ErrorResponse {
  error: string;
  message?: string;
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

// OpenAI response interface
export interface OpenAIParseResult {
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
}

// Environment variables interface
export interface EnvConfig {
  OPENAI_API_KEY: string;
  STATIC_API_KEY: string;
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