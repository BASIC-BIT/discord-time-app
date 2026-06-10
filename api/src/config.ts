import { EnvConfig } from './types';
import type { TemporalFeatureFlags, TemporalPlanIrEndpointApi, TemporalPlanIrEndpointConfig, TemporalPlanIrEndpointPromptFormat, TemporalPlanIrInstructionPreset } from './temporal/types';

/**
 * Configuration loader for environment variables
 */
export class Config {
  private config: EnvConfig;

  constructor() {
    this.config = this.loadConfig();
    this.validateConfig();
  }

  /**
   * Load configuration from environment variables
   */
  private loadConfig(): EnvConfig {
    const langfusePublicKey = this.getOptionalEnvVar('LANGFUSE_PUBLIC_KEY');
    const langfuseSecretKey = this.getOptionalEnvVar('LANGFUSE_SECRET_KEY');
    return {
      OPENAI_API_KEY: this.getOptionalEnvVar('OPENAI_API_KEY'),
      OPENAI_MODEL: this.getEnvVar('OPENAI_MODEL', 'gpt-5.5'),
      OPENAI_REASONING_EFFORT: this.getEnvVar('OPENAI_REASONING_EFFORT', 'low'),
      LANGFUSE_ENABLED: this.getBooleanEnvVar('LANGFUSE_ENABLED', langfusePublicKey !== undefined && langfuseSecretKey !== undefined),
      LANGFUSE_PUBLIC_KEY: langfusePublicKey,
      LANGFUSE_SECRET_KEY: langfuseSecretKey,
      LANGFUSE_BASE_URL: this.getOptionalEnvVar('LANGFUSE_BASE_URL') ?? this.getOptionalEnvVar('LANGFUSE_HOST'),
      STATIC_API_KEY: this.getEnvVar('STATIC_API_KEY', 'STATIC_KEY_123'),
      TEMPORAL_FEATURE_DETERMINISTIC_PREFLIGHT: this.getBooleanEnvVar('TEMPORAL_FEATURE_DETERMINISTIC_PREFLIGHT', false),
      TEMPORAL_FEATURE_ORDINAL_WEEKDAY_GRAMMAR: this.getBooleanEnvVar('TEMPORAL_FEATURE_ORDINAL_WEEKDAY_GRAMMAR', true),
      TEMPORAL_FEATURE_PLAN_IR: this.getBooleanEnvVar('TEMPORAL_FEATURE_PLAN_IR', false),
      TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE: this.getBooleanEnvVar('TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE', false),
      TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL: this.getOptionalEnvVar('TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL'),
      TEMPORAL_PLAN_IR_ENDPOINT_MODEL: this.getEnvVar('TEMPORAL_PLAN_IR_ENDPOINT_MODEL', 'qwen-temporal-ir'),
      TEMPORAL_PLAN_IR_ENDPOINT_API_KEY: this.getOptionalEnvVar('TEMPORAL_PLAN_IR_ENDPOINT_API_KEY'),
      TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET: this.getEnvVar('TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET', 'minimal'),
      TEMPORAL_PLAN_IR_ENDPOINT_API: this.getEnvVar('TEMPORAL_PLAN_IR_ENDPOINT_API', 'completions'),
      TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT: this.getEnvVar('TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT', 'custom'),
      TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS: this.getPositiveIntegerEnvVar('TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS', 512),
      TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS: this.getPositiveIntegerEnvVar('TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS', 8000),
      PORT: parseInt(this.getEnvVar('PORT', '8857'), 10),
      DB_PATH: this.getEnvVar('DB_PATH', 'usage.db')
    };
  }

  /**
   * Get environment variable with optional default
   */
  private getEnvVar(name: string, defaultValue?: string): string {
    const value = process.env[name];
    if (!value) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  }

  private getOptionalEnvVar(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
  }

