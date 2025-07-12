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
    return {
      OPENAI_API_KEY: this.getEnvVar('OPENAI_API_KEY'),
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

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    // Validate OpenAI API key format
    if (!this.config.OPENAI_API_KEY.startsWith('sk-')) {
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
  public get openaiApiKey(): string {
    return this.config.OPENAI_API_KEY;
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
      OPENAI_API_KEY: this.config.OPENAI_API_KEY.slice(0, 7) + '...',
      STATIC_API_KEY: this.config.STATIC_API_KEY.slice(0, 6) + '...',
      PORT: this.config.PORT,
      DB_PATH: this.config.DB_PATH
    };
  }
}

// Export singleton instance
export const config = new Config(); 