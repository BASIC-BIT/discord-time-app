import { EnvConfig } from './types';

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

    console.log('Configuration validated successfully');
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
      STATIC_API_KEY: this.config.STATIC_API_KEY.slice(0, 6) + '...',
      PORT: this.config.PORT,
      DB_PATH: this.config.DB_PATH
    };
  }
}

// Export singleton instance
export const config = new Config();
