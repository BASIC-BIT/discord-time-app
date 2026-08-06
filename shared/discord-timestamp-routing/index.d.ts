export const DISCORD_TIMESTAMP_CLASSIFIER_VERSION: "discord-reference-v2";
export const DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS: 253402300799;
export const DISCORD_TIMESTAMP_MAX_INPUT_CHARS: 16384;
export const DISCORD_TIMESTAMP_MAX_MODEL_CHARS: 4096;

export type DiscordTimestampRoute =
  | "no_reference"
  | "direct_instant"
  | "direct_range"
  | "copied_prose"
  | "model"
  | "clarify"
  | "reject";

export type DiscordTimestampRouteReason =
  | "no_timestamp_reference"
  | "standalone_timestamp"
  | "standalone_wrapped_timestamp"
  | "exact_timestamp_range"
  | "invalid_timestamp_range"
  | "affirmative_presentation_prose"
  | "semantic_residue_requires_model"
  | "multiple_timestamps_without_relationship"
  | "unsupported_comparison"
  | "unsupported_scheduling"
  | "unsupported_timezone_presentation"
  | "negated_or_corrected_reference"
  | "conditional_or_uncertain_reference"
  | "ambiguous_code_or_url_context"
  | "malformed_timestamp_syntax"
  | "input_too_long"
  | "model_input_too_long";

export type DiscordTimestampContextClass =
  | "plain"
  | "quoted"
  | "inline_code"
  | "fenced_code"
  | "url";

export interface DiscordTimestampReference {
  raw: string;
  start: number;
  end: number;
  epochSeconds: number;
  formatCode: ":d" | ":D" | ":t" | ":T" | ":f" | ":F" | ":R";
  formatIndex: number;
  contextClass: DiscordTimestampContextClass;
}

export interface DiscordTimestampClassification {
  version: typeof DISCORD_TIMESTAMP_CLASSIFIER_VERSION;
  route: DiscordTimestampRoute;
  reason: DiscordTimestampRouteReason;
  references: DiscordTimestampReference[];
  malformedCount: number;
  contextClass: DiscordTimestampContextClass;
  signals: string[];
  inputLength: number;
  inputLengthBucket: "0-64" | "65-256" | "257-1024" | "1025-4096" | "4097-16384" | "over-16384";
  modelEligible: boolean;
  meaningfulResidue: boolean;
}

export interface DiscordTimestampClassifierOptions {
  maxInputChars?: number;
  maxModelChars?: number;
}

export function classifyDiscordTimestampInput(
  text: string,
  options?: DiscordTimestampClassifierOptions,
): DiscordTimestampClassification;

export function discordTimestampFormatIndex(formatCode: string | undefined): number;
export function discordTimestampFormatCode(formatIndex: number): DiscordTimestampReference["formatCode"];