  private getBooleanEnvVar(name: string, defaultValue: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === undefined || value === '') {
      return defaultValue;
    }
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
  }

  private getPositiveIntegerEnvVar(name: string, defaultValue: number): number {
    const raw = this.getEnvVar(name, String(defaultValue));
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
    return value;
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    // Validate OpenAI API key format when the agent path is configured.
    if (this.config.OPENAI_API_KEY !== undefined && !this.config.OPENAI_API_KEY.startsWith('sk-')) {
      throw new Error('OPENAI_API_KEY must start with "sk-"');
    }

    // Validate port
    if (this.config.PORT < 1 || this.config.PORT > 65535) {
      throw new Error('PORT must be between 1 and 65535');
    }

    // Validate API key is not empty
    if (!this.config.STATIC_API_KEY || this.config.STATIC_API_KEY.trim() === '') {
      throw new Error('STATIC_API_KEY cannot be empty');
    }

    if (this.config.LANGFUSE_ENABLED && (this.config.LANGFUSE_PUBLIC_KEY === undefined || this.config.LANGFUSE_SECRET_KEY === undefined)) {
      throw new Error('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required when LANGFUSE_ENABLED is true');
    }

    if (!this.isTemporalPlanIrInstructionPreset(this.config.TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET)) {
      throw new Error('TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET must be "minimal" or "detailed"');
    }

    if (!this.isTemporalPlanIrEndpointApi(this.config.TEMPORAL_PLAN_IR_ENDPOINT_API)) {
      throw new Error('TEMPORAL_PLAN_IR_ENDPOINT_API must be "completions" or "chat"');
    }

    if (!this.isTemporalPlanIrEndpointPromptFormat(this.config.TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT)) {
      throw new Error('TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT must be "custom" or "chat"');
    }

    console.log('Configuration validated successfully');
  }

  private isTemporalPlanIrInstructionPreset(value: string): value is TemporalPlanIrInstructionPreset {
    return value === 'minimal' || value === 'detailed';
  }

  private isTemporalPlanIrEndpointApi(value: string): value is TemporalPlanIrEndpointApi {
    return value === 'completions' || value === 'chat';
  }

  private isTemporalPlanIrEndpointPromptFormat(value: string): value is TemporalPlanIrEndpointPromptFormat {
    return value === 'custom' || value === 'chat';
  }

  /**
   * Get configuration
   */
  public getConfig(): EnvConfig {
    return { ...this.config };
  }

  /**
   * Get specific config values
   */
  public get openaiApiKey(): string | undefined {
    return this.config.OPENAI_API_KEY;
  }

  public get openaiModel(): string {
    return this.config.OPENAI_MODEL;
  }

  public get openaiReasoningEffort(): string {
    return this.config.OPENAI_REASONING_EFFORT;
  }

  public get langfuseEnabled(): boolean {
    return this.config.LANGFUSE_ENABLED;
  }

  public get langfuseBaseUrl(): string | undefined {
    return this.config.LANGFUSE_BASE_URL;
  }

  public get staticApiKey(): string {
    return this.config.STATIC_API_KEY;
  }

  public get port(): number {
    return this.config.PORT;
  }

  public get dbPath(): string {
    return this.config.DB_PATH;
  }

  public get temporalFeatures(): TemporalFeatureFlags {
    return {
      deterministicPreflight: this.config.TEMPORAL_FEATURE_DETERMINISTIC_PREFLIGHT,
      ordinalWeekdayGrammar: this.config.TEMPORAL_FEATURE_ORDINAL_WEEKDAY_GRAMMAR,
      planIr: this.config.TEMPORAL_FEATURE_PLAN_IR,
      semanticConsistencyGate: this.config.TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE,
    };
  }

  public get temporalPlanIrEndpoint(): TemporalPlanIrEndpointConfig | undefined {
    const baseUrl = this.config.TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL;
    if (baseUrl === undefined) {
      return undefined;
    }
    const endpoint: TemporalPlanIrEndpointConfig = {
      baseUrl,
      model: this.config.TEMPORAL_PLAN_IR_ENDPOINT_MODEL,
      instructionPreset: this.config.TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET as TemporalPlanIrInstructionPreset,
      api: this.config.TEMPORAL_PLAN_IR_ENDPOINT_API as TemporalPlanIrEndpointApi,
      promptFormat: this.config.TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT as TemporalPlanIrEndpointPromptFormat,
      maxTokens: this.config.TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS,
      timeoutMs: this.config.TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS,
    };
    if (this.config.TEMPORAL_PLAN_IR_ENDPOINT_API_KEY !== undefined) {
      endpoint.apiKey = this.config.TEMPORAL_PLAN_IR_ENDPOINT_API_KEY;
    }
    return endpoint;
  }

  /**
   * Get sanitized config for logging (without secrets)
   */
  public getSanitizedConfig(): Partial<EnvConfig> {
    return {
      OPENAI_API_KEY: this.config.OPENAI_API_KEY === undefined ? 'not configured' : this.config.OPENAI_API_KEY.slice(0, 7) + '...',
      OPENAI_MODEL: this.config.OPENAI_MODEL,
      OPENAI_REASONING_EFFORT: this.config.OPENAI_REASONING_EFFORT,
      LANGFUSE_ENABLED: this.config.LANGFUSE_ENABLED,
      LANGFUSE_PUBLIC_KEY: this.config.LANGFUSE_PUBLIC_KEY === undefined ? 'not configured' : this.config.LANGFUSE_PUBLIC_KEY.slice(0, 7) + '...',
      LANGFUSE_SECRET_KEY: this.config.LANGFUSE_SECRET_KEY === undefined ? 'not configured' : 'configured',
      LANGFUSE_BASE_URL: this.config.LANGFUSE_BASE_URL,
      TEMPORAL_FEATURE_DETERMINISTIC_PREFLIGHT: this.config.TEMPORAL_FEATURE_DETERMINISTIC_PREFLIGHT,
      TEMPORAL_FEATURE_ORDINAL_WEEKDAY_GRAMMAR: this.config.TEMPORAL_FEATURE_ORDINAL_WEEKDAY_GRAMMAR,
      TEMPORAL_FEATURE_PLAN_IR: this.config.TEMPORAL_FEATURE_PLAN_IR,
      TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE: this.config.TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE,
      TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL: this.config.TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL,
      TEMPORAL_PLAN_IR_ENDPOINT_MODEL: this.config.TEMPORAL_PLAN_IR_ENDPOINT_MODEL,
      TEMPORAL_PLAN_IR_ENDPOINT_API_KEY: this.config.TEMPORAL_PLAN_IR_ENDPOINT_API_KEY === undefined ? 'not configured' : 'configured',
      TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET: this.config.TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET,
      TEMPORAL_PLAN_IR_ENDPOINT_API: this.config.TEMPORAL_PLAN_IR_ENDPOINT_API,
      TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT: this.config.TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT,
      TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS: this.config.TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS,
      TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS: this.config.TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS,
      STATIC_API_KEY: this.config.STATIC_API_KEY.slice(0, 6) + '...',
      PORT: this.config.PORT,
      DB_PATH: this.config.DB_PATH
    };
  }
}

// Export singleton instance
export const config = new Config();
